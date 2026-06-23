---
description: Check whether the opencode CLI is installed and ready for Claude Code delegation
argument-hint: "[--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(opencode:*)
---

Check the local `opencode` runtime through the shared companion script.

Raw slash-command arguments:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc-companion.mjs" setup "$ARGUMENTS"
```

Return stdout verbatim. Do not paraphrase or add commentary.
