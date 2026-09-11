# Delegate

You (Claude) keep the task, the judgment, and the merge button. [opencode](https://opencode.ai) does the typing — in its own git worktree, on whatever model you point it at — while you read the diff, run verification, and decide what happens next.

## Why bother

- **It's cheaper.** A cheap or local model writes the code; you only spend tokens reading and judging it.
- **A second pair of eyes catches more.** Code reviewing your own output misses things a genuinely different engine won't.
- **Work runs in parallel.** Every task gets its own worktree, so several can be in flight without stepping on each other.

## Before you start

- [opencode](https://opencode.ai) installed and logged in (`opencode auth login`, or whatever your provider needs) — `opencode --version` should print something.
- A git repo (`git init` first if the project isn't one yet).
- Node.js 20+, to run this plugin's MCP server.

Run `/delegate:doctor` once you've installed everything — it'll tell you if any of the above is missing.

## Commands

| Command | What it does |
|---|---|
| `/delegate "<task>" [--field name] [--model provider/model]` | Kick off a task. Chain several with `\|` to fan them out into parallel worktrees. |
| `/delegate:status [id]` | List every session, or drill into one — status, iteration count, cost so far. |
| `/delegate:diff <id>` | Show the session's current diff. |
| `/delegate:feedback <id> "<message>"` | Send the worker another instruction (e.g. after a failed check) and re-verify. |
| `/delegate:review <id>` | Re-run verification only — no new instructions sent. |
| `/delegate:accept <id>` | Merge the session's branch in, drop the worktree. |
| `/delegate:reject <id>` | Throw the worktree and branch away. Your main tree was never touched. |
| `/delegate:stop <id>` | Kill the running opencode worker, if one's in flight. The worktree sticks around so you can still inspect or resume it. |
| `/delegate:config [key=value ...]` | Read or change defaults: model, iteration cap, verify command, what the worker's allowed to touch. |
| `/delegate:doctor` | Sanity check: is opencode installed, is this a git repo, any stray worktrees lying around. |

## How it fits together

Every task gets its own worktree and branch, sitting as a sibling directory next to your repo rather than nested inside it, with a permission profile you control (the worker has no network access by default — see `/delegate:config`).

The handoff itself is plain files, not an API call. Starting a task writes `.delegate/<field>/<task>.md` in your main repo — the instructions, plus where to write its own account of the work. `field` is just a category you pick (`backend`, `docs`, whatever groups your tasks sensibly) so related work doesn't scatter. opencode runs against that file once per round (`opencode run`, not a long-lived server), and is asked to append what it did to `<task>-report.md` alongside it. Delegate always appends its own verification section to that same report after the worker's round finishes — pass/fail, command output — so the file reflects the real outcome even if the worker skips its half. Feedback rounds append a new section to the task file and continue the same opencode session; nothing gets overwritten, so the whole exchange stays readable end to end.

Verification runs your configured command if you've set one, otherwise whatever gets auto-detected from `package.json`, a `Makefile`, or a handful of common test runners. A green exit code by itself proves nothing; you're expected to read the actual output and the diff. If something's broken, feedback goes back into the same session with something specific to try, up to a cap you set — past that, it stops and waits for you.

Merging only happens when you run `/delegate:accept`.

## Config

`.claude/delegate/config.json` lives per-project and is gitignored:

```json
{
  "defaultModel": "provider/model or null",
  "maxIterations": 3,
  "verifyCommand": "optional override string, or null for auto-detect",
  "workerPermissions": {
    "bash": true, "read": true, "edit": true, "glob": true, "grep": true,
    "webfetch": false, "task": false, "todowrite": true, "websearch": false, "lsp": true, "skill": false
  }
}
```

`webfetch`, `websearch`, and `task` start off — the worker runs unattended, so it shouldn't be able to reach the internet or spawn sub-agents until you decide it should. Turn them on per project with `/delegate:config` if you actually need them.

The worker also runs with opencode's `--pure` flag: it inherits none of your global opencode plugins or plugin-injected MCP servers. Measured on one real setup, that inheritance cost ~54k extra input tokens per round and pushed 32k-context models into overflow; the worker round itself needs ~15k.

## Benchmarking

```bash
cd mcp/delegate-server
npm run benchmark            # deterministic lane: real MCP server, fake worker driver
DELEGATE_E2E=1 npm run benchmark   # + real lane: one opencode round on the default model
```

The deterministic lane drives the actual MCP server process over stdio (exactly like Claude Code does) with the fake worker driver, timing `delegate_start` and asserting the worker config never leaks into the diff. The real lane reports opencode's own exported token/cost numbers for a round. The "direct" comparison column is a chars/4 estimate of the task plus the landed diff — a floor, not a measurement; the benchmark never calls a billed token API.

## License

MIT
