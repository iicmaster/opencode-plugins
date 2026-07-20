---
description: Delegate investigation or a bounded fix request from Claude Code to the opencode CLI
argument-hint: "[--wait|--background] [--timeout <duration>] [--allow-edits] [--dangerously-skip-permissions] [--model <id|alias>] [task]"
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
- Model selection: `--model` accepts a full id or an alias (`kimi`, `glm`); `OC_MODEL` is the default when `--model` is absent. Validation against `opencode models` is warn-only.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc-companion.mjs" rescue "$ARGUMENTS"
```
