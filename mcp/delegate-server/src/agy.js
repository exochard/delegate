import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile, unlink, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const MODELS = ["flash", "pro"];
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

// The model is interpolated into YAML frontmatter and can come from a repo's own
// .claude/delegate/config.json, so anything off the allowlist could inject keys such
// as `commandExecutionPolicy: on`. Never interpolate an unchecked value.
function assertModel(model) {
  if (!MODELS.includes(model)) throw new Error(`Unknown gather model "${model}". Use one of: ${MODELS.join(", ")}.`);
}

/** One agent file per model, so concurrent gathers on different models never rewrite each other's definition. */
export function agentName(model) {
  assertModel(model);
  return `delegate-gatherer-${model}`;
}

/** Directory agy discovers custom agent definitions from. The env var is the test seam. */
export function agentsDir() {
  return process.env.DELEGATE_AGY_AGENTS_DIR || path.join(os.homedir(), ".gemini", "config", "agents");
}

function agyBin() {
  return process.env.DELEGATE_AGY_BIN || "agy";
}

/** Markdown agent definition: main agent, no subagents, no shell, read-only tool allowlist. */
export function agentDefinition({ model = "pro" } = {}) {
  return `---
name: ${agentName(model)}
description: Read-only evidence gatherer for delegate
mainAgent: true
subagent: false
model: ${model}
commandExecutionPolicy: off
tools: [view_file, grep_search, list_dir, find_by_name]
---
You gather evidence from the files of the current workspace and answer in the required JSON schema.

Rules:
- You are read-only. Never modify, create or delete anything, and never run commands.
- Use evidence only from files under the workspace. No outside knowledge, no web.
- Every finding needs the exact repo-relative path, the 1-based line number, the verbatim text of that line as the quote, and a short claim that the quote supports.
- Never guess. If part of the question cannot be answered from the files, state it in \`unknowns\`.
- Never delegate to another agent. Do the reading yourself.
`;
}

/** Write the agent definition only when it is missing or differs. Returns true when written. */
export async function ensureAgent({ model = "pro" } = {}) {
  const file = path.join(agentsDir(), `${agentName(model)}.md`);
  const content = agentDefinition({ model });
  try {
    if ((await readFile(file, "utf8")) === content) return false;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  await mkdir(path.dirname(file), { recursive: true });
  // Write then rename, so a concurrent agy start never reads a half-written definition.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, file);
  return true;
}

export const GATHER_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          line: { type: "integer" },
          quote: { type: "string" },
          claim: { type: "string" },
        },
        required: ["path", "line", "quote", "claim"],
      },
    },
    unknowns: { type: "array", items: { type: "string" } },
  },
  required: ["findings"],
};

/** argv for a headless run. `-p <prompt>` must stay last: agy reads the next token after -p as the prompt. */
export function buildGatherArgs({ model, schemaPath, prompt }) {
  return ["--agent", agentName(model), "--mode", "plan", "--output-format", "json", "--json-schema", schemaPath, "-p", prompt];
}

/** Wrap the question in the evidence brief, scoped to `paths` when given. */
export function buildPrompt({ question, paths }) {
  const scope = paths?.length ? `Restrict your reading to these paths: ${paths.join(", ")}.` : "Search the whole workspace as needed.";
  return [
    "Answer the question below using only evidence found in files of this workspace.",
    scope,
    "Report each finding with its repo-relative path, 1-based line, the verbatim line as quote, and a short claim. List anything you could not establish in unknowns.",
    "",
    `Question: ${question}`,
  ].join("\n");
}

// Under a custom --agent, agy 1.2.16 leaves structured_output null and puts the
// schema-shaped JSON in `response` instead, sometimes inside a code fence, sometimes
// repeated or wrapped in prose. Take the last object that carries findings; every `{` is
// a candidate start, so a stray brace in the prose cannot hide the JSON after it.
function structuredFromResponse(response) {
  if (typeof response !== "string") return null;
  let found = null;
  let from = 0;
  for (let start = response.indexOf("{"); start !== -1; start = response.indexOf("{", from)) {
    const end = balancedEnd(response, start);
    if (end !== -1) {
      try {
        const parsed = JSON.parse(response.slice(start, end + 1));
        if (parsed && Array.isArray(parsed.findings)) {
          found = parsed;
          from = end + 1;
          continue;
        }
      } catch {}
    }
    from = start + 1;
  }
  return found;
}

/** Index of the `}` closing the object opened at `start`, honouring JSON strings; -1 if unclosed. */
function balancedEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}" && --depth === 0) {
      return i;
    }
  }
  return -1;
}

/** Parse agy's single JSON object and enforce the success contract. */
export function parseResult(stdout) {
  let out;
  try {
    out = JSON.parse(stdout);
  } catch {
    throw new Error(`agy returned output that is not JSON: ${String(stdout).slice(0, 200)}`);
  }
  if (out.status !== "SUCCESS") throw new Error(`agy run did not succeed (status: ${out.status})`);
  if (Array.isArray(out.denied_actions) && out.denied_actions.length > 0) {
    const names = out.denied_actions.map((a) => a.display_name || a.action).join(", ");
    throw new Error(`agy run failed: tool actions were denied (${names})`);
  }
  const structured = out.structured_output ?? structuredFromResponse(out.response);
  if (!structured || typeof structured !== "object") {
    throw new Error("agy run returned no structured_output");
  }
  const { findings, unknowns } = structured;
  if (!Array.isArray(findings)) throw new Error("agy output violates the schema: findings is not an array");
  return {
    findings,
    unknowns: Array.isArray(unknowns) ? unknowns : [],
    conversationId: out.conversation_id ?? null,
    usage: out.usage ?? null,
    durationSeconds: out.duration_seconds ?? null,
  };
}

function runAgy(args, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    execFile(agyBin(), args, { cwd, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return reject(new Error("agy output exceeded 64 MB"));
        if (err.killed) return reject(new Error(`agy timed out after ${Math.round(timeoutMs / 1000)}s`));
        const detail = String(stderr || "").trim() || err.message;
        return reject(new Error(`agy exited with code ${err.code}: ${detail}`));
      }
      resolve(String(stdout));
    });
  });
}

/** Run one read-only gather question through agy and return its parsed findings. */
export async function gather({ repoRoot, question, paths, model = "pro", timeoutMs = RUN_TIMEOUT_MS }) {
  await ensureAgent({ model });
  const dir = await mkdtemp(path.join(os.tmpdir(), "delegate-agy-"));
  const schemaPath = path.join(dir, "schema.json");
  try {
    await writeFile(schemaPath, JSON.stringify(GATHER_SCHEMA));
    const args = buildGatherArgs({ model, schemaPath, prompt: buildPrompt({ question, paths }) });
    // agy scopes workspace reads to the cwd; an unnormalized root (a/b/../..) gets its own
    // in-repo grep calls denied.
    return parseResult(await runAgy(args, { cwd: path.resolve(repoRoot), timeoutMs }));
  } finally {
    await unlink(schemaPath).catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function checkInstalled() {
  return new Promise((resolve) => {
    execFile(agyBin(), ["--version"], { timeout: 5000 }, (err, stdout) => {
      resolve(err ? { installed: false, error: err.message } : { installed: true, version: String(stdout).trim() });
    });
  });
}
