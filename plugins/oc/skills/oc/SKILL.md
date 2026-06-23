---
name: oc
description: Use when Codex should delegate a review, adversarial review, bounded rescue task, setup check, status check, result lookup, or cancellation to the opencode CLI.
---

# OpenCode

Use this skill when the user asks Codex to use `opencode`, or opencode-backed review/rescue workflows.

## Invocation Contract

Prefer the MCP tools exposed by this plugin when they are available:

- `oc_setup`
- `oc_status`
- `oc_result`
- `oc_cancel`
- `oc_review`
- `oc_adversarial_review`
- `oc_rescue`

Use the script wrapper only as a fallback when MCP tools are not available.

Resolve commands relative to this skill directory. The wrapper script lives at:

```bash
node "<path-to-this-skill>/scripts/oc-codex.mjs" <command> "<raw arguments>"
```

Supported commands:

- `setup` checks whether `opencode` is available and supports run mode.
- `review` sends current git status and diff to opencode for read-only review.
- `adversarial-review` sends current git status and diff to opencode for a stricter review.
- `rescue` delegates a bounded task to opencode. The Codex MCP tool intentionally keeps opencode read-only (the `plan` agent) and does not expose dangerous permission-bypass flags.
- `status` shows recent opencode jobs for the current workspace.
- `result <job-id>` prints captured output for a job.
- `cancel <job-id>` cancels a queued or running job.

Examples:

```bash
node "<path-to-this-skill>/scripts/oc-codex.mjs" setup
node "<path-to-this-skill>/scripts/oc-codex.mjs" review "--base main security focus"
node "<path-to-this-skill>/scripts/oc-codex.mjs" rescue "--background --timeout 30s investigate the failing test"
node "<path-to-this-skill>/scripts/oc-codex.mjs" status
node "<path-to-this-skill>/scripts/oc-codex.mjs" result "<job-id>"
```

## Safety Rules

- Do not use shell interpolation for user text. Pass raw arguments through the wrapper.
- Do not pass edit-enabling or dangerous permission-bypass flags through Codex MCP. They are intentionally unavailable there.
- Prefer foreground mode for small bounded checks and background mode for long-running rescue work.
- Use short timeouts for smoke tests; the companion runtime enforces its own hard timeout (opencode has no run-timeout flag).
- Treat rescue as no-edit by default. File changes should happen only when the user explicitly asks for edits.
- Return companion stdout/stderr faithfully and distinguish opencode output from Codex conclusions.
