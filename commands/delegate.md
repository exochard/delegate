---
description: Delegate one or more tasks to an opencode worker in an isolated git worktree, then review/verify the result
argument-hint: <task description> [--field name] [--model provider/model] [| <task 2> | <task 3> ...]
---

opencode writes the code here, not you. Your job is to hand off the task, then act as reviewer and gatekeeper: read what came back, verify it, and decide what happens next. Nothing lands on the user's branch unless they explicitly run `/delegate:accept`.

Initial request: $ARGUMENTS

## Step 1: Parse the request

- Split on ` | ` into one or more task strings for parallel fan-out — most requests are just one.
- If a task string carries `--model provider/model`, pull it out before passing the task text along.
- If a task string carries `--field name`, pull that out too — it's a category (e.g. `backend`, `docs`) that groups the task's files under `.delegate/<field>/`. Default to something sensible from the task itself (`backend`, `frontend`, `docs`, `bugfix`, ...) when the user didn't specify one.
- Ask a quick clarifying question first if the request is ambiguous or there's no repo to work in. A worker chewing on a misread task just burns the user's opencode spend for nothing.

## Step 2: Start each task

Call `delegate_start` with `{ task, field?, model? }` for each one. Multiple tasks get independent worktrees, so fire them off concurrently — no conflict risk.

`delegate_start` already runs a full round for you: it writes the task to `.delegate/<field>/<task>.md`, runs the opencode worker once against it, and runs verification. What comes back is `{ session, verification, diff, report }`.

## Step 3: Judge it yourself — the exit code isn't the whole story

For each session, read `verification`, `diff`, and `report` together:

- `verification.allPassed === true` — read the diff anyway. Tests passing doesn't mean the change actually does what was asked.
- `verification.allPassed === false` — figure out what broke from the command output, then call `delegate_feedback` with something concrete to try. "Fix the tests" isn't feedback; naming the actual problem is. Loop until it's resolved.
- `verification.allPassed === null` — nothing got auto-detected and there's no config override. Say that plainly, and go through the diff by hand as if it were a human's PR.
- `report.workerReportMissing === true` — the worker didn't write its own account to the report file this round. Not fatal (verification and the diff are still ground truth), but worth a one-line mention rather than pretending it filed one.
- Stop once `session.status` hits `ready-to-accept` or `needs-human`. The latter means the iteration cap ran out while still failing — hand the diff and last verification output to the user instead of burning more opencode calls chasing it.

## Step 4: Report back, don't merge

For each session, summarize: the task, final status, how many iterations it took, cost/tokens spent, and a short read on the diff. Give the user the session id and point them at `/delegate:accept <id>` or `/delegate:reject <id>`. **Do not call `delegate_accept` from inside this command** — that decision belongs to the user, not you.
