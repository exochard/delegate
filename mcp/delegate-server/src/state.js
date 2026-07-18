import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

const STATUSES = [
  "running",
  "ready-to-accept",
  "needs-human",
  "accepted",
  "rejected",
  "failed",
];

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
  try {
    const raw = await readFile(sessionPath(repoRoot, id), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function listSessions(repoRoot) {
  let entries;
  try {
    entries = await readdir(stateDir(repoRoot));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const sessions = await Promise.all(
    entries
      .filter((f) => f.endsWith(".json"))
      .map((f) => readFile(path.join(stateDir(repoRoot), f), "utf8").then(JSON.parse))
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
