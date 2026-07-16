import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import * as state from "./state.js";
import * as worktreeMod from "./worktree.js";
import * as verifyMod from "./verify.js";
import * as opencodeMod from "./opencode.js";

const DEFAULT_CONFIG = {
  defaultModel: null,
  maxIterations: 3,
  verifyCommand: null,
  workerPermissions: {
    bash: true,
    read: true,
    edit: true,
    glob: true,
    grep: true,
    webfetch: false,
    task: false,
    todowrite: true,
    websearch: false,
    lsp: true,
    skill: false,
  },
};

function configPath(repoRoot) {
  return path.join(repoRoot, ".claude", "delegate", "config.json");
}

async function loadConfig(repoRoot) {
  try {
    const raw = await readFile(configPath(repoRoot), "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      workerPermissions: { ...DEFAULT_CONFIG.workerPermissions, ...(parsed.workerPermissions ?? {}) },
    };
  } catch (err) {
    if (err.code === "ENOENT") return { ...DEFAULT_CONFIG };
    throw err;
  }
}

async function saveConfig(repoRoot, config) {
  await mkdir(path.dirname(configPath(repoRoot)), { recursive: true });
  await writeFile(configPath(repoRoot), JSON.stringify(config, null, 2));
}

function truncate(text, max = 4000) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[truncated, ${text.length} chars total]`;
}

function summarizeVerification(result) {
  if (result.commandsRun === 0) {
    return { source: result.source, allPassed: result.allPassed, note: result.note };
  }
  return {
    source: result.source,
    allPassed: result.allPassed,
    commands: result.results.map((r) => ({
      name: r.name,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      stdout: truncate(r.stdout),
      stderr: truncate(r.stderr),
    })),
  };
}

async function withOpencodeClient() {
  const baseUrl = await opencodeMod.ensureServer();
  return opencodeMod.createApiClient(baseUrl);
}

async function refreshCostFromOpencode(repoRoot, session) {
  try {
    const client = await withOpencodeClient();
    const oc = await client.getSession({
      directory: session.worktreePath,
      sessionId: session.opencodeSessionId,
    });
    return state.updateSession(repoRoot, session.id, {
      cost: oc.cost ?? session.cost,
      tokens: oc.tokens ?? session.tokens,
    });
  } catch {
    // Cost refresh is best-effort — opencode session metadata not being reachable
    // shouldn't block the caller from seeing the rest of the session state.
    return session;
  }
}

async function requireSession(repoRoot, id) {
  const session = await state.readSession(repoRoot, id);
  if (!session) throw new Error(`No delegate session found with id "${id}" in ${repoRoot}`);
  return session;
}

function resolveRepoRoot(repoRoot) {
  return repoRoot ? path.resolve(repoRoot) : process.cwd();
}

const server = new McpServer({ name: "delegate-server", version: "0.1.0" });

server.registerTool(
  "delegate_start",
  {
    title: "Start a delegated task",
    description:
      "Create an isolated git worktree, start an opencode worker session scoped to it, send the task, and run verification once. Returns the session, the diff, and the verification result for Claude to judge.",
    inputSchema: {
      repoRoot: z.string().optional().describe("Target repo root. Defaults to the current working directory."),
      task: z.string().describe("The task description to hand to the opencode worker."),
      model: z.string().optional().describe("provider/model override. Defaults to the project's configured default model."),
      maxIterations: z.number().int().positive().optional().describe("Override the configured max feedback iterations for this session."),
    },
  },
  async ({ repoRoot: repoRootInput, task, model, maxIterations }) => {
    const repoRoot = resolveRepoRoot(repoRootInput);
    await worktreeMod.assertGitRepo(repoRoot);
    const config = await loadConfig(repoRoot);
    const effectiveModel = model ?? config.defaultModel ?? null;

    const sessionId = state.newSessionId();
    const { worktreePath, branchName } = await worktreeMod.createWorktree(repoRoot, sessionId);

    let session = await state.createSession(repoRoot, {
      id: sessionId,
      task,
      worktreePath,
      branchName,
      model: effectiveModel,
      maxIterations: maxIterations ?? config.maxIterations,
    });

    try {
      const client = await withOpencodeClient();
      const parsedModel = opencodeMod.parseModel(effectiveModel);
      const permission = opencodeMod.permissionRulesetFromConfig(config.workerPermissions);

      const ocSession = await client.createSession({
        directory: worktreePath,
        title: task.slice(0, 80),
        model: parsedModel ?? undefined,
        permission,
      });

      session = await state.updateSession(repoRoot, sessionId, { opencodeSessionId: ocSession.id });

      await client.sendMessage({
        directory: worktreePath,
        sessionId: ocSession.id,
        text: task,
        model: parsedModel ?? undefined,
      });

      const verification = await verifyMod.runVerification(worktreePath, { verifyCommand: config.verifyCommand });
      const diff = await worktreeMod.getWorktreeDiff(worktreePath);

      const newStatus =
        verification.allPassed === false
          ? session.iteration + 1 >= session.maxIterations
            ? "needs-human"
            : "running"
          : "ready-to-accept";

      session = await state.updateSession(repoRoot, sessionId, {
        iteration: session.iteration + 1,
        status: newStatus,
        lastVerification: { pass: verification.allPassed, output: summarizeVerification(verification), at: new Date().toISOString() },
      });
      session = await refreshCostFromOpencode(repoRoot, session);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ session, verification: summarizeVerification(verification), diff }, null, 2),
          },
        ],
      };
    } catch (err) {
      // A failure between worktree creation and the first successful round would otherwise
      // leave a permanently-stuck "running" session with no automatic way to retry or clean up.
      await worktreeMod.rejectWorktree(repoRoot, session).catch(() => {});
      await state.deleteSession(repoRoot, sessionId).catch(() => {});
      throw new Error(`delegate_start failed and was rolled back (worktree/session removed): ${err.message}`);
    }
  }
);

server.registerTool(
  "delegate_feedback",
  {
    title: "Send feedback to a delegated task",
    description:
      "Send another instruction into an existing opencode worker session (e.g. after a failed verification), then re-run verification.",
    inputSchema: {
      repoRoot: z.string().optional(),
      id: z.string().describe("The delegate session id."),
      message: z.string().describe("Feedback/instruction to send to the worker."),
    },
  },
  async ({ repoRoot: repoRootInput, id, message }) => {
    const repoRoot = resolveRepoRoot(repoRootInput);
    let session = await requireSession(repoRoot, id);
    const config = await loadConfig(repoRoot);
    const client = await withOpencodeClient();
    const parsedModel = opencodeMod.parseModel(session.model);

    await client.sendMessage({
      directory: session.worktreePath,
      sessionId: session.opencodeSessionId,
      text: message,
      model: parsedModel ?? undefined,
    });

    const verification = await verifyMod.runVerification(session.worktreePath, { verifyCommand: config.verifyCommand });
    const diff = await worktreeMod.getWorktreeDiff(session.worktreePath);

    const nextIteration = session.iteration + 1;
    const newStatus =
      verification.allPassed === false
        ? nextIteration >= session.maxIterations
          ? "needs-human"
          : "running"
        : "ready-to-accept";

    session = await state.updateSession(repoRoot, id, {
      iteration: nextIteration,
      status: newStatus,
      lastVerification: { pass: verification.allPassed, output: summarizeVerification(verification), at: new Date().toISOString() },
    });
    session = await refreshCostFromOpencode(repoRoot, session);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ session, verification: summarizeVerification(verification), diff }, null, 2),
        },
      ],
    };
  }
);

server.registerTool(
  "delegate_review",
  {
    title: "Re-run verification for a delegated task",
    description: "Re-run verification against a session's worktree without sending new work to opencode.",
    inputSchema: {
      repoRoot: z.string().optional(),
      id: z.string(),
    },
  },
  async ({ repoRoot: repoRootInput, id }) => {
    const repoRoot = resolveRepoRoot(repoRootInput);
    let session = await requireSession(repoRoot, id);
    const config = await loadConfig(repoRoot);

    const verification = await verifyMod.runVerification(session.worktreePath, { verifyCommand: config.verifyCommand });
    const diff = await worktreeMod.getWorktreeDiff(session.worktreePath);

    const newStatus =
      verification.allPassed === false
        ? session.iteration >= session.maxIterations
          ? "needs-human"
          : session.status
        : "ready-to-accept";

    session = await state.updateSession(repoRoot, id, {
      status: newStatus,
      lastVerification: { pass: verification.allPassed, output: summarizeVerification(verification), at: new Date().toISOString() },
    });

    return {
      content: [
        { type: "text", text: JSON.stringify({ session, verification: summarizeVerification(verification), diff }, null, 2) },
      ],
    };
  }
);

server.registerTool(
  "delegate_status",
  {
    title: "Show delegate session status",
    description: "List all delegate sessions for a repo, or show one session's full detail including cost/tokens.",
    inputSchema: {
      repoRoot: z.string().optional(),
      id: z.string().optional().describe("If omitted, lists all sessions."),
    },
  },
  async ({ repoRoot: repoRootInput, id }) => {
    const repoRoot = resolveRepoRoot(repoRootInput);
    if (id) {
      let session = await requireSession(repoRoot, id);
      session = await refreshCostFromOpencode(repoRoot, session);
      return { content: [{ type: "text", text: JSON.stringify(session, null, 2) }] };
    }
    const sessions = await state.listSessions(repoRoot);
    return { content: [{ type: "text", text: JSON.stringify(sessions, null, 2) }] };
  }
);

server.registerTool(
  "delegate_diff",
  {
    title: "Show a delegate session's diff",
    description: "Show the current git diff of a delegate session's worktree.",
    inputSchema: {
      repoRoot: z.string().optional(),
      id: z.string(),
    },
  },
  async ({ repoRoot: repoRootInput, id }) => {
    const repoRoot = resolveRepoRoot(repoRootInput);
    const session = await requireSession(repoRoot, id);
    const diff = await worktreeMod.getWorktreeDiff(session.worktreePath);
    return { content: [{ type: "text", text: JSON.stringify(diff, null, 2) }] };
  }
);

server.registerTool(
  "delegate_accept",
  {
    title: "Accept a delegated task",
    description: "Merge the session's worktree branch into the current branch, remove the worktree, and clean up state.",
    inputSchema: {
      repoRoot: z.string().optional(),
      id: z.string(),
    },
  },
  async ({ repoRoot: repoRootInput, id }) => {
    const repoRoot = resolveRepoRoot(repoRootInput);
    const session = await requireSession(repoRoot, id);
    await worktreeMod.mergeWorktree(repoRoot, session);
    await state.deleteSession(repoRoot, id);
    return {
      content: [{ type: "text", text: JSON.stringify({ accepted: id, branch: session.branchName }, null, 2) }],
    };
  }
);

server.registerTool(
  "delegate_reject",
  {
    title: "Reject a delegated task",
    description: "Discard the session's worktree and branch without merging, and clean up state.",
    inputSchema: {
      repoRoot: z.string().optional(),
      id: z.string(),
    },
  },
  async ({ repoRoot: repoRootInput, id }) => {
    const repoRoot = resolveRepoRoot(repoRootInput);
    const session = await requireSession(repoRoot, id);
    await worktreeMod.rejectWorktree(repoRoot, session);
    await state.deleteSession(repoRoot, id);
    return { content: [{ type: "text", text: JSON.stringify({ rejected: id }, null, 2) }] };
  }
);

server.registerTool(
  "delegate_stop",
  {
    title: "Stop a running delegated task",
    description: "Abort the opencode worker process for a session. Does not delete the worktree — the diff stays inspectable.",
    inputSchema: {
      repoRoot: z.string().optional(),
      id: z.string(),
    },
  },
  async ({ repoRoot: repoRootInput, id }) => {
    const repoRoot = resolveRepoRoot(repoRootInput);
    const session = await requireSession(repoRoot, id);
    const client = await withOpencodeClient();
    await client.abortSession({ directory: session.worktreePath, sessionId: session.opencodeSessionId });
    const updated = await state.updateSession(repoRoot, id, { abortedAt: new Date().toISOString() });
    return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
  }
);

server.registerTool(
  "delegate_config_get",
  {
    title: "Get delegate config",
    description: "Read the project's delegate config (default model, max iterations, verify command override, worker permissions).",
    inputSchema: { repoRoot: z.string().optional() },
  },
  async ({ repoRoot: repoRootInput }) => {
    const repoRoot = resolveRepoRoot(repoRootInput);
    const config = await loadConfig(repoRoot);
    return { content: [{ type: "text", text: JSON.stringify(config, null, 2) }] };
  }
);

server.registerTool(
  "delegate_config_set",
  {
    title: "Set delegate config",
    description: "Merge the given fields into the project's delegate config and save it.",
    inputSchema: {
      repoRoot: z.string().optional(),
      defaultModel: z.string().nullable().optional(),
      maxIterations: z.number().int().positive().optional(),
      verifyCommand: z.string().nullable().optional(),
      workerPermissions: z
        .record(z.string(), z.boolean())
        .optional()
        .describe("Partial map of permission name -> allowed, e.g. {\"webfetch\": true}"),
    },
  },
  async ({ repoRoot: repoRootInput, ...patch }) => {
    const repoRoot = resolveRepoRoot(repoRootInput);
    const current = await loadConfig(repoRoot);
    const next = {
      ...current,
      ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined && v !== "workerPermissions")),
      workerPermissions: { ...current.workerPermissions, ...(patch.workerPermissions ?? {}) },
    };
    await saveConfig(repoRoot, next);
    return { content: [{ type: "text", text: JSON.stringify(next, null, 2) }] };
  }
);

server.registerTool(
  "delegate_doctor",
  {
    title: "Check the delegate environment",
    description: "Check that opencode is installed, the repo is a git repo, the opencode server is reachable, and report orphaned worktrees.",
    inputSchema: { repoRoot: z.string().optional() },
  },
  async ({ repoRoot: repoRootInput }) => {
    const repoRoot = resolveRepoRoot(repoRootInput);
    const report = { repoRoot };

    try {
      await worktreeMod.assertGitRepo(repoRoot);
      report.gitRepo = true;
    } catch (err) {
      report.gitRepo = false;
      report.gitRepoError = err.message;
    }

    try {
      const baseUrl = await opencodeMod.ensureServer();
      report.opencodeServer = { reachable: true, baseUrl };
    } catch (err) {
      report.opencodeServer = { reachable: false, error: err.message };
    }

    if (report.gitRepo) {
      const [worktrees, sessions] = await Promise.all([
        worktreeMod.listWorktrees(repoRoot),
        state.listSessions(repoRoot),
      ]);
      const knownPaths = new Set(sessions.map((s) => s.worktreePath));
      const delegateWorktrees = worktrees.filter((w) => w.path.includes(".delegate-worktrees"));
      report.orphanedWorktrees = delegateWorktrees.filter((w) => !knownPaths.has(w.path)).map((w) => w.path);
      report.activeSessions = sessions.length;
    }

    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

// The managed `opencode serve` child's stdout/stderr listeners (see opencode.js) keep this
// process's event loop alive even after the MCP transport closes, so exit explicitly rather
// than relying on natural event-loop drain.
server.server.onclose = () => {
  opencodeMod.shutdownServer();
  process.exit(0);
};
