import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectVerifyCommands, runVerification } from "../src/verify.js";

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "delegate-verify-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("detectVerifyCommands finds npm test/build/lint scripts", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "exit 0", build: "exit 0", extra: "exit 0" } })
    );
    const commands = await detectVerifyCommands(dir);
    assert.deepEqual(
      commands.map((c) => c.name).sort(),
      ["npm run build", "npm run test"]
    );
  });
});

test("detectVerifyCommands finds Makefile test/build targets", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "Makefile"), "test:\n\techo testing\nbuild:\n\techo building\n");
    const commands = await detectVerifyCommands(dir);
    assert.deepEqual(
      commands.map((c) => c.name).sort(),
      ["make build", "make test"]
    );
  });
});

test("detectVerifyCommands finds pytest via pyproject.toml", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "pyproject.toml"), "[tool.pytest.ini_options]\n");
    const commands = await detectVerifyCommands(dir);
    assert.deepEqual(commands.map((c) => c.name), ["pytest"]);
  });
});

test("detectVerifyCommands returns [] when nothing recognized", async () => {
  await withTempDir(async (dir) => {
    const commands = await detectVerifyCommands(dir);
    assert.deepEqual(commands, []);
  });
});

test("runVerification with a config override runs it via shell", async () => {
  await withTempDir(async (dir) => {
    const passing = await runVerification(dir, { verifyCommand: "exit 0" });
    assert.equal(passing.source, "config-override");
    assert.equal(passing.allPassed, true);

    const failing = await runVerification(dir, { verifyCommand: "exit 1" });
    assert.equal(failing.allPassed, false);
    assert.equal(failing.results[0].exitCode, 1);
  });
});

test("runVerification auto-detects and runs npm scripts", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "exit 0" } })
    );
    const result = await runVerification(dir, {});
    assert.equal(result.source, "auto-detected");
    assert.equal(result.commandsRun, 1);
    assert.equal(result.allPassed, true);
  });
});

test("runVerification reports allPassed=false when one detected command fails", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "exit 0", build: "exit 1" } })
    );
    const result = await runVerification(dir, {});
    assert.equal(result.commandsRun, 2);
    assert.equal(result.allPassed, false);
  });
});

test("runVerification reports a missing auto-detected binary as a failed command, not a crash", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "exit 0" } })
    );
    // Empty PATH makes the detected `npm` binary unresolvable, deterministically
    // simulating "auto-detected a runner that isn't installed" on any machine.
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const result = await runVerification(dir, {});
      assert.equal(result.source, "auto-detected");
      assert.equal(result.allPassed, false);
      assert.equal(result.results[0].exitCode, null);
      assert.match(result.results[0].spawnError, /ENOENT/);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

test("runVerification with nothing detected returns a note instead of failing", async () => {
  await withTempDir(async (dir) => {
    const result = await runVerification(dir, {});
    assert.equal(result.source, "none-detected");
    assert.equal(result.commandsRun, 0);
    assert.equal(result.allPassed, null);
    assert.match(result.note, /Review the diff manually/);
  });
});
