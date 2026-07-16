---
description: Get or set delegate's per-project config (default model, max iterations, verify command, worker permissions)
argument-hint: "[key=value ...]"
---

No `$ARGUMENTS`? Call `delegate_config_get` and show the current config.

Otherwise parse `$ARGUMENTS` as `key=value` pairs and map them onto `delegate_config_set`:

- `model=provider/model` → `defaultModel`
- `maxIterations=<n>` → `maxIterations` (integer)
- `verifyCommand=<command>` (quote it if it has spaces) → `verifyCommand`; `verifyCommand=none` clears the override back to auto-detect (pass `null`)
- `<permission>=true|false`, where `<permission>` is one of `bash, read, edit, glob, grep, webfetch, task, todowrite, websearch, lsp, skill` → merges into `workerPermissions`

Show the resulting config once it's set. If the user's turning on `webfetch`, `websearch`, or `task`, mention in passing that this gives the unattended worker more reach — network access, or the ability to spawn its own sub-tasks. Not a blocker, just worth them knowing.
