---
description: Check the delegate environment (opencode installed, git repo present, server reachable, orphaned worktrees)
---

Call `delegate_doctor` with no arguments and walk the user through what it found:

- `gitRepo: false` — this directory needs `git init` before delegate can do anything; worktree isolation depends on it.
- `opencodeServer.reachable: false` — opencode is probably missing or not on `PATH`. Show the error from the report.
- `orphanedWorktrees` non-empty — worktrees sitting under `.delegate-worktrees/` with no session state to match, most likely left behind by a crash. You can offer to clean each one up with `git worktree remove --force <path>`, but check with the user first — it's destructive and the files might still matter to them.
- `activeSessions` — just a count, how many delegate sessions currently exist in this repo.
