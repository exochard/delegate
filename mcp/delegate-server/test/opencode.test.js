import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseModel,
  permissionConfigFromWorkerPermissions,
  writeWorkerConfig,
  buildRunArgs,
  run,
  exportSession,
  abortRun,
  checkInstalled,
  runFailureMessage,
  extractExportJson,
  WORKER_CONFIG_FILENAME,
} from "../src/opencode.js";
import { DEFAULT_MODEL } from "../src/config.js";

const execFileAsync = promisify(execFile);
const FREE_MODEL = DEFAULT_MODEL;

// Anything that actually spawns `opencode run` hits a live model, so it only runs on demand.
const e2eOnly = process.env.DELEGATE_E2E === "1" ? false : "set DELEGATE_E2E=1 to run (needs opencode and network)";

async function withTempGitRepo(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "delegate-oc-test-"));
  await execFileAsync("git", ["init", "-b", "main", dir]);
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Delegate Test"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), "hello\n");
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "initial commit"], { cwd: dir });
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("parseModel splits provider/model", () => {
  assert.deepEqual(parseModel("deepseek/deepseek-coder"), {
    providerID: "deepseek",
    id: "deepseek-coder",
  });
});

test("parseModel keeps extra slashes in the model id", () => {
  assert.deepEqual(parseModel("openrouter/some/nested-model"), {
    providerID: "openrouter",
    id: "some/nested-model",
  });
});

test("parseModel returns null for falsy input", () => {
  assert.equal(parseModel(undefined), null);
  assert.equal(parseModel(""), null);
});

test("parseModel throws when there's no slash", () => {
  assert.throws(() => parseModel("not-a-provider-model"), /provider\/model/);
});

test("permissionConfigFromWorkerPermissions maps booleans to allow/deny", () => {
  assert.deepEqual(permissionConfigFromWorkerPermissions({ bash: true, webfetch: false }), {
    bash: "allow",
    webfetch: "deny",
  });
});

test("permissionConfigFromWorkerPermissions handles an empty/missing config", () => {
  assert.deepEqual(permissionConfigFromWorkerPermissions(), {});
  assert.deepEqual(permissionConfigFromWorkerPermissions({}), {});
});

test("buildRunArgs with only a directory: --pure isolation, no -s/-m/-f flags, message still terminated by --", () => {
  assert.deepEqual(buildRunArgs({ directory: "/repo" }), [
    "run",
    "--pure",
    "--dir",
    "/repo",
    "--format",
    "json",
    "--",
    "Follow the instructions in the attached task file.",
  ]);
});

test("buildRunArgs with sessionId, model, and taskFilePath: flags precede the -- terminator", () => {
  assert.deepEqual(
    buildRunArgs({ directory: "/repo", sessionId: "ses_123", model: FREE_MODEL, taskFilePath: "/repo/task.md" }),
    [
      "run",
      "--pure",
      "--dir",
      "/repo",
      "--format",
      "json",
      "-s",
      "ses_123",
      "-m",
      FREE_MODEL,
      "-f",
      "/repo/task.md",
      "--",
      "Follow the instructions in the attached task file.",
    ]
  );
});

test("buildRunArgs always terminates with -- before the positional message, so opencode never mistakes it for a filename", () => {
  const args = buildRunArgs({ directory: "/repo", taskFilePath: "/repo/task.md" });
  const dashDashIndex = args.indexOf("--");
  assert.notEqual(dashDashIndex, -1);
  assert.equal(args[dashDashIndex + 1], "Follow the instructions in the attached task file.");
  assert.equal(args.length, dashDashIndex + 2, "-- and the message must be the final two args");
});

test("writeWorkerConfig writes an opencode project config with the mapped permission set", async () => {
  await withTempGitRepo(async (dir) => {
    await writeWorkerConfig({ directory: dir, workerPermissions: { bash: true, webfetch: false }, repoRoot: "/mainrepo" });
    const raw = await readFile(path.join(dir, WORKER_CONFIG_FILENAME), "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.$schema, "https://opencode.ai/config.json");
    assert.deepEqual(parsed.permission, {
      bash: "allow",
      webfetch: "deny",
      // The task/report handoff files live in the main repo, outside the worktree; without
      // this scoped rule opencode auto-rejects every access to them (observed e2e: exit 0,
      // empty diff, round silently did nothing).
      external_directory: { "/mainrepo/**": "allow" },
    });
    // No mcp key on purpose: an explicit "mcp": {} does NOT stop opencode deep-merging the
    // user's global/plugin MCP servers into the worker (verified against opencode 1.18.29 —
    // resolved config still listed every inherited server). Isolation comes from the
    // --pure flag in buildRunArgs, not from this file.
    assert.ok(!("mcp" in parsed));
  });
});

test("runFailureMessage distinguishes our timeout from an explicit abort and external kills", () => {
  const base = { exitCode: null, signal: "SIGTERM", stderr: "" };
  assert.equal(
    runFailureMessage({ ...base, timedOut: true, aborted: false }),
    "opencode run timed out and was killed"
  );
  assert.equal(
    runFailureMessage({ ...base, timedOut: false, aborted: true }),
    "opencode run was stopped"
  );
  assert.equal(
    runFailureMessage({ exitCode: null, signal: "SIGKILL", timedOut: false, aborted: false, stderr: "" }),
    "opencode run was terminated by signal SIGKILL"
  );
  assert.equal(
    runFailureMessage({ exitCode: 2, signal: null, timedOut: false, aborted: false, stderr: "boom" }),
    "opencode run failed (exit 2): boom"
  );
  assert.equal(
    runFailureMessage({ exitCode: 1, signal: null, timedOut: false, aborted: false, stderr: "  " }),
    "opencode run failed (exit 1): no stderr output"
  );
});

test("extractExportJson finds the JSON body past preamble and stray brace log lines", () => {
  const body = JSON.stringify({ info: { cost: 0.01, tokens: { input: 10 } } }, null, 2);
  // Preamble on stdout (TTY behavior), as today.
  assert.deepEqual(extractExportJson(`Exporting session: ses_abc\n${body}`).info.cost, 0.01);
  // No preamble at all.
  assert.deepEqual(extractExportJson(body).info.tokens.input, 10);
  // A log line containing a brace before the body must not hijack the parse.
  assert.deepEqual(
    extractExportJson(`warning: failed {something}\n${body}`).info.cost,
    0.01
  );
  assert.throws(() => extractExportJson("no json here"), /without a JSON body/);
});

test("checkInstalled reports the installed opencode version", async () => {
  const result = await checkInstalled();
  assert.equal(result.installed, true);
  assert.match(result.version, /^\d+\.\d+\.\d+/);
});

test(
  "run executes a real one-shot task and returns a session id plus the reply",
  { skip: e2eOnly, timeout: 60_000 },
  async () => {
    await withTempGitRepo(async (dir) => {
      const result = await run({ directory: dir, model: FREE_MODEL });
      assert.match(result.sessionId, /^ses_/);
      assert.equal(typeof result.message, "string");
    });
  }
);

test(
  "run continues the same session when given its sessionId",
  { skip: e2eOnly, timeout: 60_000 },
  async () => {
    await withTempGitRepo(async (dir) => {
      const first = await run({ directory: dir, model: FREE_MODEL });
      const second = await run({ directory: dir, sessionId: first.sessionId, model: FREE_MODEL });
      assert.equal(second.sessionId, first.sessionId);
    });
  }
);

test("exportSession returns cost/tokens for a real session", { skip: e2eOnly, timeout: 60_000 }, async () => {
  await withTempGitRepo(async (dir) => {
    const { sessionId } = await run({ directory: dir, model: FREE_MODEL });
    const { cost, tokens } = await exportSession({ directory: dir, sessionId });
    assert.equal(typeof cost, "number");
    assert.equal(typeof tokens.input, "number");
  });
});

test("run killed by our own timer reports a timeout, not a generic stop", { timeout: 30_000 }, async () => {
  await withTempGitRepo(async (dir) => {
    // A 50ms timer fires long before opencode finishes (or even starts) a run, so the
    // SIGTERM is ours — this must be reported as a timeout without needing any model.
    await assert.rejects(
      run({ directory: dir, timeoutMs: 50 }),
      /opencode run timed out and was killed/
    );
  });
});

test("abortRun returns false when no run is in flight for that delegate session id", () => {
  assert.equal(abortRun("dlg_not_running"), false);
});

test("abortRun stops an in-flight run, which then rejects", { skip: e2eOnly, timeout: 30_000 }, async () => {
  await withTempGitRepo(async (dir) => {
    const delegateSessionId = "dlg_abort_test";
    const runPromise = run({ directory: dir, model: FREE_MODEL, delegateSessionId });
    // Give the child a moment to actually spawn before trying to kill it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stopped = abortRun(delegateSessionId);
    assert.equal(stopped, true);
    await assert.rejects(runPromise, /opencode run was stopped/);
  });
});
