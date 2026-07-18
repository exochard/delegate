import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { WORKER_CONFIG_FILENAME as FAKE_CONFIG_FILENAME, OUTPUT_FILENAME } from "./helpers/fake-worker.js";

const execFileAsync = promisify(execFile);
const serverEntry = fileURLToPath(new URL("../src/index.js", import.meta.url));
const fakeWorkerPath = fileURLToPath(new URL("./helpers/fake-worker.js", import.meta.url));

// Everything but the E2E test below runs against the fake driver: no network, no worker
// child process. Set DELEGATE_E2E=1 to also run the one test that drives real opencode.
const E2E = process.env.DELEGATE_E2E === "1";
const FREE_MODEL = "opencode/deepseek-v4-flash-free";

/** Starts the MCP server as a subprocess. Injects the fake worker driver unless `real` is set. */
async function withServer(fn, { real = false } = {}) {
  const env = { ...process.env };
  if (real) delete env.DELEGATE_WORKER_MODULE;
  else env.DELEGATE_WORKER_MODULE = fakeWorkerPath;

  const transport = new StdioClientTransport({ command: "node", args: [serverEntry], env });
  const client = new Client({ name: "delegate-test-client", version: "0.0.1" });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

async function withTempGitRepo(fn) {
  const parent = await mkdtemp(path.join(tmpdir(), "delegate-index-test-"));
  const repoRoot = path.join(parent, "repo");
  await execFileAsync("git", ["init", "-b", "main", repoRoot]);
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
  await execFileAsync("git", ["config", "user.name", "Delegate Test"], { cwd: repoRoot });
  await writeFile(path.join(repoRoot, "README.md"), "hello\n");
  await execFileAsync("git", ["add", "-A"], { cwd: repoRoot });
  await execFileAsync("git", ["commit", "-m", "initial commit"], { cwd: repoRoot });
  try {
    await fn(repoRoot);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

function jsonResult(result) {
  return JSON.parse(result.content[0].text);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test("MCP server registers all delegate tools", async () => {
  await withServer(async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "delegate_accept",
      "delegate_config_get",
      "delegate_config_set",
      "delegate_diff",
      "delegate_doctor",
      "delegate_feedback",
      "delegate_reject",
      "delegate_review",
      "delegate_start",
      "delegate_status",
      "delegate_stop",
    ]);
  });
});

test("delegate_config_get returns defaults, delegate_config_set persists a patch", async () => {
  await withTempGitRepo(async (repoRoot) => {
    await withServer(async (client) => {
      const before = jsonResult(
        await client.callTool({ name: "delegate_config_get", arguments: { repoRoot } })
      );
      assert.equal(before.maxIterations, 3);
      assert.equal(before.defaultModel, null);
      assert.equal(before.worker, "opencode");
      assert.equal(before.workerPermissions.webfetch, false);

      const after = jsonResult(
        await client.callTool({
          name: "delegate_config_set",
          arguments: { repoRoot, maxIterations: 5, workerPermissions: { webfetch: true } },
        })
      );
      assert.equal(after.maxIterations, 5);
      assert.equal(after.workerPermissions.webfetch, true);
      assert.equal(after.workerPermissions.bash, true, "unrelated permissions should be preserved");

      const reread = jsonResult(
        await client.callTool({ name: "delegate_config_get", arguments: { repoRoot } })
      );
      assert.equal(reread.maxIterations, 5);
    });
  });
});

test("delegate_config_set rejects an unknown worker name and lists the available drivers", async () => {
  await withTempGitRepo(async (repoRoot) => {
    await withServer(async (client) => {
      const result = await client.callTool({
        name: "delegate_config_set",
        arguments: { repoRoot, worker: "not-a-worker" },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Unknown worker "not-a-worker"/);
      assert.match(result.content[0].text, /Available workers: opencode/);

      const reread = jsonResult(
        await client.callTool({ name: "delegate_config_get", arguments: { repoRoot } })
      );
      assert.equal(reread.worker, "opencode", "a rejected patch must not be persisted");
    });
  });
});

test("delegate_status with no id lists sessions (empty for a fresh repo)", async () => {
  await withTempGitRepo(async (repoRoot) => {
    await withServer(async (client) => {
      const sessions = jsonResult(
        await client.callTool({ name: "delegate_status", arguments: { repoRoot } })
      );
      assert.deepEqual(sessions, []);
    });
  });
});

test("delegate_status with an unknown id reports an error instead of throwing", async () => {
  await withTempGitRepo(async (repoRoot) => {
    await withServer(async (client) => {
      const result = await client.callTool({
        name: "delegate_status",
        arguments: { repoRoot, id: "dlg_doesnotexist" },
      });
      assert.equal(result.isError, true);
    });
  });
});

test("delegate_doctor reports the git repo, the active worker, and that worker's install check", async () => {
  await withTempGitRepo(async (repoRoot) => {
    await withServer(async (client) => {
      const report = jsonResult(
        await client.callTool({ name: "delegate_doctor", arguments: { repoRoot } })
      );
      assert.equal(report.gitRepo, true);
      assert.equal(report.worker, "opencode");
      assert.equal(report.opencode.installed, true);
      assert.equal(report.opencode.version, "0.0.0-fake", "the install check should come from the injected driver");
      assert.equal(report.activeSessions, 0);
      assert.deepEqual(report.orphanedWorktrees, []);
    });
  });
});

test("delegate_start rolls back the worktree and state on a mid-creation failure", async () => {
  await withTempGitRepo(async (repoRoot) => {
    await withServer(async (client) => {
      const result = await client.callTool({
        name: "delegate_start",
        arguments: { repoRoot, task: "irrelevant", model: "not-a-provider-model" },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /rolled back/);

      const sessions = jsonResult(
        await client.callTool({ name: "delegate_status", arguments: { repoRoot } })
      );
      assert.deepEqual(sessions, []);

      const doctor = jsonResult(
        await client.callTool({ name: "delegate_doctor", arguments: { repoRoot } })
      );
      assert.deepEqual(doctor.orphanedWorktrees, []);
    });
  });
});

test("delegate_doctor reports gitRepo=false for a non-git directory", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "delegate-not-git-"));
  try {
    await withServer(async (client) => {
      const report = jsonResult(
        await client.callTool({ name: "delegate_doctor", arguments: { repoRoot: dir } })
      );
      assert.equal(report.gitRepo, false);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("delegate_start runs a round, writes the task/report files, and diffs the worker's changes", async () => {
  await withTempGitRepo(async (repoRoot) => {
    await withServer(async (client) => {
      const result = await client.callTool({
        name: "delegate_start",
        arguments: { repoRoot, task: "Write the output file", field: "backend", model: "fake/model" },
      });
      assert.equal(result.isError, undefined);
      const { session, report, diff, verification } = jsonResult(result);

      assert.equal(session.field, "backend");
      assert.match(session.opencodeSessionId, /^ses_/);
      assert.equal(session.iteration, 1);
      assert.equal(session.status, "ready-to-accept", "nothing to verify in a bare repo, so a completed round is ready-to-accept");
      assert.equal(verification.allPassed, null);

      // Cost/token bookkeeping comes back from the driver's exportSession.
      assert.equal(session.cost, 0.0025);
      assert.equal(session.tokens.input, 100);

      assert.ok(await exists(session.taskFile), "task file should exist");
      assert.ok(await exists(report.path), "report file should exist");

      const taskContent = await readFile(session.taskFile, "utf8");
      assert.match(taskContent, /Write the output file/);

      const reportContent = await readFile(report.path, "utf8");
      assert.match(reportContent, /Verification — round 1/);
      assert.match(reportContent, /## Worker report/);
      assert.equal(report.workerReportMissing, false);

      // The worker's file shows up in the diff; delegate's own worker-config file does not.
      assert.match(diff.patch, new RegExp(OUTPUT_FILENAME));
      assert.doesNotMatch(diff.patch, new RegExp(FAKE_CONFIG_FILENAME));
      assert.doesNotMatch(diff.stat, new RegExp(FAKE_CONFIG_FILENAME));

      // The worker config was still written into the worktree — it's just excluded from the diff.
      assert.ok(await exists(path.join(session.worktreePath, FAKE_CONFIG_FILENAME)));

      // delegate_feedback continues the same worker session and appends a new task-file section.
      const feedbackJson = jsonResult(
        await client.callTool({
          name: "delegate_feedback",
          arguments: { repoRoot, id: session.id, message: "Also mention the follow-up" },
        })
      );
      assert.equal(feedbackJson.session.opencodeSessionId, session.opencodeSessionId, "feedback should continue the same worker session");
      assert.equal(feedbackJson.session.iteration, 2);

      const taskContentAfterFeedback = await readFile(session.taskFile, "utf8");
      assert.match(taskContentAfterFeedback, /Write the output file/, "round 1 instructions should still be present");
      assert.match(taskContentAfterFeedback, /Feedback — round 2/);

      // Nothing is in flight once the round above has resolved.
      const stopResult = jsonResult(
        await client.callTool({ name: "delegate_stop", arguments: { repoRoot, id: session.id } })
      );
      assert.equal(stopResult.stopped, false);

      // Clean up the worktree/branch this test created.
      await client.callTool({ name: "delegate_reject", arguments: { repoRoot, id: session.id } });
      const afterReject = jsonResult(
        await client.callTool({ name: "delegate_status", arguments: { repoRoot } })
      );
      assert.deepEqual(afterReject, []);
    });
  });
});

test(
  "delegate_start and delegate_feedback drive a real opencode round",
  { skip: E2E ? false : "set DELEGATE_E2E=1 to run (needs opencode and network)", timeout: 180_000 },
  async () => {
    await withTempGitRepo(async (repoRoot) => {
      await withServer(
        async (client) => {
          const result = await client.callTool(
            {
              name: "delegate_start",
              arguments: { repoRoot, task: "Create a file called ok.txt containing the word done", field: "backend", model: FREE_MODEL },
            },
            undefined,
            { timeout: 90_000 }
          );
          assert.equal(result.isError, undefined);
          const { session, report } = jsonResult(result);

          assert.match(session.opencodeSessionId, /^ses_/);
          assert.ok(await exists(session.taskFile), "task file should exist");
          assert.ok(await exists(report.path), "report file should exist even if the worker skipped it");

          const feedbackJson = jsonResult(
            await client.callTool(
              { name: "delegate_feedback", arguments: { repoRoot, id: session.id, message: "Also create a second file called done.txt" } },
              undefined,
              { timeout: 90_000 }
            )
          );
          assert.equal(feedbackJson.session.opencodeSessionId, session.opencodeSessionId, "feedback should continue the same opencode session");
          assert.equal(feedbackJson.session.iteration, 2);

          await client.callTool({ name: "delegate_reject", arguments: { repoRoot, id: session.id } });
        },
        { real: true }
      );
    });
  }
);
