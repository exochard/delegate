---
description: Discard a delegate session's worktree and branch without merging
argument-hint: <session-id>
---

Call `delegate_reject` with `{ id: $ARGUMENTS }`. It drops the worktree and branch outright — your main tree was never touched, so there's no cleanup on that side. Tell the user which session got discarded.
