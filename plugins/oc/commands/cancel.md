---
description: Cancel a running opencode CLI job launched from Claude Code
argument-hint: "[job-id] [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc-companion.mjs" cancel "$ARGUMENTS"
```

Return stdout verbatim.
