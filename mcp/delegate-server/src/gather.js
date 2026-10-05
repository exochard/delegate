import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import * as agy from "./agy.js";

const MAX_DRIFT = 3;

function escapes(rel) {
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

async function verifyOne(root, finding) {
  // Findings are model output: one malformed entry must be rejected, not abort the batch.
  if (!finding || typeof finding.path !== "string" || typeof finding.quote !== "string" || !Number.isInteger(finding.line)) {
    return { ...(finding && typeof finding === "object" ? finding : { finding }), verified: false, reason: "malformed finding" };
  }
  const resolved = path.resolve(root, finding.path);
  const rel = path.relative(root, resolved);
  if (rel === "" || escapes(rel)) {
    return { ...finding, verified: false, reason: "path escapes repo root" };
  }
  let text;
  try {
    // A symlink inside the repo can still point outside it; check where it really lands,
    // then read that resolved path so a swapped link cannot redirect the read.
    const realFile = await realpath(resolved);
    if (escapes(path.relative(await realpath(root), realFile))) {
      return { ...finding, verified: false, reason: "path escapes repo root" };
    }
    text = await readFile(realFile, "utf8");
  } catch {
    return { ...finding, verified: false, reason: "file not found" };
  }
  const lines = text.split(/\r?\n/);
  const want = finding.quote.trim();
  if (want === "") return { ...finding, verified: false, reason: "quote not found" };
  for (let d = 0; d <= MAX_DRIFT; d++) {
    for (const actual of d === 0 ? [finding.line] : [finding.line - d, finding.line + d]) {
      if (actual >= 1 && actual <= lines.length && lines[actual - 1].trim() === want) {
        return { ...finding, verified: true, actualLine: actual };
      }
    }
  }
  return { ...finding, verified: false, reason: "quote not found" };
}

/** Re-check every finding's quote against the file on disk; paths outside repoRoot are rejected. */
export async function verifyFindings(repoRoot, findings) {
  const root = path.resolve(repoRoot);
  const results = await Promise.all(findings.map((f) => verifyOne(root, f)));
  return { verified: results.filter((r) => r.verified), rejected: results.filter((r) => !r.verified) };
}

/** Register delegate_gather: a read-only evidence lane served by the agy CLI. */
export function registerGatherTool(server, { resolveRepoRoot, loadConfig }) {
  server.registerTool(
    "delegate_gather",
    {
      title: "Gather evidence",
      description:
        "Ask the Antigravity CLI (agy) a read-only question about the repo. Returns findings as path:line with a quoted line, each re-checked against the file; unverifiable ones come back as rejected. Only the quote and line are verified: claims, unknowns and rejected quotes are unverified model output.",
      inputSchema: {
        question: z.string().describe("The evidence-gathering question."),
        paths: z.array(z.string()).optional().describe("Repo-relative paths to scope the search to."),
        repoRoot: z.string().optional(),
        model: z.enum(["flash", "pro"]).optional().describe("Gemini model tier. Defaults to config gatherModel, then \"pro\"."),
      },
    },
    async ({ question, paths, repoRoot: repoRootInput, model }) => {
      try {
        const repoRoot = resolveRepoRoot(repoRootInput);
        const badPath = paths?.find((p) => path.isAbsolute(p) || escapes(path.relative(repoRoot, path.resolve(repoRoot, p))));
        if (badPath !== undefined) throw new Error(`paths must be repo-relative and inside the repo: ${badPath}`);
        const config = await loadConfig(repoRoot);
        const result = await agy.gather({ repoRoot, question, paths, model: model ?? config.gatherModel ?? "pro" });
        const { verified, rejected } = await verifyFindings(repoRoot, result.findings);
        const body = {
          question,
          verified,
          rejected,
          unknowns: result.unknowns,
          conversationId: result.conversationId,
          usage: result.usage,
          durationSeconds: result.durationSeconds,
        };
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
    }
  );
}
