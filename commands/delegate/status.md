---
description: Show delegate session status, iteration count, and opencode cost/tokens spent
argument-hint: "[session-id]"
---

Call `delegate_status` with `{ id: $ARGUMENTS }` if an id was given, or with no `id` to list everything in this repo.

Lay it out as a compact table: id, task (truncated), status, iteration/maxIterations, cost, files changed (pull that from the last verification's diff if it's already at hand, otherwise call `delegate_diff` for whichever sessions the user is asking about specifically). Flag any session sitting in `needs-human` — that one's waiting on a person, not another automatic pass.
