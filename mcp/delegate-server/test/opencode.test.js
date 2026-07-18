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
  run,
  exportSession,
  abortRun,
  checkInstalled,
  WORKER_CONFIG_FILENAME,
} from "../src/opencode.js";

const execFileAsync = promisify(execFile);
const FREE_MODEL = "opencode/deepseek-v4-flash-free";

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

test("writeWorkerConfig writes an opencode project config with the mapped permission set", async () => {
  await withTempGitRepo(async (dir) => {
    await writeWorkerConfig({ directory: dir, workerPermissions: { bash: true, webfetch: false } });
    const raw = await readFile(path.join(dir, WORKER_CONFIG_FILENAME), "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.$schema, "https://opencode.ai/config.json");
    assert.deepEqual(parsed.permission, { bash: "allow", webfetch: "deny" });
  });
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
