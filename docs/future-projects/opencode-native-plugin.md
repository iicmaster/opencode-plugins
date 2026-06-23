# Future Project: OpenCode-Native Plugin Layer

This is not the current implementation scope.

The current project provides Claude Code and Codex adapters that invoke the opencode CLI (`opencode run`), similar in spirit to how `iicmaster/antigravity-plugins` lets Claude Code and Codex invoke the Antigravity CLI (`agy`).

Later, build a separate opencode-native plugin project using opencode's own extension points:

```text
.opencode/plugin/*.ts     opencode plugin hooks (event, tool.execute.before, etc.)
.opencode/command/*.md     custom opencode slash commands
.opencode/agent/*.md       custom opencode agents
opencode.json              MCP servers and config
```

Do not mix this future opencode-native layout into the current host-agent adapter plugin unless the project explicitly changes direction.
