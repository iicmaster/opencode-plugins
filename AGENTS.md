# Project Instructions

## Scope
- This file governs the repository from this directory downward.

## Commands
- `npm test` - Run the Node test suite.
- `npm run validate` - Alias for `npm test`.
- `node plugins/oc/scripts/oc-companion.mjs setup` - Check local opencode runtime support.

## Architecture
- `plugins/oc/scripts/lib/oc-runtime.mjs` owns opencode process execution, safe argv construction, state, worker launch, and cancellation helpers.
- `plugins/oc/scripts/lib/git-context.mjs` and `prompts.mjs` are backend-agnostic and shared verbatim with the upstream Antigravity plugin contract.
- `plugins/oc/commands/` and `plugins/oc/skills/oc/` are host adapters; keep them thin and do not duplicate runtime behavior there.
- Prompt text for `opencode run` is piped through stdin, not passed as a positional argv item.

## opencode Mapping Invariants
- opencode has no `--print-timeout`; the runtime enforces a hard wrapper-side timeout and kills the child on expiry.
- Read-only review maps to the opencode `plan` agent plus `--pure`; edits map to the `build` agent. There is no process-level sandbox flag.
- `--add-dir` and `--log-file` have no opencode equivalent and are intentionally not emitted; the runtime captures stdout/stderr to its own job log.
- User-controlled `--model` / `--session` values must pass the safe-value pattern (no leading `-`) so they cannot be injected as flags.
- Capability flags are gated on parsing `opencode run --help`; do not hardcode flag support against an assumed opencode version.
- Write only opencode stdout to the job result file; stderr (log noise) goes to the job log only.

## Workflow
- Stage only intended source/docs files. Do not commit local workflow or runtime folders such as `.agent/`, `.claude/`, `.agents/skills/`, `_bmad/`, `.omx/`, `plugin-data/`, or `.oc-state/`.
- Keep Claude and Codex behavior shared through the companion/runtime unless host contracts truly require separate implementation.
- Treat command construction, permission flags, and MCP argument validation as security-sensitive.

## Verification
- Run `git diff --check` before committing.
- Run `npm test` for code, runtime, plugin metadata, or command behavior changes.
- Smoke-test Claude Code or Codex installs when changing host install flow, commands, MCP config, or setup behavior.
