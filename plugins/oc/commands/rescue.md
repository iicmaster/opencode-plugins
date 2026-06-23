---
description: Delegate investigation or a bounded fix request from Claude Code to the opencode CLI
argument-hint: "[--wait|--background] [--timeout <duration>] [--allow-edits] [--dangerously-skip-permissions] [--model <provider/model>] [task]"
allowed-tools: Bash(node:*), Agent, AskUserQuestion
---

Delegate the user request to the `opencode` companion runtime.

Raw user request:
`$ARGUMENTS`

Rules:
- Preserve the user task text.
- Rescue is read-only by default (opencode `plan` agent). Pass `--allow-edits` only when the user wants opencode to edit files (switches to the `build` agent).
- Leave `--dangerously-skip-permissions` unset unless the user explicitly requested it.
- Prefer foreground for small bounded tasks and background for long-running rescue work.
- Return the companion stdout verbatim.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc-companion.mjs" rescue "$ARGUMENTS"
```
