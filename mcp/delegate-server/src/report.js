import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";

const MAX_SLUG_LEN = 48;
const MAX_EXCERPT_CHARS = 4000;

function slugify(text) {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/g, "");
  return base || "task";
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function fieldDir(repoRoot, field) {
  return path.join(repoRoot, ".delegate", field);
}

export function taskFilePath(repoRoot, field, slug) {
  return path.join(fieldDir(repoRoot, field), `${slug}.md`);
}

export function reportFilePath(repoRoot, field, slug) {
  return path.join(fieldDir(repoRoot, field), `${slug}-report.md`);
}

/** Picks a filesystem-safe, human-readable slug for `task` under `field`, suffixing with a short id on collision. */
export async function chooseSlug(repoRoot, field, task, sessionId) {
  const base = slugify(task);
  if (!(await exists(taskFilePath(repoRoot, field, base)))) return base;
  return `${base}-${sessionId.replace(/^dlg_/, "").slice(0, 6)}`;
}

/** Writes the initial task file for round 1, including the report-file contract the worker is asked to follow. */
export async function writeInitialTaskFile({ repoRoot, field, slug, task }) {
  const dir = fieldDir(repoRoot, field);
  await mkdir(dir, { recursive: true });
  const reportPath = reportFilePath(repoRoot, field, slug);
  const content = `# Task: ${slug}

${task}

---

When you're done, append a short account of what you did — and anything worth flagging — to:

    ${reportPath}

Add a "## Worker report" section. If that file already has content from an earlier round,
append below it; don't overwrite what's there.
`;
  await writeFile(taskFilePath(repoRoot, field, slug), content);
  return { taskPath: taskFilePath(repoRoot, field, slug), reportPath };
}

/** Appends a new feedback instruction to an existing task file for a later round. */
export async function appendFeedbackSection({ repoRoot, field, slug, round, message }) {
  const filePath = taskFilePath(repoRoot, field, slug);
  const existing = await readFile(filePath, "utf8").catch(() => "");
  const section = `\n---\n\n## Feedback — round ${round}\n\n${message}\n`;
  await writeFile(filePath, existing + section);
  return filePath;
}

/** Snapshots the report file's current content (empty string if it doesn't exist yet) — call before invoking the worker. */
export async function snapshotReport({ repoRoot, field, slug }) {
  return readFile(reportFilePath(repoRoot, field, slug), "utf8").catch(() => "");
}

function truncate(text, max = MAX_EXCERPT_CHARS) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[truncated, ${text.length} chars total]`;
}

function summarizeVerificationForReport(verification) {
  if (verification.commandsRun === 0) {
    return verification.note ?? "No verify command configured and none auto-detected.";
  }
  return verification.results
    .map((r) => `- \`${r.name}\` — exit ${r.exitCode}${r.timedOut ? " (timed out)" : ""}`)
    .join("\n");
}

/**
 * Compares the report file against a pre-round snapshot to detect whether the worker wrote
 * anything, then appends delegate's own verification section — so the report always reflects
 * the round's outcome even if the worker never touched the file.
 */
export async function finalizeReportRound({ repoRoot, field, slug, round, baseline, verification }) {
  const filePath = reportFilePath(repoRoot, field, slug);
  const current = await readFile(filePath, "utf8").catch(() => "");

  const workerWrote = current !== baseline && current.trim().length > 0;
  const workerExcerpt = workerWrote
    ? truncate(current.startsWith(baseline) ? current.slice(baseline.length).trim() : current.trim())
    : null;

  const header = current.length === 0 ? `# Report: ${slug}\n` : "";
  const verificationSection = `\n---\n\n## Verification — round ${round}\n\nResult: ${
    verification.allPassed === null ? "not checked (nothing to verify)" : verification.allPassed ? "passed" : "failed"
  }\n\n${summarizeVerificationForReport(verification)}\n`;

  await mkdir(fieldDir(repoRoot, field), { recursive: true });
  await writeFile(filePath, header + current + verificationSection);

  return {
    reportPath: filePath,
    workerReportMissing: !workerWrote,
    workerExcerpt,
  };
}
