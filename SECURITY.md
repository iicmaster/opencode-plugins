# Security Policy

## Supported Versions

The current `main` branch and latest tagged release receive security fixes.

## Reporting A Vulnerability

Please do not open a public issue for vulnerabilities, credential leaks, or permission-bypass bugs.

Use GitHub private vulnerability reporting when available:

```text
https://github.com/iicmaster/opencode-plugins/security/advisories/new
```

If private reporting is not available, contact the maintainer through the GitHub repository and keep details minimal until a private channel is established.

## Security Expectations

- No hardcoded secrets.
- Spawn `opencode` with argv arrays and `shell: false`; do not construct shell strings from user text.
- Pipe `opencode run` prompt text through child stdin; do not pass the prompt as a positional argv item or log it as part of the command line.
- Validate user-controlled `--model`, `--session`, and `--base` values (no leading `-`, bounded length) so they cannot be injected as opencode or git flags. The `--base` ref is validated before it reaches `git diff <base>...HEAD`, because a value beginning with `-` would otherwise be parsed by git as a flag such as `--output=FILE`.
- Keep review read-only through the opencode `plan` agent, `--pure`, and prompt-level read-only constraints. `--dangerously-skip-permissions` and edit-enabling behavior must remain explicit opt-ins and must not be exposed through the Codex MCP rescue tool.
- Validate MCP input before runtime execution and validate again inside the stdio server before invoking the companion runtime.
- Keep job state and logs outside the repository by default (`CLAUDE_PLUGIN_DATA/state` when provided, otherwise the runtime fallback outside the checkout).
- Error output should not expose local secrets, credentials, or full prompt text unless the user explicitly requested that diagnostic detail.

## Known Limitations Of The opencode Backend

- opencode has no OS-level process sandbox equivalent to the Antigravity `--sandbox` flag. Read-only review is enforced by agent policy (the `plan` agent denies edits), `--pure`, and prompt instructions — not by process containment. The opencode `plan` agent can still run shell and write new files unless the model honours the read-only prompt, so do not run review or rescue against code you do not trust.
- A reviewed repository's `opencode.json` / `.opencode/` can override agent permissions for that working directory. `--pure` disables external plugins, but project-level configuration in an untrusted repository remains a trust boundary.

Security fixes may be released without waiting for unrelated refactors or feature work.
