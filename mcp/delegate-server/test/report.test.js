import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  fieldDir,
  taskFilePath,
  reportFilePath,
  chooseSlug,
  writeInitialTaskFile,
  appendFeedbackSection,
  snapshotReport,
  finalizeReportRound,
} from "../src/report.js";

async function withTempRepo(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "delegate-report-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const PASS = { commandsRun: 1, results: [{ name: "npm test", exitCode: 0 }], allPassed: true };
const FAIL = { commandsRun: 1, results: [{ name: "npm test", exitCode: 1, timedOut: false }], allPassed: false };
const NOTHING = { commandsRun: 0, results: [], allPassed: null, note: "nothing detected" };

test("chooseSlug slugifies the task text", async () => {
  await withTempRepo(async (repoRoot) => {
    const slug = await chooseSlug(repoRoot, "backend", "Add a hello world endpoint!", "dlg_abc123def456");
    assert.equal(slug, "add-a-hello-world-endpoint");
  });
});

test("chooseSlug suffixes with a short id on collision", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeInitialTaskFile({ repoRoot, field: "backend", slug: "add-endpoint", task: "add endpoint" });
    const slug = await chooseSlug(repoRoot, "backend", "add endpoint", "dlg_abc123def456");
    assert.equal(slug, "add-endpoint-abc123");
  });
});

test("writeInitialTaskFile creates the task file under .delegate/<field>/ with the report path referenced", async () => {
  await withTempRepo(async (repoRoot) => {
    const { taskPath, reportPath } = await writeInitialTaskFile({
      repoRoot,
      field: "backend",
      slug: "add-endpoint",
      task: "Add a /health endpoint",
    });
    assert.equal(taskPath, taskFilePath(repoRoot, "backend", "add-endpoint"));
    assert.equal(reportPath, reportFilePath(repoRoot, "backend", "add-endpoint"));
    assert.equal(path.dirname(taskPath), fieldDir(repoRoot, "backend"));

    const content = await readFile(taskPath, "utf8");
    assert.match(content, /Add a \/health endpoint/);
    assert.match(content, new RegExp(reportPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

test("appendFeedbackSection appends without clobbering the original task text", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeInitialTaskFile({ repoRoot, field: "backend", slug: "add-endpoint", task: "Add a /health endpoint" });
    await appendFeedbackSection({
      repoRoot,
      field: "backend",
      slug: "add-endpoint",
      round: 2,
      message: "The endpoint returns 500, check the handler",
    });

    const content = await readFile(taskFilePath(repoRoot, "backend", "add-endpoint"), "utf8");
    assert.match(content, /Add a \/health endpoint/);
    assert.match(content, /Feedback — round 2/);
    assert.match(content, /returns 500/);
  });
});

test("finalizeReportRound creates the report file and flags a missing worker section when the worker never wrote one", async () => {
  await withTempRepo(async (repoRoot) => {
    const baseline = await snapshotReport({ repoRoot, field: "backend", slug: "add-endpoint" });
    assert.equal(baseline, "");

    const result = await finalizeReportRound({
      repoRoot,
      field: "backend",
      slug: "add-endpoint",
      round: 1,
      baseline,
      verification: PASS,
    });

    assert.equal(result.workerReportMissing, true);
    assert.equal(result.workerExcerpt, null);

    const content = await readFile(result.reportPath, "utf8");
    assert.match(content, /Verification — round 1/);
    assert.match(content, /passed/);
  });
});

test("finalizeReportRound detects the worker's own section and preserves it alongside the verification section", async () => {
  await withTempRepo(async (repoRoot) => {
    const baseline = await snapshotReport({ repoRoot, field: "backend", slug: "add-endpoint" });

    // Simulate the worker writing its own account before delegate finalizes the round.
    await mkdir(fieldDir(repoRoot, "backend"), { recursive: true });
    await writeFile(
      reportFilePath(repoRoot, "backend", "add-endpoint"),
      "## Worker report\n\nAdded the /health route and a test for it.\n"
    );

    const result = await finalizeReportRound({
      repoRoot,
      field: "backend",
      slug: "add-endpoint",
      round: 1,
      baseline,
      verification: PASS,
    });

    assert.equal(result.workerReportMissing, false);
    assert.match(result.workerExcerpt, /Added the \/health route/);

    const content = await readFile(result.reportPath, "utf8");
    assert.match(content, /Added the \/health route/);
    assert.match(content, /Verification — round 1/);
  });
});

test("finalizeReportRound across two rounds appends both verification sections without losing round 1's", async () => {
  await withTempRepo(async (repoRoot) => {
    const baseline1 = await snapshotReport({ repoRoot, field: "backend", slug: "add-endpoint" });
    await finalizeReportRound({ repoRoot, field: "backend", slug: "add-endpoint", round: 1, baseline: baseline1, verification: FAIL });

    const baseline2 = await snapshotReport({ repoRoot, field: "backend", slug: "add-endpoint" });
    const result2 = await finalizeReportRound({ repoRoot, field: "backend", slug: "add-endpoint", round: 2, baseline: baseline2, verification: PASS });

    const content = await readFile(result2.reportPath, "utf8");
    assert.match(content, /Verification — round 1/);
    assert.match(content, /Verification — round 2/);
  });
});

test("finalizeReportRound handles a verification result with nothing detected", async () => {
  await withTempRepo(async (repoRoot) => {
    const baseline = await snapshotReport({ repoRoot, field: "docs", slug: "update-readme" });
    const result = await finalizeReportRound({
      repoRoot,
      field: "docs",
      slug: "update-readme",
      round: 1,
      baseline,
      verification: NOTHING,
    });
    const content = await readFile(result.reportPath, "utf8");
    assert.match(content, /not checked/);
    assert.match(content, /nothing detected/);
  });
});
