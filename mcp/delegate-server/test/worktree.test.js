import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createWorktree,
  getWorktreeDiff,
  mergeWorktree,
  rejectWorktree,
  listWorktrees,
  branchName,
  worktreePath,
  assertGitRepo,
} from "../src/worktree.js";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function withTempGitRepo(fn) {
  const parent = await mkdtemp(path.join(tmpdir(), "delegate-wt-test-"));
  const repoRoot = path.join(parent, "repo");
  await execFileAsync("git", ["init", "-b", "main", repoRoot]);
  await git(repoRoot, ["config", "user.email", "test@example.com"]);
  await git(repoRoot, ["config", "user.name", "Delegate Test"]);
  await writeFile(path.join(repoRoot, "README.md"), "hello\n");
  await git(repoRoot, ["add", "-A"]);
  await git(repoRoot, ["commit", "-m", "initial commit"]);
  try {
    await fn(repoRoot, parent);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

test("assertGitRepo rejects a non-git directory", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "delegate-not-git-"));
  try {
    await assert.rejects(() => assertGitRepo(dir), /not a git repository/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createWorktree creates a sibling worktree on a new branch", async () => {
  await withTempGitRepo(async (repoRoot) => {
    const sessionId = "dlg_test0001aaaa";
    const result = await createWorktree(repoRoot, sessionId);

    assert.equal(result.branchName, branchName(sessionId));
    assert.equal(result.worktreePath, worktreePath(repoRoot, sessionId));

    const readme = await readFile(path.join(result.worktreePath, "README.md"), "utf8");
    assert.equal(readme, "hello\n");

    const worktrees = await listWorktrees(repoRoot);
    assert.ok(worktrees.some((w) => w.path === result.worktreePath));
  });
});

test("getWorktreeDiff reports uncommitted changes in the worktree", async () => {
  await withTempGitRepo(async (repoRoot) => {
    const sessionId = "dlg_test0002bbbb";
    const { worktreePath: wtPath } = await createWorktree(repoRoot, sessionId);

    await writeFile(path.join(wtPath, "foo.txt"), "new file from worker\n");

    const diff = await getWorktreeDiff(wtPath);
    assert.match(diff.stat, /foo\.txt/);
    assert.match(diff.patch, /new file from worker/);
    assert.equal(diff.truncated, false);
  });
});

test("mergeWorktree commits pending changes, merges into main, and cleans up", async () => {
  await withTempGitRepo(async (repoRoot) => {
    const sessionId = "dlg_test0003cccc";
    const { worktreePath: wtPath, branchName: branch } = await createWorktree(repoRoot, sessionId);
    await writeFile(path.join(wtPath, "feature.txt"), "worker output\n");

    const session = { worktreePath: wtPath, branchName: branch, task: "add feature.txt" };
    await mergeWorktree(repoRoot, session);

    const merged = await readFile(path.join(repoRoot, "feature.txt"), "utf8");
    assert.equal(merged, "worker output\n");

    const branches = await git(repoRoot, ["branch", "--list", branch]);
    assert.equal(branches.trim(), "");

    const worktrees = await listWorktrees(repoRoot);
    assert.ok(!worktrees.some((w) => w.path === wtPath));
  });
});

test("rejectWorktree discards the worktree and branch without touching main", async () => {
  await withTempGitRepo(async (repoRoot) => {
    const sessionId = "dlg_test0004dddd";
    const { worktreePath: wtPath, branchName: branch } = await createWorktree(repoRoot, sessionId);
    await writeFile(path.join(wtPath, "should-not-land.txt"), "discard me\n");

    const session = { worktreePath: wtPath, branchName: branch };
    await rejectWorktree(repoRoot, session);

    const branches = await git(repoRoot, ["branch", "--list", branch]);
    assert.equal(branches.trim(), "");

    await assert.rejects(() => readFile(path.join(repoRoot, "should-not-land.txt"), "utf8"));

    const worktrees = await listWorktrees(repoRoot);
    assert.ok(!worktrees.some((w) => w.path === wtPath));
  });
});
