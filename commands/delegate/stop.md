---
description: Abort a running delegate session's opencode worker without discarding its worktree
argument-hint: <session-id>
---

Call `delegate_stop` with `{ id: $ARGUMENTS }`. If `stopped` comes back `true`, it killed an in-flight opencode round. If `false`, there was nothing running for that session — say so, it's not an error. Either way the worktree stays in place — the diff is still there to inspect via `/delegate:diff`, and `/delegate:accept` or `/delegate:reject` both still work afterward.
