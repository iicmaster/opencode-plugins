---
description: Show running and recent opencode CLI jobs launched from Claude Code
argument-hint: "[job-id] [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc-companion.mjs" status "$ARGUMENTS"
```

Return stdout verbatim.
