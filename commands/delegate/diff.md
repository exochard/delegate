---
description: Show a delegate session's current git diff
argument-hint: <session-id>
---

Call `delegate_diff` with `{ id: $ARGUMENTS }` and show the user the patch. If `truncated` comes back true, flag it and mention the full size — don't let the user think they're looking at the whole thing when they're not.
