---
name: oc-cli-runtime
description: Internal helper contract for invoking the opencode CLI from Claude Code and Codex plugin adapters
user-invocable: false
---

# OpenCode Runtime

Use the shared companion from plugin adapters:

```bash
node "<plugin-root>/scripts/oc-companion.mjs" <command> "<raw arguments>"
```

Safety rules:
- Call `opencode` through Node `spawn` argv arrays, not shell-interpolated strings.
- Use `opencode run` for non-interactive runs and pipe the prompt through child stdin.
- Do not pass the prompt as a positional argv item; `opencode run` reads the prompt from stdin when no positional message is given, which also keeps it off the process command line.
- Map read-only review to the opencode `plan` agent; only switch to the `build` agent when edits are explicitly requested.
- opencode has no run-timeout flag, so the runtime enforces a hard wrapper-side timeout and kills the child on expiry.
- Add `--dangerously-skip-permissions` only when explicitly requested and only when the local opencode build supports it.
- Keep logs and state under `CLAUDE_PLUGIN_DATA` when available; otherwise use the runtime fallback outside the source checkout.
- Keep host adapters thin and share process execution behavior through the companion/runtime.
