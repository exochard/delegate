import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const STATUSES = [
  "running",
  "ready-to-accept",
  "needs-human",
  "accepted",
  "rejected",
  "failed",
];

// Sessions gain fields over time (e.g. delegate_stop's abortedAt), so unknown keys are
// kept, not rejected — the schema guards against corruption, not against evolution.
// tokens is written straight from the worker driver's exportSession, whose shape varies
// by driver, so it's validated loosely.
const SessionSchema = z
  .object({
    id: z.string().min(1),
    task: z.string(),
    field: z.string(),
    taskFile: z.string().nullable(),
    reportFile: z.string().nullable(),
    worktreePath: z.string(),
    branchName: z.string(),
    opencodeSessionId: z.string().nullable(),
    model: z.string().nullable(),
    status: z.enum(STATUSES),
    iteration: z.number().int().nonnegative(),
    maxIterations: z.number().int().positive(),
    createdAt: z.string(),
    updatedAt: z.string(),
    cost: z.number(),
    tokens: z.object({}).passthrough(),
    lastVerification: z.unknown().nullable(),
  })
  .passthrough();

/** Parses and validates one session state file. Corrupt state must fail named and loudly here, not surfaces as a JSON.parse surprise deep in a tool handler. */
function parseSessionJson(raw, filePath) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Corrupt delegate session state at ${filePath} (invalid JSON: ${err.message}). Delete the file or restore it from git.`);
  }
  const result = SessionSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Corrupt delegate session state at ${filePath} (${issues}). Delete the file or restore it from git.`);
  }
  return result.data;
}

export function stateDir(repoRoot) {
  return path.join(repoRoot, ".claude", "delegate", "state");
}

function sessionPath(repoRoot, id) {
  return path.join(stateDir(repoRoot), `${id}.json`);
}

export function newSessionId() {
  return `dlg_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export async function createSession(repoRoot, fields) {
  const now = new Date().toISOString();
  const session = {
    id: fields.id ?? newSessionId(),
    task: fields.task,
    field: fields.field ?? "general",
    taskFile: fields.taskFile ?? null,
    reportFile: fields.reportFile ?? null,
    worktreePath: fields.worktreePath,
    branchName: fields.branchName,
    opencodeSessionId: fields.opencodeSessionId ?? null,
    model: fields.model ?? null,
    status: "running",
    iteration: 0,
    maxIterations: fields.maxIterations,
    createdAt: now,
    updatedAt: now,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    lastVerification: null,
  };
  await writeSession(repoRoot, session);
  return session;
}

export async function writeSession(repoRoot, session) {
  await mkdir(stateDir(repoRoot), { recursive: true });
  await writeFile(sessionPath(repoRoot, session.id), JSON.stringify(session, null, 2));
  return session;
}

export async function readSession(repoRoot, id) {
  const filePath = sessionPath(repoRoot, id);
  try {
    const raw = await readFile(filePath, "utf8");
    return parseSessionJson(raw, filePath);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function listSessions(repoRoot) {
  const dir = stateDir(repoRoot);
  let entries;
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const sessions = await Promise.all(
    entries
      .filter((f) => f.endsWith(".json"))
      .map(async (f) => parseSessionJson(await readFile(path.join(dir, f), "utf8"), path.join(dir, f)))
  );
  return sessions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function updateSession(repoRoot, id, patch) {
  const existing = await readSession(repoRoot, id);
  if (!existing) throw new Error(`No delegate session found with id ${id}`);
  if (patch.status && !STATUSES.includes(patch.status)) {
    throw new Error(`Invalid status "${patch.status}", must be one of ${STATUSES.join(", ")}`);
  }
  const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  await writeSession(repoRoot, updated);
  return updated;
}

export async function deleteSession(repoRoot, id) {
  await rm(sessionPath(repoRoot, id), { force: true });
}

export { STATUSES };
