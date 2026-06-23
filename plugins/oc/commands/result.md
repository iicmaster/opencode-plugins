---
description: Show the captured result for a completed opencode CLI job
argument-hint: "[job-id] [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc-companion.mjs" result "$ARGUMENTS"
```

Return stdout verbatim.
