import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

const MAX_DIFF_CHARS = 50_000;

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

async function hasUncommittedChanges(worktreePath) {
  const status = await git(worktreePath, ["status", "--porcelain"]);
  return status.trim().length > 0;
}

async function commitPendingChanges(worktreePath, message) {
  if (!(await hasUncommittedChanges(worktreePath))) return false;
  await git(worktreePath, ["add", "-A"]);
  await git(worktreePath, ["commit", "-m", message]);
  return true;
}

export async function getWorktreeDiff(worktreePath) {
  // --intent-to-add marks untracked files so they show up in `git diff HEAD`
  // as new-file diffs, without actually staging their content.
  await git(worktreePath, ["add", "-A", "-N"]);
  const stat = await git(worktreePath, ["diff", "HEAD", "--stat"]);
  let patch = await git(worktreePath, ["diff", "HEAD"]);
  let truncated = false;
  if (patch.length > MAX_DIFF_CHARS) {
    patch = `${patch.slice(0, MAX_DIFF_CHARS)}\n...[diff truncated, ${patch.length} chars total]`;
    truncated = true;
  }
  return { stat: stat.trim(), patch, truncated };
}

export async function mergeWorktree(repoRoot, session) {
  await commitPendingChanges(session.worktreePath, `delegate: ${session.task}`);
  await git(repoRoot, ["merge", "--no-ff", session.branchName, "-m", `delegate: ${session.task}`]);
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
