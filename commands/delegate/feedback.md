---
description: Send another instruction to a delegate session's opencode worker and re-verify
argument-hint: <session-id> <feedback message>
---

$ARGUMENTS is `<session-id> <feedback message>` — the first token is the id, everything after is the message.

Call `delegate_feedback` with `{ id, message }`. Treat what comes back exactly like a fresh `delegate_start` result: read `verification` and `diff` yourself rather than taking opencode's word that it's fixed. Report the new status and iteration count — and if it landed on `needs-human`, say clearly that the iteration cap was hit.
