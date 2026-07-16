---
description: Merge a delegate session's worktree branch into the current branch and clean up
argument-hint: <session-id>
---

The user wants this session's work landed. Before you do it:

1. Call `delegate_status` with `{ id: $ARGUMENTS }`. If `status` isn't `ready-to-accept`, say so — still `running`, or `needs-human` because verification never came back clean — and check the user still wants to go ahead. That's their call; you're just making sure they're not merging blind.
2. Call `delegate_diff` with `{ id: $ARGUMENTS }` and give the diff one more read if it's been a while since you last looked.
3. Call `delegate_accept` with `{ id: $ARGUMENTS }`. This merges the branch, removes the worktree, and clears the session state. Delegate itself can't undo this afterward — though it's an ordinary merge commit, so normal git tooling still applies if the user wants to back it out later.

Tell the user which branch got merged.
