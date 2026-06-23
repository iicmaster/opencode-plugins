# Changelog

All notable changes to this project will be documented in this file.

## 0.1.0 - Unreleased

### Added

- Initial opencode plugin for Claude Code slash commands (`/oc:setup`, `/oc:review`, `/oc:adversarial-review`, `/oc:rescue`, `/oc:status`, `/oc:result`, `/oc:cancel`).
- Initial opencode plugin for Codex through a local MCP stdio server (`oc_setup`, `oc_status`, `oc_result`, `oc_cancel`, `oc_review`, `oc_adversarial_review`, `oc_rescue`).
- Shared companion runtime that delegates to `opencode run`, mapping read-only review to the opencode `plan` agent plus `--pure`, edits to the `build` agent, and enforcing a hard wrapper-side timeout because opencode has no run-timeout flag.
- Capability detection that gates flags on `opencode run --help` instead of an assumed opencode version.
- Safe-value validation for `--model` and `--session` so user-controlled values cannot be injected as opencode flags.
- Tests for runtime safety, plugin structure, and MCP setup behavior.
- Public open-source documentation describing the Antigravity-to-opencode mapping and the opencode-specific security model.
