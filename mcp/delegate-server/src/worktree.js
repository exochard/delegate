import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { resolveWorker } from "./worker.js";

const execFileAsync = promisify(execFile);

const MAX_DIFF_CHARS = 50_000;
const MAX_COMMIT_SUBJECT_CHARS = 72;

// Task text is arbitrary user input: raw newlines would break `git commit -m`'s single
// argument and a wall of text makes `git log` useless.
export function mergeCommitMessage(task) {
  const prefix = "delegate: ";
  const budget = MAX_COMMIT_SUBJECT_CHARS - prefix.length;
  const firstLine = String(task).split("\n", 1)[0].trim();
  const subject = firstLine.length > budget ? `${firstLine.slice(0, budget - 1)}…` : firstLine;
  return prefix + subject;
}

// Excludes the active worker's own bookkeeping file from every diff/stat/commit pathspec —
// it configures the worker's permissions, it's not part of the task's own change. Resolved
// per call from the worker actually in use: baking it in at module load from the DEFAULT
// worker breaks the exclusion the moment a different driver is configured.
function excludeWorkerConfig(worker) {
  return `:!${worker.WORKER_CONFIG_FILENAME}`;
}

async function git(cwd, args) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 1024 * 1024 * 32 });
    return stdout;
  } catch (err) {
    const detail = err.stderr || err.message;
    throw new Error(`git ${args.join(" ")} (in ${cwd}) failed: ${detail}`);
  }
}

export function branchName(sessionId) {
  return `delegate/${sessionId}`;
}

export function worktreesRoot(repoRoot) {
  const repoName = path.basename(repoRoot);
  return path.join(path.dirname(repoRoot), ".delegate-worktrees", repoName);
}

export function worktreePath(repoRoot, sessionId) {
  return path.join(worktreesRoot(repoRoot), sessionId);
}

export async function assertGitRepo(repoRoot) {
  try {
    await git(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    throw new Error(`${repoRoot} is not a git repository — run "git init" there first.`);
  }
}

export async function createWorktree(repoRoot, sessionId) {
  await assertGitRepo(repoRoot);
  const root = worktreesRoot(repoRoot);
  await mkdir(root, { recursive: true });
  const wtPath = worktreePath(repoRoot, sessionId);
  const branch = branchName(sessionId);
  await git(repoRoot, ["worktree", "add", "-b", branch, wtPath]);
  return { worktreePath: wtPath, branchName: branch };
}

async function hasUncommittedChanges(worktreePath, worker) {
  const status = await git(worktreePath, ["status", "--porcelain", "--", ".", excludeWorkerConfig(worker)]);
  return status.trim().length > 0;
}

async function commitPendingChanges(worktreePath, message, worker) {
  if (!(await hasUncommittedChanges(worktreePath, worker))) return false;
  await git(worktreePath, ["add", "-A", "--", ".", excludeWorkerConfig(worker)]);
  await git(worktreePath, ["commit", "-m", message]);
  return true;
}

export async function getWorktreeDiff(worktreePath, worker = resolveWorker()) {
  // --intent-to-add marks untracked files so they show up in `git diff HEAD`
  // as new-file diffs, without actually staging their content.
  await git(worktreePath, ["add", "-A", "-N", "--", ".", excludeWorkerConfig(worker)]);
  const stat = await git(worktreePath, ["diff", "HEAD", "--stat", "--", ".", excludeWorkerConfig(worker)]);
  let patch = await git(worktreePath, ["diff", "HEAD", "--", ".", excludeWorkerConfig(worker)]);
  let truncated = false;
  if (patch.length > MAX_DIFF_CHARS) {
    patch = `${patch.slice(0, MAX_DIFF_CHARS)}\n...[diff truncated, ${patch.length} chars total]`;
    truncated = true;
  }
  return { stat: stat.trim(), patch, truncated };
}

export async function mergeWorktree(repoRoot, session, worker = resolveWorker()) {
  const message = mergeCommitMessage(session.task);
  await commitPendingChanges(session.worktreePath, message, worker);
  await git(repoRoot, ["merge", "--no-ff", session.branchName, "-m", message]);
  await git(repoRoot, ["worktree", "remove", session.worktreePath, "--force"]);
  await git(repoRoot, ["branch", "-d", session.branchName]);
}

export async function rejectWorktree(repoRoot, session) {
  await git(repoRoot, ["worktree", "remove", session.worktreePath, "--force"]);
  await git(repoRoot, ["branch", "-D", session.branchName]);
}

export async function listWorktrees(repoRoot) {
  const raw = await git(repoRoot, ["worktree", "list", "--porcelain"]);
  const entries = [];
  let current = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length);
    }
  }
  if (current) entries.push(current);
  return entries;
}
