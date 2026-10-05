---
description: Ask a read-only evidence question; Antigravity (agy) gathers findings and each quote is re-checked against the files
argument-hint: "<question>"
---

Call `delegate_gather` with `{ question: $ARGUMENTS }`. Add `paths` if the user named files or directories to scope it to.

Present the result:

- **Verified findings** — one per line as `path:line: claim`, using `actualLine` when it differs from `line`.
- **Rejected findings** — list them separately and say they were dropped, with each `reason`. Never act on or repeat a rejected finding as fact.
- **Unknowns** — whatever the gatherer could not establish.
- **Usage** — state the token usage (`usage.total_tokens`) and `durationSeconds`.

If the tool returns an error (agy missing, not signed in, or a denied action), show the message as is and suggest `/delegate:doctor`.
