import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);
const serverEntry = fileURLToPath(new URL("../src/index.js", import.meta.url));

async function withServer(fn) {
  const transport = new StdioClientTransport({ command: "node", args: [serverEntry] });
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

test("delegate_doctor reports git repo present and opencode server reachable", async () => {
  await withTempGitRepo(async (repoRoot) => {
    await withServer(async (client) => {
      const report = jsonResult(
        await client.callTool({ name: "delegate_doctor", arguments: { repoRoot } })
      );
      assert.equal(report.gitRepo, true);
      assert.equal(report.opencodeServer.reachable, true);
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

after(async () => {
  // The delegate_doctor calls above start a real (shared, module-singleton) opencode serve
  // process inside each spawned server subprocess; those subprocesses exit on their own when
  // the client closes the stdio transport, so there's nothing further to tear down here.
});
