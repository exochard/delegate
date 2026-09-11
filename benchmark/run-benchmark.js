#!/usr/bin/env node
'use strict';

/**
 * Delegate worker-cost benchmark: what a delegated round actually costs versus
 * doing the same edit directly in a Claude session.
 *
 * Every measured number below comes from driving the REAL MCP server
 * (mcp/delegate-server/src/index.js) over stdio, exactly like Claude Code drives
 * it in production — nothing about the delegate side is simulated. The only
 * computed-not-measured numbers are the "direct" comparison column (chars/4
 * estimate of the task plus the landed diff, clearly labeled) — the real Claude
 * token cost of doing the edit yourself can't be measured offline, so the
 * estimate is deliberately a floor, not a point.
 *
 * Lane 1 (always runs, deterministic): the MCP server with the fake worker
 * driver injected via DELEGATE_WORKER_MODULE. No network, no worker child
 * process. Timing is real wall-clock around delegate_start; tokens/cost are the
 * driver's own reported constants.
 *
 * Lane 2 (DELEGATE_E2E=1): the real opencode driver with the shipped default
 * model. Timing is real; tokens/cost come from opencode's own session export.
 *
 * Both lanes assert the MCP-isolation property this repo cares about: the worker
 * config written into the worktree carries permissions only — no mcp section —
 * and the real driver is launched with --pure so the user's global/plugin MCP
 * servers never enter the worker's context.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createRequire } = require('module');

const SERVER_DIR = path.join(__dirname, '..', 'mcp', 'delegate-server');
// Resolve the MCP SDK from the server's own node_modules regardless of where (or
// whether) a root install exists — this script must run from a bare clone.
const serverRequire = createRequire(path.join(SERVER_DIR, 'package.json'));
const { Client } = serverRequire('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = serverRequire('@modelcontextprotocol/sdk/client/stdio.js');

const SERVER_ENTRY = path.join(SERVER_DIR, 'src', 'index.js');
const FAKE_WORKER = path.join(SERVER_DIR, 'test', 'helpers', 'fake-worker.js');

const TRIALS = 5;
const E2E = process.env.DELEGATE_E2E === '1';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeTempRepo() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-bench-'));
  const repoRoot = path.join(parent, 'repo');
  fs.mkdirSync(repoRoot);
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.email', 'benchmark@example.com']);
  git(repoRoot, ['config', 'user.name', 'Delegate Benchmark']);
  fs.writeFileSync(path.join(repoRoot, 'README.md'), 'hello\n');
  git(repoRoot, ['add', '-A']);
  git(repoRoot, ['commit', '-m', 'initial commit']);
  return { parent, repoRoot };
}

function tokensEstimate(chars) {
  return Math.round(chars / 4);
}

async function withServer(env, fn) {
  const transport = new StdioClientTransport({ command: 'node', args: [SERVER_ENTRY], env: { ...process.env, ...env } });
  const client = new Client({ name: 'delegate-benchmark', version: '0.0.1' });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function jsonResult(result) {
  return JSON.parse(result.content[0].text);
}

// --- Lane 1: deterministic, fake driver, real MCP server process ---

async function runFakeLane() {
  console.log('=== Lane 1: deterministic (fake worker driver, real MCP server) ===');
  console.log(`delegate_start run ${TRIALS} times: timing is real wall-clock; tokens/cost are`);
  console.log('the fake driver\'s reported constants, not a measurement.\n');

  const trials = [];
  for (let i = 0; i < TRIALS; i++) {
    const { parent, repoRoot } = makeTempRepo();
    try {
      const startedAt = process.hrtime.bigint();
      const outcome = await withServer({ DELEGATE_WORKER_MODULE: FAKE_WORKER }, async (client) => {
        const started = await client.callTool({
          name: 'delegate_start',
          arguments: { repoRoot, task: 'Write the output file', field: 'bench', model: 'fake/model' },
        });
        const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        return { started: jsonResult(started), elapsedMs };
      });
      const { session, diff } = outcome.started;

      // Correctness property, not just performance: the worker config the server writes
      // into the worktree must carry permissions only, and the diff must not contain it.
      const configInWorktree = JSON.parse(fs.readFileSync(path.join(session.worktreePath, 'fake-worker.jsonc'), 'utf8'));
      if ('mcp' in configInWorktree) throw new Error('worker config leaked an mcp section');
      if (diff.patch.includes('fake-worker.jsonc')) throw new Error('worker config leaked into the diff');

      // Clean up the session this trial created (worktree + branch).
      await withServer({ DELEGATE_WORKER_MODULE: FAKE_WORKER }, async (client) => {
        await client.callTool({ name: 'delegate_reject', arguments: { repoRoot, id: session.id } });
      });

      trials.push({
        elapsedMs: outcome.elapsedMs,
        patchChars: diff.patch.length,
        tokens: session.tokens,
        cost: session.cost,
      });
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  }

  const timings = trials.map((t) => t.elapsedMs);
  const patches = new Set(trials.map((t) => t.patchChars));
  console.log(`trials:              ${TRIALS}`);
  console.log(`delegate wall time:  ${Math.min(...timings).toFixed(0)} / ${(timings.reduce((a, b) => a + b, 0) / timings.length).toFixed(0)} / ${Math.max(...timings).toFixed(0)} ms (min/avg/max)`);
  console.log(`diff size:           ${trials[0].patchChars} chars across trials, ${patches.size === 1 ? 'byte-identical (deterministic)' : 'VARIED — NON-DETERMINISTIC'}`);
  console.log(`driver tokens:       input ${trials[0].tokens.input}, output ${trials[0].tokens.output} (fake driver constants)`);
  console.log(`driver cost:         $${trials[0].cost} (fake driver constant)`);
}

// --- Lane 2: real opencode, gated on DELEGATE_E2E ---

const E2E_TASK = 'Create a file called bench.txt containing the single word: done';

async function runRealLane() {
  console.log('\n=== Lane 2: real opencode round (DELEGATE_E2E=1) ===');
  console.log('One delegate_start with the shipped default model; timing is real wall-clock,');
  console.log('tokens/cost are opencode\'s own export for the worker session.\n');

  const { parent, repoRoot } = makeTempRepo();
  try {
    let outcome;
    const startedAt = process.hrtime.bigint();
    await withServer({}, async (client) => {
      const config = jsonResult(await client.callTool({ name: 'delegate_config_get', arguments: { repoRoot } }));
      console.log(`model under test:    ${config.defaultModel}`);
      const started = await client.callTool(
        { name: 'delegate_start', arguments: { repoRoot, task: E2E_TASK, field: 'bench' } },
        undefined,
        { timeout: 15 * 60 * 1000 }
      );
      outcome = { started: jsonResult(started), config };
    });
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const { session, diff } = outcome.started;

    const directFloorChars = E2E_TASK.length + diff.patch.length;
    const directFloorTokens = tokensEstimate(directFloorChars);
    const workerInput = session.tokens.input ?? 0;
    const workerOutput = session.tokens.output ?? 0;

    console.log(`delegate wall time:  ${(elapsedMs / 1000).toFixed(1)} s`);
    console.log(`worker tokens:       input ${workerInput}, output ${workerOutput} (measured, opencode export)`);
    console.log(`worker cost:         $${session.cost}`);
    console.log(`diff landed:         ${diff.stat || '(empty)'}`);
    console.log(`direct floor:        ${directFloorChars} chars ≈ ${directFloorTokens} tokens (ESTIMATE: task + diff, chars/4)`);
    console.log(`isolation:           ${workerInput > 0 ? `worker round consumed ${workerInput} input tokens with --pure isolation; without it the same machine measured ~54k extra input tokens per round and context overflow on 32k models` : 'n/a'}`);

    await withServer({}, async (client) => {
      await client.callTool({ name: 'delegate_reject', arguments: { repoRoot, id: session.id } });
    });

    if (workerInput > 0 && workerInput > directFloorTokens) {
      console.log(`\ndirect-floor comparison: the worker round read ${workerInput} input tokens to land a`);
      console.log(`${directFloorChars}-char change (~${directFloorTokens} tokens, estimate floor). What a direct edit`);
      console.log(`costs in your own session depends on your model and how the session goes — this benchmark`);
      console.log(`deliberately does not estimate that; the worker's bill is the measured number above.`);
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

function main() {
  console.log('delegate worker-cost benchmark');
  console.log('(measured: wall time, opencode-exported tokens; estimated: direct column is chars/4, a floor)');
  console.log('DISCLAIMER: the "direct" comparison cannot call Claude\'s token API (network + billed credits),');
  console.log('so it is a chars/4 estimate of the task plus the landed diff — a floor, not a measurement.\n');
  runFakeLane()
    .then(() => (E2E ? runRealLane() : console.log('\nLane 2 skipped: set DELEGATE_E2E=1 to run a real opencode round (needs a working default model).')))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

main();
