// A worker driver that implements the full contract without touching the network or
// spawning a child process. The MCP server loads it via DELEGATE_WORKER_MODULE so the
// unit tests can exercise every tool end-to-end deterministically.
import { readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

// parseModel is pure string handling, so the tests keep exercising the real one.
export { parseModel } from "../../src/opencode.js";

export const WORKER_CONFIG_FILENAME = "fake-worker.jsonc";

// The file every round writes into the worktree — asserted on by the diff tests.
export const OUTPUT_FILENAME = "worker-output.txt";

const inFlight = new Map();
let sessionCounter = 0;

export async function writeWorkerConfig({ directory, workerPermissions }) {
  await writeFile(
    path.join(directory, WORKER_CONFIG_FILENAME),
    JSON.stringify({ permission: workerPermissions ?? {} }, null, 2)
  );
}

// The task file tells the worker which report file to append to; the real worker reads
// that instruction out of the file, so the fake does too.
function reportPathFromTaskFile(taskContent) {
  const match = taskContent.match(/^\s+(\S+-report\.md)$/m);
  return match ? match[1] : null;
}

export async function run({ directory, taskFilePath, sessionId, delegateSessionId }) {
  if (delegateSessionId) inFlight.set(delegateSessionId, true);
  try {
    const round = sessionId ? "follow-up" : "initial";
    await writeFile(path.join(directory, OUTPUT_FILENAME), `fake worker ${round} round\n`);

    if (taskFilePath) {
      const taskContent = await readFile(taskFilePath, "utf8");
      const reportPath = reportPathFromTaskFile(taskContent);
      if (reportPath) await appendFile(reportPath, `\n## Worker report\n\nDid the ${round} round.\n`);
    }

    return {
      sessionId: sessionId ?? `ses_fake_${++sessionCounter}`,
      message: `fake worker completed the ${round} round`,
    };
  } finally {
    if (delegateSessionId) inFlight.delete(delegateSessionId);
  }
}

export function abortRun(delegateSessionId) {
  return inFlight.delete(delegateSessionId);
}

export async function exportSession({ sessionId }) {
  if (!sessionId) throw new Error("fake worker: exportSession needs a sessionId");
  return { cost: 0.0025, tokens: { input: 100, output: 42 } };
}

export async function checkInstalled() {
  return { installed: true, version: "0.0.0-fake" };
}
