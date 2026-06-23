import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "oc");

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

test("marketplace metadata exposes the oc Claude Code plugin", () => {
  const marketplace = readJson(".claude-plugin/marketplace.json");
  const plugin = marketplace.plugins.find((entry) => entry.name === "oc");

  assert.equal(marketplace.name, "claude-code-oc");
  assert.equal(plugin.source, "./plugins/oc");
  assert.match(plugin.description, /opencode/i);
});

test("plugin metadata lives in the Claude plugin location", () => {
  const manifest = readJson("plugins/oc/.claude-plugin/plugin.json");

  assert.equal(manifest.name, "oc");
  assert.match(manifest.description, /Claude Code/i);
  assert.match(manifest.description, /opencode/i);
});

test("Codex marketplace exposes the oc plugin from the repo plugin path", () => {
  const marketplace = readJson(".agents/plugins/marketplace.json");
  const plugin = marketplace.plugins.find((entry) => entry.name === "oc");

  assert.equal(marketplace.name, "opencode-plugins");
  assert.equal(plugin.source.source, "local");
  assert.equal(plugin.source.path, "./plugins/oc");
  assert.equal(plugin.policy.installation, "AVAILABLE");
  assert.equal(plugin.policy.authentication, "ON_INSTALL");
  assert.equal(plugin.category, "Coding");
});

test("Codex plugin manifest is present and points at shared skills", () => {
  const manifest = readJson("plugins/oc/.codex-plugin/plugin.json");

  assert.equal(manifest.name, "oc");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.match(manifest.description, /Codex/i);
  assert.match(manifest.description, /opencode/i);
  assert.equal(manifest.interface.displayName, "OpenCode");
  assert.ok(manifest.interface.capabilities.includes("Interactive"));
});

test("Codex MCP config uses the local opencode stdio server", () => {
  const mcp = readJson("plugins/oc/.mcp.json");

  assert.equal(mcp.mcpServers.oc.command, "bash");
  assert.equal(mcp.mcpServers.oc.args[0], "-lc");
  assert.match(mcp.mcpServers.oc.args[1], /CLAUDE_PLUGIN_ROOT/);
  assert.match(mcp.mcpServers.oc.args[1], /CODEX_PLUGIN_ROOT/);
  assert.doesNotMatch(mcp.mcpServers.oc.args[1], /\/home\/|iicmaster/);
  assert.match(mcp.mcpServers.oc.args[1], /\.codex\/plugins\/cache/);
  assert.match(mcp.mcpServers.oc.args[1], /plugins\/oc\/scripts\/oc-mcp-server\.mjs/);
  assert.match(mcp.mcpServers.oc.args[1], /oc-mcp-server\.mjs/);
});

test("package metadata is ready for public open-source release", () => {
  const manifest = readJson("package.json");

  assert.equal(manifest.private, false);
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.repository.url, "git+https://github.com/iicmaster/opencode-plugins.git");
  assert.match(manifest.description, /open-source/i);
});

test("developer preview docs state local opencode prerequisites and known auth failure", () => {
  const readme = readText("README.md");

  assert.match(readme, /Developer Preview/i);
  assert.match(readme, /working local opencode CLI \(`opencode`\)/i);
  assert.match(readme, /not a general-availability hosted product/i);
  assert.match(readme, /opencode auth login/i);
});

test("npm payload excludes repo guidance and local workflow state", () => {
  const npmIgnore = readText(".npmignore");

  assert.match(npmIgnore, /^AGENTS\.md$/m);
  assert.match(npmIgnore, /^_bmad\/$/m);
  assert.match(npmIgnore, /^\.omx\/$/m);
  assert.match(npmIgnore, /^plugin-data\/$/m);
  assert.match(npmIgnore, /^\.oc-state\/$/m);
  assert.doesNotMatch(npmIgnore, /^\.agents\/$/m);
});

test("Claude commands route through the shared oc companion script", () => {
  const commands = [
    "setup",
    "review",
    "adversarial-review",
    "rescue",
    "status",
    "result",
    "cancel"
  ];

  for (const command of commands) {
    const source = readText(`plugins/oc/commands/${command}.md`);
    assert.match(source, /oc-companion\.mjs/, `${command} should use the companion runtime`);
    assert.doesNotMatch(source, /plugin\.json/, `${command} should not describe an opencode-native plugin`);
  }
});

test("future opencode-native plugin work is documented outside the current plugin", () => {
  assert.ok(fs.existsSync(path.join(ROOT, "docs", "future-projects", "opencode-native-plugin.md")));
  assert.ok(!fs.existsSync(path.join(PLUGIN_ROOT, "plugin.json")));
});

test("rescue prompt defaults to no file edits unless explicitly requested", () => {
  const rescuePrompt = readText("plugins/oc/prompts/rescue.md");
  assert.match(rescuePrompt, /Do not modify files unless the task explicitly asks for file changes/i);
});

test("review prompts instruct opencode to stay read-only", () => {
  for (const name of ["review", "adversarial-review"]) {
    const prompt = readText(`plugins/oc/prompts/${name}.md`);
    assert.match(prompt, /read-only/i);
    assert.match(prompt, /Do not edit files/i);
  }
});

test("Codex-facing skill routes through the local wrapper instead of Claude-only env vars", () => {
  const codexSkill = readText("plugins/oc/skills/oc/SKILL.md");
  const wrapper = readText("plugins/oc/skills/oc/scripts/oc-codex.mjs");

  assert.match(codexSkill, /oc-codex\.mjs/);
  assert.doesNotMatch(codexSkill, /CLAUDE_PLUGIN_ROOT/);
  assert.match(wrapper, /oc-companion\.mjs/);
  assert.match(wrapper, /shell:\s*false/);
});
