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
| `/delegate "<task>" [--model provider/model]` | Kick off a task. Chain several with `\|` to fan them out into parallel worktrees. |
| `/delegate:status [id]` | List every session, or drill into one — status, iteration count, cost so far. |
| `/delegate:diff <id>` | Show the session's current diff. |
| `/delegate:feedback <id> "<message>"` | Send the worker another instruction (e.g. after a failed check) and re-verify. |
| `/delegate:review <id>` | Re-run verification only — no new instructions sent. |
| `/delegate:accept <id>` | Merge the session's branch in, drop the worktree. |
| `/delegate:reject <id>` | Throw the worktree and branch away. Your main tree was never touched. |
| `/delegate:stop <id>` | Kill the running opencode worker. The worktree sticks around so you can still inspect or resume it. |
| `/delegate:config [key=value ...]` | Read or change defaults: model, iteration cap, verify command, what the worker's allowed to touch. |
| `/delegate:doctor` | Sanity check: is opencode installed, is this a git repo, is the server up, any stray worktrees lying around. |

## How it fits together

Every task gets its own worktree and branch, sitting as a sibling directory next to your repo rather than nested inside it, plus its own opencode session scoped to that worktree under a permission profile you control (the worker has no network access by default — see `/delegate:config`). You send it the task, it writes code, and verification runs — your configured command if you've set one, otherwise whatever gets auto-detected from `package.json`, a `Makefile`, or a handful of common test runners. A green exit code by itself proves nothing; you're expected to read the actual output and the diff. If something's broken, feedback goes back into the same session with something specific to try, up to a cap you set — past that, it stops and waits for you.

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

## License

MIT
