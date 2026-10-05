import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyFindings } from "../src/gather.js";

async function withRepo(fn) {
  const base = await mkdtemp(path.join(tmpdir(), "delegate-gather-test-"));
  const root = path.join(base, "repo");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "a.js"), ["l1", "l2", "  const x = 1;", "l4", "l5", "l6", "l7", "l8", "l9"].join("\n"));
  await writeFile(path.join(base, "secret.txt"), "const x = 1;\n");
  try {
    return await fn(root, base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

const f = (p, line, quote = "const x = 1;") => ({ path: p, line, quote, claim: "c" });

test("accepts exact line and ignores surrounding whitespace", () =>
  withRepo(async (root) => {
    const { verified, rejected } = await verifyFindings(root, [f("src/a.js", 3)]);
    assert.equal(rejected.length, 0);
    assert.equal(verified[0].actualLine, 3);
  }));

test("accepts drift of 3 lines and records actualLine, rejects 4", () =>
  withRepo(async (root) => {
    const { verified, rejected } = await verifyFindings(root, [f("src/a.js", 6), f("src/a.js", 7)]);
    assert.equal(verified.length, 1);
    assert.equal(verified[0].actualLine, 3);
    assert.equal(rejected[0].reason, "quote not found");
  }));

test("rejects a wrong quote", () =>
  withRepo(async (root) => {
    const { rejected } = await verifyFindings(root, [f("src/a.js", 3, "const y = 2;")]);
    assert.equal(rejected[0].verified, false);
    assert.equal(rejected[0].reason, "quote not found");
  }));

test("rejects a missing file", () =>
  withRepo(async (root) => {
    const { rejected } = await verifyFindings(root, [f("src/nope.js", 1)]);
    assert.equal(rejected[0].reason, "file not found");
  }));

test("rejects ../ escapes and absolute paths outside the root", () =>
  withRepo(async (root, base) => {
    const { verified, rejected } = await verifyFindings(root, [
      f("../secret.txt", 1),
      f(path.join(base, "secret.txt"), 1),
    ]);
    assert.equal(verified.length, 0);
    assert.equal(rejected.length, 2);
    assert.ok(rejected.every((r) => r.reason === "path escapes repo root"));
  }));

test("rejects a symlink inside the root that points outside it", () =>
  withRepo(async (root, base) => {
    await symlink(path.join(base, "secret.txt"), path.join(root, "link.txt"));
    const { verified, rejected } = await verifyFindings(root, [f("link.txt", 1)]);
    assert.equal(verified.length, 0);
    assert.equal(rejected[0].reason, "path escapes repo root");
  }));

test("rejects malformed findings one by one instead of failing the batch", () =>
  withRepo(async (root) => {
    const { verified, rejected } = await verifyFindings(root, [
      null,
      { path: null, line: 1, quote: "x", claim: "c" },
      { path: "src/a.js", line: 3, quote: 42, claim: "c" },
      { path: "src/a.js", line: "3", quote: "x", claim: "c" },
      f("src/a.js", 3),
    ]);
    assert.equal(verified.length, 1);
    assert.equal(rejected.length, 4);
    assert.ok(rejected.every((r) => r.reason === "malformed finding"));
  }));

test("accepts an in-repo name that starts with two dots", () =>
  withRepo(async (root) => {
    await writeFile(path.join(root, "..hidden"), "const x = 1;\n");
    const { verified } = await verifyFindings(root, [f("..hidden", 1)]);
    assert.equal(verified.length, 1);
  }));

test("accepts an absolute path inside the root", () =>
  withRepo(async (root) => {
    const { verified } = await verifyFindings(root, [f(path.join(root, "src", "a.js"), 3)]);
    assert.equal(verified.length, 1);
  }));
