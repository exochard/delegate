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
export async function writeWorkerConfig({ directory, workerPermissions, repoRoot }) {
  const config = {
    $schema: "https://opencode.ai/config.json",
    permission: {
      ...permissionConfigFromWorkerPermissions(workerPermissions),
      // The task and report files live in the MAIN repo, outside the worktree — opencode
      // treats every path outside the worktree as external and auto-rejects access
      // without this rule, silently crippling the round (observed: exit 0, empty diff).
      // Scoped to the repo root deliberately: bash is already "allow", so this grants no
      // capability the worker doesn't have via the shell; it only makes the file tools
      // consistent with it.
      external_directory: { [`${repoRoot}/**`]: "allow" },
    },
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
 * Builds the argv for `opencode run`, isolated from process spawning so the exact
 * flag order/shape (esp. the `--` terminator below) can be asserted on without ever
 * spawning a real process — a prior argv bug here shipped behind a green test suite
 * because nothing exercised this shape directly.
 */
export function buildRunArgs({ directory, taskFilePath, sessionId, model }) {
  // `--pure` skips external plugins. Without it the worker inherits every plugin-injected
  // MCP server from the user's global opencode setup — measured at ~54k extra input tokens
  // per round, and outright context overflow on 32k-context models. An explicit empty
  // "mcp": {} in the project config does NOT prevent this: opencode merges config sources
  // deep per key, so only per-server "enabled": false works, which requires knowing the
  // server names. --pure is the only switch that actually isolates the worker.
  const args = ["run", "--pure", "--dir", directory, "--format", "json"];
  if (sessionId) args.push("-s", sessionId);
  if (model) args.push("-m", model);
  if (taskFilePath) args.push("-f", taskFilePath);
  // The positional `message` is required by opencode's own CLI even when the real
  // instructions live in the attached file. `--` terminates `-f`'s variadic file
  // list first: without it opencode parses this message as another filename and
  // dies with `File not found: Follow the instructions...` before the run starts.
  args.push("--", "Follow the instructions in the attached task file.");
  return args;
}

/** Builds the rejection message for a non-zero `opencode run` close, distinguishing our own timeout and abort from external kills. Exported for testing. */
export function runFailureMessage({ exitCode, signal, timedOut, aborted, stderr }) {
  if (timedOut) return "opencode run timed out and was killed";
  if (aborted) return "opencode run was stopped";
  if (signal) return `opencode run was terminated by signal ${signal}`;
  return `opencode run failed (exit ${exitCode}): ${stderr.trim() || "no stderr output"}`;
}

/**
 * Runs one round of a task via `opencode run` — a one-shot CLI invocation, not a
 * persistent server. Pass `sessionId` to continue a prior round in the same opencode
 * session (feedback rounds); omit it to start a new one.
 */
export function run({ directory, taskFilePath, sessionId, model, delegateSessionId, timeoutMs = RUN_TIMEOUT_MS }) {
  const args = buildRunArgs({ directory, taskFilePath, sessionId, model });

  return new Promise((resolve, reject) => {
    const child = execFile("opencode", args, { cwd: directory, maxBuffer: MAX_BUFFER });
    const entry = { child, aborted: false, timedOut: false };
    if (delegateSessionId) inFlight.set(delegateSessionId, entry);

    // Own timer instead of execFile's timeout option: when the kill lands, close only
    // tells us "SIGTERM" — we need to know it was our timer, not abortRun or the user.
    const timer = setTimeout(() => {
      entry.timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    timer.unref?.();

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (delegateSessionId) inFlight.delete(delegateSessionId);

      const { sessionId: resultSessionId, message } = extractResult(parseEvents(stdout));
      if (exitCode !== 0) {
        reject(
          new Error(
            runFailureMessage({ exitCode, signal, timedOut: entry.timedOut, aborted: entry.aborted, stderr })
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
      clearTimeout(timer);
      if (delegateSessionId) inFlight.delete(delegateSessionId);
      reject(new Error(`Failed to spawn opencode run: ${err.message}`));
    });
  });
}

/** Aborts the in-flight `opencode run` for a delegate session, if one is currently running. Returns false if none was running. */
export function abortRun(delegateSessionId) {
  const entry = inFlight.get(delegateSessionId);
  if (!entry) return false;
  entry.aborted = true;
  entry.child.kill("SIGTERM");
  return true;
}

/**
 * Finds the JSON document in `opencode export` output. The export body is pretty-printed,
 * so line-based scanning must start at a line beginning the document and parse through the
 * end of output — slicing at the first '{' anywhere breaks the moment opencode logs a brace
 * before the body.
 */
export function extractExportJson(stdout) {
  const lines = stdout.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trimStart().startsWith("{")) continue;
    try {
      return JSON.parse(lines.slice(i).join("\n"));
    } catch {
      // A log line may start with '{' without being the document — try the next candidate.
    }
  }
  throw new Error("opencode export completed without a JSON body in its output");
}

/** Reads a session's cost/token summary via `opencode export`. */
export async function exportSession({ directory, sessionId }) {
  const { stdout } = await new Promise((resolve, reject) => {
    execFile("opencode", ["export", sessionId], { cwd: directory, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) reject(new Error(`opencode export failed: ${stderr || err.message}`));
      else resolve({ stdout });
    });
  });
  // `opencode export` may print a "Exporting session: <id>" line before the JSON body.
  const parsed = extractExportJson(stdout);
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
