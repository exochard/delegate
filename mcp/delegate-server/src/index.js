import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";

import * as state from "./state.js";
import * as worktreeMod from "./worktree.js";
import * as verifyMod from "./verify.js";
import * as reportMod from "./report.js";
import { loadConfig, saveConfig } from "./config.js";
import { resolveWorker } from "./worker.js";

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

async function refreshCostFromWorker(repoRoot, session, worker) {
  try {
    const { cost, tokens } = await worker.exportSession({
      directory: session.worktreePath,
      sessionId: session.opencodeSessionId,
    });
    return state.updateSession(repoRoot, session.id, {
      cost: cost ?? session.cost,
      tokens: tokens ?? session.tokens,
    });
  } catch {
    // Cost refresh is best-effort — opencode's export not being reachable shouldn't
    // block the caller from seeing the rest of the session state.
    return session;
  }
}

function slugFromSession(session) {
  return path.basename(session.taskFile, ".md");
}

function statusAfterVerification(verification, iteration, maxIterations) {
  if (verification.allPassed === false) {
    return iteration >= maxIterations ? "needs-human" : "running";
  }
  return "ready-to-accept";
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
      "Create an isolated git worktree, write the task to .delegate/<field>/<task>.md, run the opencode worker once, and run verification. Returns the session, the diff, and the verification result for Claude to judge.",
    inputSchema: {
      repoRoot: z.string().optional().describe("Target repo root. Defaults to the current working directory."),
      task: z.string().describe("The task description to hand to the opencode worker."),
      field: z.string().optional().describe("Category for this task, e.g. \"backend\" or \"docs\". Groups files under .delegate/<field>/. Defaults to \"general\"."),
      model: z.string().optional().describe("provider/model override. Defaults to the project's configured default model."),
      maxIterations: z.number().int().positive().optional().describe("Override the configured max feedback iterations for this session."),
    },
  },
  async ({ repoRoot: repoRootInput, task, field = "general", model, maxIterations }) => {
    const repoRoot = resolveRepoRoot(repoRootInput);
    await worktreeMod.assertGitRepo(repoRoot);
    const config = await loadConfig(repoRoot);
    const worker = resolveWorker(config.worker);
    const effectiveModel = model ?? config.defaultModel ?? null;

    const sessionId = state.newSessionId();
    const { worktreePath, branchName } = await worktreeMod.createWorktree(repoRoot, sessionId);
    const slug = await reportMod.chooseSlug(repoRoot, field, task, sessionId);
    const { taskPath, reportPath } = await reportMod.writeInitialTaskFile({ repoRoot, field, slug, task });

    let session = await state.createSession(repoRoot, {
      id: sessionId,
      task,
      field,
      taskFile: taskPath,
      reportFile: reportPath,
      worktreePath,
      branchName,
      model: effectiveModel,
      maxIterations: maxIterations ?? config.maxIterations,
    });

    try {
      worker.parseModel(effectiveModel); // throws on a malformed model string
      await worker.writeWorkerConfig({ directory: worktreePath, workerPermissions: config.workerPermissions });

      const baseline = await reportMod.snapshotReport({ repoRoot, field, slug });
      const run = await worker.run({
        directory: worktreePath,
        taskFilePath: taskPath,
        model: effectiveModel,
        delegateSessionId: sessionId,
      });
      session = await state.updateSession(repoRoot, sessionId, { opencodeSessionId: run.sessionId });

      const verification = await verifyMod.runVerification(worktreePath, { verifyCommand: config.verifyCommand });
      const reportResult = await reportMod.finalizeReportRound({ repoRoot, field, slug, round: 1, baseline, verification });
      const diff = await worktreeMod.getWorktreeDiff(worktreePath, worker);

      session = await state.updateSession(repoRoot, sessionId, {
        iteration: 1,
        status: statusAfterVerification(verification, 1, session.maxIterations),
        lastVerification: { pass: verification.allPassed, output: summarizeVerification(verification), at: new Date().toISOString() },
      });
      session = await refreshCostFromWorker(repoRoot, session, worker);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                session,
                verification: summarizeVerification(verification),
                diff,
                report: { path: reportResult.reportPath, workerReportMissing: reportResult.workerReportMissing, workerExcerpt: reportResult.workerExcerpt },
              },
              null,
              2
            ),
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
      "Append feedback to the session's task file (e.g. after a failed verification), re-run the opencode worker in the same session, then re-run verification.",
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
    const worker = resolveWorker(config.worker);
    const slug = slugFromSession(session);
    const nextIteration = session.iteration + 1;

    const taskFilePath = await reportMod.appendFeedbackSection({
      repoRoot,
      field: session.field,
      slug,
      round: nextIteration,
      message,
    });
    const baseline = await reportMod.snapshotReport({ repoRoot, field: session.field, slug });

    const run = await worker.run({
      directory: session.worktreePath,
      taskFilePath,
      sessionId: session.opencodeSessionId,
      model: session.model,
      delegateSessionId: session.id,
    });

    const verification = await verifyMod.runVerification(session.worktreePath, { verifyCommand: config.verifyCommand });
    const reportResult = await reportMod.finalizeReportRound({
      repoRoot,
      field: session.field,
      slug,
      round: nextIteration,
      baseline,
      verification,
    });
    const diff = await worktreeMod.getWorktreeDiff(session.worktreePath, worker);

    session = await state.updateSession(repoRoot, id, {
      opencodeSessionId: run.sessionId,
      iteration: nextIteration,
      status: statusAfterVerification(verification, nextIteration, session.maxIterations),
      lastVerification: { pass: verification.allPassed, output: summarizeVerification(verification), at: new Date().toISOString() },
    });
    session = await refreshCostFromWorker(repoRoot, session, worker);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              session,
              verification: summarizeVerification(verification),
              diff,
              report: { path: reportResult.reportPath, workerReportMissing: reportResult.workerReportMissing, workerExcerpt: reportResult.workerExcerpt },
            },
            null,
            2
          ),
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
    const worker = resolveWorker(config.worker);

    const verification = await verifyMod.runVerification(session.worktreePath, { verifyCommand: config.verifyCommand });
    const diff = await worktreeMod.getWorktreeDiff(session.worktreePath, worker);

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
      const config = await loadConfig(repoRoot);
      session = await refreshCostFromWorker(repoRoot, session, resolveWorker(config.worker));
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
    const config = await loadConfig(repoRoot);
    const diff = await worktreeMod.getWorktreeDiff(session.worktreePath, resolveWorker(config.worker));
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
    const config = await loadConfig(repoRoot);
    await worktreeMod.mergeWorktree(repoRoot, session, resolveWorker(config.worker));
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
    description: "Abort the opencode worker process for a session, if one is currently running. Does not delete the worktree — the diff stays inspectable.",
    inputSchema: {
      repoRoot: z.string().optional(),
      id: z.string(),
    },
  },
  async ({ repoRoot: repoRootInput, id }) => {
    const repoRoot = resolveRepoRoot(repoRootInput);
    const session = await requireSession(repoRoot, id);
    const config = await loadConfig(repoRoot);
    const stopped = resolveWorker(config.worker).abortRun(id);
    const updated = stopped ? await state.updateSession(repoRoot, id, { abortedAt: new Date().toISOString() }) : session;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { stopped, session: updated, message: stopped ? "opencode run aborted" : "no opencode run was in flight for this session" },
            null,
            2
          ),
        },
      ],
    };
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
      worker: z.string().optional().describe("Worker backend to run tasks with. Defaults to \"opencode\"."),
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
    if (patch.worker !== undefined) resolveWorker(patch.worker); // throws on an unknown worker name
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
    description: "Check that opencode is installed, the repo is a git repo, and report orphaned worktrees.",
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

    const config = await loadConfig(repoRoot);
    report.worker = config.worker;
    // Kept under the `opencode` key: the slash commands and README read it by that name.
    report.opencode = await resolveWorker(config.worker).checkInstalled();

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
