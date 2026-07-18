import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER = 1024 * 1024 * 64;

// Bookkeeping file opencode reads for worker permissions — never part of the task's
// own diff. worktree.js excludes this name from diff/stat/commit pathspecs.
export const WORKER_CONFIG_FILENAME = "opencode.jsonc";

const inFlight = new Map(); // delegateSessionId -> ChildProcess

/** "provider/model-id" -> {providerID, id}. Returns null for falsy input. Throws on malformed input. */
export function parseModel(modelString) {
  if (!modelString) return null;
  const slash = modelString.indexOf("/");
  if (slash === -1) {
    throw new Error(`Model must be in "provider/model" format, got "${modelString}"`);
  }
  return { providerID: modelString.slice(0, slash), id: modelString.slice(slash + 1) };
}

/** Maps our config's {bash:true, webfetch:false, ...} onto opencode's project-config permission map ({bash:"allow", webfetch:"deny", ...}). */
export function permissionConfigFromWorkerPermissions(workerPermissions = {}) {
  return Object.fromEntries(
    Object.entries(workerPermissions).map(([permission, allowed]) => [permission, allowed ? "allow" : "deny"])
  );
}

/** Writes the worker's permission scope as an opencode project config in its worktree. */
export async function writeWorkerConfig({ directory, workerPermissions }) {
  const config = {
    $schema: "https://opencode.ai/config.json",
    permission: permissionConfigFromWorkerPermissions(workerPermissions),
  };
  await writeFile(path.join(directory, WORKER_CONFIG_FILENAME), JSON.stringify(config, null, 2));
}

function parseEvents(stdout) {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// `opencode run --format json` streams newline-delimited events; every event carries the
// sessionID, and the worker's reply is spread across one or more {type:"text"} events.
function extractResult(events) {
  const sessionId = events.find((e) => e.sessionID)?.sessionID ?? null;
  const message = events
    .filter((e) => e.type === "text" && e.part?.text)
    .map((e) => e.part.text)
    .join("");
  return { sessionId, message };
}

/**
 * Runs one round of a task via `opencode run` — a one-shot CLI invocation, not a
 * persistent server. Pass `sessionId` to continue a prior round in the same opencode
 * session (feedback rounds); omit it to start a new one.
 */
export function run({ directory, taskFilePath, sessionId, model, delegateSessionId }) {
  const args = ["run", "--dir", directory, "--format", "json"];
  if (sessionId) args.push("-s", sessionId);
  if (model) args.push("-m", model);
  if (taskFilePath) args.push("-f", taskFilePath);
  // The positional `message` is required by opencode's own CLI even when the real
  // instructions live in the attached file. `--` terminates `-f`'s variadic file
  // list first: without it opencode parses this message as another filename and
  // dies with `File not found: Follow the instructions...` before the run starts.
  args.push("--", "Follow the instructions in the attached task file.");

  return new Promise((resolve, reject) => {
    const child = execFile("opencode", args, { cwd: directory, timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
    if (delegateSessionId) inFlight.set(delegateSessionId, child);

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("close", (exitCode, signal) => {
      if (delegateSessionId) inFlight.delete(delegateSessionId);

      const { sessionId: resultSessionId, message } = extractResult(parseEvents(stdout));
      if (exitCode !== 0) {
        const aborted = signal === "SIGTERM" && exitCode === null;
        reject(
          new Error(
            aborted
              ? "opencode run was stopped"
              : `opencode run failed (exit ${exitCode}): ${stderr.trim() || "no stderr output"}`
          )
        );
        return;
      }
      if (!resultSessionId) {
        reject(new Error("opencode run completed but no sessionID was found in its output"));
        return;
      }
      resolve({ sessionId: resultSessionId, message });
    });
    child.on("error", (err) => {
      if (delegateSessionId) inFlight.delete(delegateSessionId);
      reject(new Error(`Failed to spawn opencode run: ${err.message}`));
    });
  });
}

/** Aborts the in-flight `opencode run` for a delegate session, if one is currently running. Returns false if none was running. */
export function abortRun(delegateSessionId) {
  const child = inFlight.get(delegateSessionId);
  if (!child) return false;
  child.kill("SIGTERM");
  return true;
}

/** Reads a session's cost/token summary via `opencode export`. */
export async function exportSession({ directory, sessionId }) {
  const { stdout } = await new Promise((resolve, reject) => {
    execFile("opencode", ["export", sessionId], { cwd: directory, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) reject(new Error(`opencode export failed: ${stderr || err.message}`));
      else resolve({ stdout });
    });
  });
  // `opencode export` prints a "Exporting session: <id>" line before the JSON body.
  const parsed = JSON.parse(stdout.slice(stdout.indexOf("{")));
  return { cost: parsed.info?.cost ?? 0, tokens: parsed.info?.tokens ?? null };
}

/** Confirms the `opencode` CLI is installed and runnable. */
export async function checkInstalled() {
  return new Promise((resolve) => {
    execFile("opencode", ["--version"], { timeout: 5000 }, (err, stdout) => {
      resolve(err ? { installed: false, error: err.message } : { installed: true, version: String(stdout).trim() });
    });
  });
}
