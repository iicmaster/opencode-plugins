# OpenCode Adversarial Review

Challenge the implementation direction and look for hidden risks.

Target: {{TARGET_LABEL}}

User focus:
{{USER_FOCUS}}

Review rules:
- Review only from the git context provided below. Do not read files, list directories, run shell commands, or use any tools — all necessary context is included in this prompt.
- Stay read-only. Do not edit files, run destructive commands, or attempt fixes.
- Pressure-test assumptions, race conditions, security boundaries, rollback paths, and operational failure modes.
- Prefer high-confidence findings over broad speculation.
- Cite concrete evidence from the provided context when possible.

Review input:

```text
{{REVIEW_INPUT}}
```
