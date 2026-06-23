# OpenCode Agent Plugins

Open-source Claude Code and Codex plugin adapters that delegate review and rescue workflows to the opencode CLI (`opencode`).

This repository does not implement opencode itself. It wraps a locally installed `opencode` binary so another coding agent can ask opencode for a second review, adversarial pass, or bounded rescue task.

## Status

Developer Preview. This project is ready for developers who already have a working local opencode CLI (`opencode`) and want Claude Code or Codex adapters for review and rescue workflows.

It is not a general-availability hosted product. Users still need a local opencode install with an authenticated provider, a usable model, and the host agent they plan to install into.

## What Is Included

- Claude Code plugin marketplace metadata in `.claude-plugin/`.
- Codex plugin marketplace metadata in `.agents/plugins/`.
- One plugin, `plugins/oc`, with Claude slash commands and a Codex MCP server.
- Shared Node.js runtime scripts for launching, tracking, reading, and cancelling opencode jobs.
- A focused Node test suite for runtime safety, plugin structure, and MCP behavior.

## Architecture Overview

The current design is one opencode domain plugin with host-specific adapters around a shared runtime core:

- Claude Code uses marketplace metadata plus slash commands.
- Codex uses marketplace metadata plus a skill and local MCP server.
- Both hosts call the same companion/runtime scripts for command parsing, job state, cancellation, and `opencode run` execution.

Keep Claude/Codex adapters thin. Do not split the runtime into separate Claude and Codex copies unless the host contracts diverge enough that sharing creates more risk than duplication.

### Mapping from the Antigravity (`agy`) plugin

This repository mirrors [`antigravity-plugins`](https://github.com/iicmaster/antigravity-plugins) but swaps the delegated backend from `agy --print` to `opencode run`:

| Concept | Antigravity (`agy`) | opencode |
| --- | --- | --- |
| Non-interactive run | `agy --print` | `opencode run` |
| Prompt transport | piped via child stdin | piped via child stdin (verified: `opencode run` reads stdin when no positional message is given) |
| Read-only review | `--sandbox` | read-only `plan` agent + `--pure` + prompt-level read-only constraints |
| Allow edits | default / explicit | `build` agent (`--allow-edits` on rescue) |
| Run timeout | `--print-timeout` | none in opencode; enforced as a hard wrapper-side timeout |
| Continue / session | `--continue` / `--conversation` | `--continue` / `--session` |
| Permission bypass | `--dangerously-skip-permissions` | `--dangerously-skip-permissions` (gated on detected support, never default) |

## Requirements

- Node.js 18.18 or newer.
- Git.
- A working opencode CLI named `opencode` on your `PATH`, with an authenticated provider and a configured model.
- Claude Code or Codex, depending on which adapter you want to use.

`setup` verifies the binary and the flags this plugin needs (`run`, `--agent`, `--model`, `--session`, `--continue`). Actual delegation still depends on your local opencode authentication and model configuration.

## AI-Assisted Installation

The quickest path is to paste this repository URL into Claude Code or Codex and ask that host agent to install the plugin for you:

```text
https://github.com/iicmaster/opencode-plugins
```

Example prompt for Claude Code:

```text
Install the opencode plugin from https://github.com/iicmaster/opencode-plugins into this Claude Code session. Use the Claude plugin marketplace flow, reload plugins, then run /oc:setup. If you cannot run plugin commands directly, show me the exact manual commands.
```

Example prompt for Codex:

```text
Install the opencode plugin from https://github.com/iicmaster/opencode-plugins into this Codex setup. Use the Codex plugin marketplace flow, verify codex mcp list, then run the oc_setup MCP check if available. If you cannot install directly, show me the exact manual commands.
```

The requirements above still apply, especially Node.js, Git, a local `opencode` binary on your `PATH`, and the host agent you are installing into. This repository installs a host plugin adapter; it does not provide hosted opencode access or bypass local permission policies.

## Install In Claude Code

Add this repository as a Claude Code plugin marketplace, then install the `oc` plugin from it:

```text
/plugin marketplace add https://github.com/iicmaster/opencode-plugins
/plugin install oc@claude-code-oc
/reload-plugins
/oc:setup
```

For local development, replace the GitHub URL with your local checkout path.

### Claude Commands

- `/oc:setup` checks whether `opencode` is installed and exposes the flags this plugin needs.
- `/oc:review` sends the current git context to `opencode` for read-only review.
- `/oc:adversarial-review` sends a stricter review prompt focused on hidden risks.
- `/oc:rescue` delegates a bounded investigation or fix request to `opencode`.
- `/oc:status`, `/oc:result`, and `/oc:cancel` manage jobs launched by the companion runtime.

## Install In Codex

Add this repository as a Codex plugin marketplace, install the `oc` plugin, then confirm the MCP server is visible:

```bash
codex plugin marketplace add https://github.com/iicmaster/opencode-plugins
codex plugin add oc@opencode-plugins
codex mcp list
```

For interactive Codex sessions, ask Codex to use an opencode MCP tool such as `oc_setup`, `oc_review`, or `oc_rescue`. A safe install smoke test is:

```bash
codex exec -C <repo-path> --ephemeral \
  'Use the opencode MCP tool oc_setup. Do not modify files. Reply with the exact tool output.'
```

If your non-interactive Codex policy cannot approve MCP tools, verify the local runtime directly instead of disabling sandbox protections just for installation testing:

```bash
node plugins/oc/scripts/oc-companion.mjs setup
```

## Troubleshooting

### Authentication or provider error

If setup succeeds but a review or rescue reports an authentication or provider error, configure opencode once through your local install:

```bash
opencode auth login
```

Then set a default model (for example in `~/.config/opencode/opencode.json`) and rerun the opencode command. The plugin can verify that the binary and flags exist, but it cannot authenticate an opencode provider for you.

### Timed-out jobs

opencode has no run-timeout flag, so this plugin enforces a hard wrapper-side timeout and kills the child on expiry. If a timed-out job leaves stray opencode processes, you can clean them up manually:

```bash
pkill -f "opencode run"
```

### Multiple Installed Copies

If behavior does not match the current checkout after reinstalling, verify which marketplace or plugin cache your host is loading. Claude Code and Codex may keep their own installed plugin copies, so updating a source checkout does not always update the active host install.

## Repository Layout

```text
.agents/plugins/                  Codex marketplace metadata
.claude-plugin/                   Claude Code marketplace metadata
docs/                             Architecture and future project notes
plugins/oc/                       The opencode plugin
plugins/oc/.claude-plugin/        Claude plugin manifest
plugins/oc/.codex-plugin/         Codex plugin manifest
plugins/oc/.mcp.json              Codex MCP launcher config
plugins/oc/commands/              Claude Code slash commands
plugins/oc/skills/oc/             Codex-facing skill instructions and wrapper
plugins/oc/prompts/               Shared review/rescue prompt templates
plugins/oc/scripts/               Shared companion, worker, MCP server, and runtime libraries
tests/                            Node.js test suite
```

### Tracked Source vs Local Development Installs

The tracked plugin contract is the marketplace metadata, `plugins/oc`, `docs`, tests, and package metadata. Local BMAD, Claude, Codex, OMX, and agent skill installs are intentionally ignored by git; they are workspace tooling state, not part of the public plugin contract.

## Development

```bash
npm test
node plugins/oc/scripts/oc-companion.mjs setup
node plugins/oc/scripts/oc-companion.mjs setup --json
node plugins/oc/scripts/oc-mcp-server.mjs
```

The runtime stores job state under `CLAUDE_PLUGIN_DATA/state` when Claude Code provides that environment variable. Outside Claude Code it falls back to `/tmp/oc-companion/<workspace-hash>/`.

## Developer Preview Release Gate

The current developer-preview gate is:

- Node.js 18.18 or newer.
- Local Unix-like shell environment for the Codex MCP launcher.
- Local `opencode` binary exposing `run`, `--agent`, `--model`, `--session`, and `--continue` flags.
- `npm test`.
- `node plugins/oc/scripts/oc-companion.mjs setup --json`.
- Fresh Claude Code and Codex host install smoke tests before tagging a release.

## Security Model

- `opencode` is spawned with `shell: false` from runtime code.
- User prompt text is piped through child stdin in run mode, not passed through argv or shell-interpolated command text.
- Read-only review runs opencode with the read-only `plan` agent (which denies file edits), `--pure` (no external/project plugins run), and prompt-level read-only constraints. opencode has no OS-level process sandbox equivalent to the Antigravity `--sandbox` flag, so review isolation is enforced by agent policy and prompt, not by process containment. Do not run review or rescue against code you do not trust.
- A reviewed repository's `opencode.json` / `.opencode/` can change opencode's agent permissions for that working directory. `--pure` disables external plugins, but treat untrusted repositories with caution.
- User-supplied `--model` and `--session` values are validated and may not begin with `-`, so they cannot be injected as opencode flags.
- `--dangerously-skip-permissions` is never enabled unless explicitly requested, is gated on whether the local opencode build advertises it, and is not exposed through the Codex MCP rescue tool.
- Job state is written outside the repository by default.

## Limitations

- This is a wrapper around a local `opencode` binary. It does not provide hosted opencode access.
- opencode authentication, availability, and model behavior are controlled by the user's local opencode installation.
- opencode has no OS-level sandbox; read-only behavior is enforced by the `plan` agent, `--pure`, and prompt constraints.
- The Codex MCP adapter is local to this plugin. A standalone shared MCP package may be extracted later if the tool contract stabilizes.
- The current release targets Unix-like shells for the Codex MCP launcher.

## License

MIT. See [LICENSE](LICENSE).
