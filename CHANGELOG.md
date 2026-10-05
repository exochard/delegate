# Changelog

Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## delegate 0.4.0 — 2026-10-05

### Added

- `/delegate:gather` and the `delegate_gather` tool: a read-only evidence lane served by the
  Antigravity CLI (`agy`). It runs a dedicated `delegate-gatherer-<model>` agent in plan mode with shell
  off and a file-reading tool allowlist, treats any denied action as a failed run, and re-checks
  every returned quote against the file (±3 lines of drift) before reporting it as verified.
- `gatherModel` config key (`flash` or `pro`, default `pro`) and an `agy` entry in `delegate_doctor`.

## delegate 0.3.0 — 2026-09-11

### Fixed

- The freshness gate no longer fails on its own repo: `mcp/delegate-server/package.json`
  and `package-lock.json` describe the server's dev identity, not shipped plugin
  behavior, so editing them no longer forces a plugin version bump. The gate had been
  red since `9869178` for exactly that reason, masking every other stale-version signal.
- `delegate_start` works out of the box again. The pinned default model
  `opencode/deepseek-v4-flash-free` was retired from the opencode catalog — every round
  failed with "Unexpected server error" once delisted. Re-pinned to
  `opencode/mimo-v2.5-free`, verified responsive on 2026-09-11. Run `opencode models`
  before future re-pins: the catalog retires free models without notice.
- Worker rounds are isolated from the user's global opencode plugins and their MCP
  servers: `opencode run` now goes out with `--pure`. On one real setup the inheritance
  cost ~54k extra input tokens per round and pushed 32k-context models into overflow
  (measured: 69,438-token request against a 32,768 context, vs 15,502 with isolation).
  An explicit empty `mcp` config section does not prevent inheritance — opencode merges
  config sources deep per key, so only per-server `enabled: false` works, which requires
  knowing server names — so the flag is the only effective lever.
- A verify command whose binary is missing (e.g. `cargo test` auto-detected from a
  `Cargo.toml` with cargo not installed) now reports as a failed command instead of
  crashing the MCP server through an unhandled spawn `error` event.
- `opencode run` timeouts are reported as timeouts, distinct from explicit aborts —
  previously both said "opencode run was stopped".
- Session state files are validated on load; a corrupt file now names itself, says what
  is wrong, and says what to do, instead of surfacing a bare `JSON.parse` error.
- Merge commit subjects keep the task's first line only, capped at 72 chars — raw
  multi-line task text used to land verbatim in `git log`.
- The worker-config exclusion in diff/stat/commit pathspecs resolves from the active
  worker driver at call time, not from the default driver at module load.
- `opencode export` parsing finds the JSON document by line instead of slicing at the
  first `{` anywhere in the output.
- The worker can reach the handoff files at all: the task and report files live in the
  main repo, outside the worktree, and opencode 1.18.x auto-rejects every external
  path without an `external_directory` rule (first e2e symptom: exit 0, empty diff,
  round silently did nothing). The worker config now allows external access scoped to
  the repo root — no new capability in practice, since `bash` was already "allow".
- `opencode run` and `opencode export` are spawned with file stdio instead of pipes.
  opencode 1.18.29 (a Bun binary) hung silently at startup on this Linux machine
  whenever stdout/stderr were pipes — 5/5 pipe spawns sat past the 10-minute round
  timeout with zero output, while the identical argv with file stdio finished in
  seconds. `opencode --version` is unaffected, so `checkInstalled` keeps pipes.

### Added

- `benchmark/run-benchmark.js`, wired as `npm run benchmark` in
  `mcp/delegate-server`: a deterministic lane that drives the real MCP server over stdio
  with the fake worker driver, and a real-opencode lane behind `DELEGATE_E2E=1`. Every
  number is measured except the "direct" comparison column, which is a labeled chars/4
  estimate (a floor, not a measurement — the benchmark never calls a billed token API).
- First verified end-to-end run of the plugin (2026-09-11, opencode 1.18.29, default
  model): one real task through the MCP server — round in 24s, `greeting.txt` diff
  landed in the worktree, `delegate_accept` merged it into main with the sanitized
  subject, worktree and state cleaned up. Exact commands and the reusable scripted
  lane live in `.e2e-scratch/run-e2e.js` next to this repo's workspace.

### Changed

- `plugin.json` gains a `metadata` description; `claude plugin validate --strict` is
  clean.
- The default model string lives in one place (`src/config.js` exports
  `DEFAULT_MODEL`); the tests import it instead of restating it.
