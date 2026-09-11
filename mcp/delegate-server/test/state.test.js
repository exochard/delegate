import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("readSession rejects a hand-corrupted session file with a named, actionable error", async () => {
  await withTempRepo(async (repoRoot) => {
    const session = await createSession(repoRoot, {
      task: "x",
      worktreePath: "/x",
      branchName: "b/x",
      maxIterations: 3,
    });
    const filePath = path.join(repoRoot, ".claude", "delegate", "state", `${session.id}.json`);

    // Truncated/garbage bytes — the realistic corruption shape.
    await rm(filePath);
    await writeFile(filePath, '{"id":"dlg_abcd","task":');
    await assert.rejects(() => readSession(repoRoot, session.id), (err) => {
      assert.match(err.message, /Corrupt delegate session state/);
      assert.match(err.message, new RegExp(session.id));
      assert.match(err.message, /invalid JSON/);
      assert.match(err.message, /Delete the file or restore/);
      return true;
    });

    // Parseable JSON that doesn't match the session schema.
    await writeFile(filePath, JSON.stringify({ id: session.id, task: 42 }));
    await assert.rejects(() => readSession(repoRoot, session.id), (err) => {
      assert.match(err.message, /Corrupt delegate session state/);
      assert.match(err.message, /task: Expected string/);
      return true;
    });
  });
});

test("listSessions names the corrupt file instead of dying on a bare JSON.parse error", async () => {
  await withTempRepo(async (repoRoot) => {
    await createSession(repoRoot, { task: "a", worktreePath: "/a", branchName: "b/a", maxIterations: 3 });
    const stateDir = path.join(repoRoot, ".claude", "delegate", "state");
    await writeFile(path.join(stateDir, "dlg_deadbeef0000.json"), "not json at all");
    await assert.rejects(() => listSessions(repoRoot), /Corrupt delegate session state.*dlg_deadbeef0000\.json/);
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
