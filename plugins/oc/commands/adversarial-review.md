---
description: Ask the opencode CLI to challenge the implementation and hunt for hidden risks
argument-hint: "[--wait|--background] [--base <ref>] [--timeout <duration>] [--model <provider/model>] [focus text]"
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a steerable adversarial review through `opencode`.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraints:
- This command is review-only. It runs opencode with the read-only `plan` agent.
- Focus on bugs, regressions, security risks, rollback hazards, and weak assumptions.
- Return the companion stdout verbatim to the user.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc-companion.mjs" adversarial-review "$ARGUMENTS"
```

For background execution, use the same command with `--background` and do not poll in the same turn.
