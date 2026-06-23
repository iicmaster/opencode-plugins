# Architecture

## Direction

The current product is a set of host-agent adapters that invoke the opencode CLI (`opencode run`).

It is not an opencode-native plugin. The opencode-native plugin idea is documented separately in `docs/future-projects/opencode-native-plugin.md`.

## Runtime Flow

```text
Claude Code slash command
  -> plugins/oc/commands/*.md
  -> plugins/oc/scripts/oc-companion.mjs
  -> plugins/oc/scripts/lib/oc-runtime.mjs
  -> opencode run (prompt piped via stdin)
  -> job log/result/state
```

```text
Codex MCP tool
  -> plugins/oc/scripts/oc-mcp-server.mjs
  -> plugins/oc/scripts/oc-companion.mjs
  -> plugins/oc/scripts/lib/oc-runtime.mjs
  -> opencode run (prompt piped via stdin)
  -> job log/result/state
```

The companion script owns command parsing, prompt selection, job creation, and status/result/cancel behavior.

The runtime library owns safe `opencode` argv construction, capability detection, state storage, background worker launch, and cancellation helpers.

The Codex MCP server is intentionally thin: it validates structured tool arguments, converts them into companion argv arrays, and speaks newline-delimited JSON-RPC over stdio.

The Codex MCP launcher resolves the plugin root from `CODEX_PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`, a source checkout, or the local Codex plugin cache under `~/.codex/plugins/cache`. It must not contain machine-local absolute paths.

## opencode Backend Mapping

This plugin mirrors the Antigravity (`agy`) plugin contract but delegates to `opencode run`:

- `opencode run` reads the prompt from stdin when no positional message is given, so the prompt stays off the process command line (verified against opencode 1.1.x).
- opencode has no run-timeout flag, so `oc-runtime` enforces a hard wrapper-side timeout (`goDurationToMilliseconds` + `SIGTERM`/`SIGKILL`).
- Read-only review maps to the `plan` agent plus `--pure`; edits map to the `build` agent. There is no process sandbox flag.
- `--continue` and `--session` cover session continuity; `--model` is an optional passthrough.
- Capability flags are detected by parsing `opencode run --help`, never hardcoded against a version string.
- `--add-dir` and `--log-file` have no opencode equivalent and are not emitted; the runtime captures stdout/stderr to its own job log and writes only stdout to the job result file.

## Boundary

| Layer | Owns | Must Not Own |
| --- | --- | --- |
| Claude adapter | Slash-command metadata, raw argument handoff, Claude-facing command copy | opencode process semantics, job state schema, prompt transport decisions |
| Codex adapter | Skill instructions, MCP tool schemas, Codex-facing safety limits, local MCP launcher | Duplicate runtime behavior or host-specific copies of job lifecycle logic |
| Shared companion/runtime | Prompt construction, normalized run options, job files, state/result/cancel behavior, capability detection, `opencode run` invocation | Host marketplace policy, host UI copy, future opencode-native plugin layout |

Current decision: keep one shared runtime core with thin Claude and Codex adapters. A host-specific adapter may differ at the command or schema boundary, but process execution and job lifecycle behavior should stay shared until there is evidence that the host contracts truly require separate implementations.

## State

When `CLAUDE_PLUGIN_DATA` is available:

```text
$CLAUDE_PLUGIN_DATA/state/
  state.json
  jobs/
    <job-id>.json
    <job-id>.log
    <job-id>.prompt.md
    <job-id>.result.md
```

Outside Claude Code, the fallback is under `/tmp/oc-companion`.

## Security

- `opencode` is spawned with `shell: false`.
- User prompt text is piped through child stdin in run mode.
- User-controlled `--model` / `--session` values are validated and may not begin with `-`.
- Read-only review is enforced by the `plan` agent, `--pure`, and prompt constraints; opencode has no OS-level sandbox, so untrusted code must not be reviewed or rescued.
- `--dangerously-skip-permissions` is only added when explicitly requested and only when the local build advertises it.
- State falls outside the repository by default unless Claude Code supplies plugin data storage.
- Codex MCP tool arguments are schema-shaped and validated again inside the stdio server before reaching the companion runtime.

## MCP Decision

MCP is used as the Codex adapter because Codex can call MCP tools more reliably than it can infer plugin-local script paths from a skill.

This is still not a separate central MCP package. The local MCP server remains inside the `oc` plugin and reuses the same companion/runtime as Claude Code.

Extract a central standalone MCP server later when:

- The command set is stable.
- Result and cancellation semantics are proven.
- Multiple clients need the same state and tool contract.
- The tool schema needs versioning independent of the Claude slash-command surface.
- Sharing the in-repo runtime creates more compatibility risk than extracting a package.

Until then, keep `oc-runtime.mjs` as the shared core and keep host-specific adapters thin.
