---
description: Re-run verification for a delegate session without sending new work to opencode
argument-hint: <session-id>
---

Call `delegate_review` with `{ id: $ARGUMENTS }`. It just re-checks the worktree as it currently sits — no new instructions go to opencode. Handy after the user (or you) poked at the worktree by hand, or to re-run a flaky check.

Judge the result the same way you would for `/delegate`: read the diff and verification output yourself, don't just relay the exit code.
