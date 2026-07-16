import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createSession,
  readSession,
  listSessions,
  updateSession,
  deleteSession,
} from "../src/state.js";

async function withTempRepo(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "delegate-state-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("createSession writes a session with defaults and it round-trips", async () => {
  await withTempRepo(async (repoRoot) => {
    const session = await createSession(repoRoot, {
      task: "add a hello world function",
      worktreePath: "/tmp/wt",
      branchName: "delegate/dlg_abc",
      maxIterations: 3,
    });

    assert.match(session.id, /^dlg_[a-f0-9]{12}$/);
    assert.equal(session.status, "running");
    assert.equal(session.iteration, 0);
    assert.equal(session.maxIterations, 3);

    const reread = await readSession(repoRoot, session.id);
    assert.deepEqual(reread, session);
  });
});

test("readSession returns null for unknown id", async () => {
  await withTempRepo(async (repoRoot) => {
    const result = await readSession(repoRoot, "dlg_doesnotexist");
    assert.equal(result, null);
  });
});

test("listSessions returns [] when no state dir exists yet", async () => {
  await withTempRepo(async (repoRoot) => {
    const sessions = await listSessions(repoRoot);
    assert.deepEqual(sessions, []);
  });
});

test("listSessions returns all sessions sorted by createdAt", async () => {
  await withTempRepo(async (repoRoot) => {
    const a = await createSession(repoRoot, { task: "a", worktreePath: "/a", branchName: "b/a", maxIterations: 3 });
    const b = await createSession(repoRoot, { task: "b", worktreePath: "/b", branchName: "b/b", maxIterations: 3 });
    const sessions = await listSessions(repoRoot);
    assert.equal(sessions.length, 2);
    assert.deepEqual(sessions.map((s) => s.id).sort(), [a.id, b.id].sort());
  });
});

test("updateSession merges patch fields and bumps updatedAt", async () => {
  await withTempRepo(async (repoRoot) => {
    const session = await createSession(repoRoot, {
      task: "x",
      worktreePath: "/x",
      branchName: "b/x",
      maxIterations: 3,
    });
    const updated = await updateSession(repoRoot, session.id, {
      status: "ready-to-accept",
      iteration: 1,
      cost: 0.042,
    });
    assert.equal(updated.status, "ready-to-accept");
    assert.equal(updated.iteration, 1);
    assert.equal(updated.cost, 0.042);
    assert.equal(updated.task, "x");
  });
});

test("updateSession rejects an invalid status", async () => {
  await withTempRepo(async (repoRoot) => {
    const session = await createSession(repoRoot, {
      task: "x",
      worktreePath: "/x",
      branchName: "b/x",
      maxIterations: 3,
    });
    await assert.rejects(
      () => updateSession(repoRoot, session.id, { status: "bogus" }),
      /Invalid status/
    );
  });
});

test("updateSession throws for an unknown session id", async () => {
  await withTempRepo(async (repoRoot) => {
    await assert.rejects(
      () => updateSession(repoRoot, "dlg_doesnotexist", { status: "accepted" }),
      /No delegate session found/
    );
  });
});

test("deleteSession removes the state file", async () => {
  await withTempRepo(async (repoRoot) => {
    const session = await createSession(repoRoot, {
      task: "x",
      worktreePath: "/x",
      branchName: "b/x",
      maxIterations: 3,
    });
    await deleteSession(repoRoot, session.id);
    const reread = await readSession(repoRoot, session.id);
    assert.equal(reread, null);
  });
});
