---
description: Abort a running delegate session's opencode worker without discarding its worktree
argument-hint: <session-id>
---

Call `delegate_stop` with `{ id: $ARGUMENTS }`. It kills the opencode worker process but leaves the worktree in place — the diff is still there to inspect via `/delegate:diff`, and `/delegate:accept` or `/delegate:reject` both still work afterward.
