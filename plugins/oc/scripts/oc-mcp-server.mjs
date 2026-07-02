#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const COMPANION = path.join(PLUGIN_ROOT, "scripts", "oc-companion.mjs");
const GO_DURATION_PATTERN = /^(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+$/;
const SAFE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@-]{0,127}$/;
const SAFE_JOB_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Mirror the companion's SAFE_VALUE_PATTERN: a model value must start with an
// alphanumeric so it can never be reparsed as an opencode flag (e.g. "-x"), and
// must be bounded and free of whitespace. Allows ids like "zai-coding-plan/glm-5.2".
const SAFE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,127}$/;

const tools = [
  {
    name: "oc_setup",
    description: "Check whether the opencode CLI is available for Codex and supports run mode.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  },
  {
    name: "oc_status",
    description: "Show recent or matching opencode jobs for the current workspace.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        jobId: { type: "string", description: "Optional full or unique opencode job id prefix." }
      }
    }
  },
  {
    name: "oc_result",
    description: "Read captured output for an opencode job.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        jobId: { type: "string", description: "Optional full or unique opencode job id prefix. Defaults to latest job." }
      }
    }
  },
  {
    name: "oc_cancel",
    description: "Cancel a queued or running opencode job.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["jobId"],
      properties: {
        jobId: { type: "string", description: "Full or unique opencode job id prefix." }
      }
    }
  },
  {
    name: "oc_review",
    description: "Ask opencode to review the current git worktree or a branch diff (read-only plan agent).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        focus: { type: "string", description: "Optional review focus." },
        base: { type: "string", description: "Optional base ref for git diff base...HEAD." },
        model: { type: "string", description: "Optional opencode model id such as zai-coding-plan/glm-5.2." },
        timeout: { type: "string", description: "Go duration such as 30s or 10m0s." },
        background: { type: "boolean", description: "Run opencode in the background." }
      }
    }
  },
  {
    name: "oc_adversarial_review",
    description: "Ask opencode for a stricter adversarial review of the current git worktree or branch diff (read-only plan agent).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        focus: { type: "string", description: "Optional adversarial review focus." },
        base: { type: "string", description: "Optional base ref for git diff base...HEAD." },
        model: { type: "string", description: "Optional opencode model id such as zai-coding-plan/glm-5.2." },
        timeout: { type: "string", description: "Go duration such as 30s or 10m0s." },
        background: { type: "boolean", description: "Run opencode in the background." }
      }
    }
  },
  {
    name: "oc_rescue",
    description: "Delegate a bounded task to opencode. Runs read-only by default; the Codex MCP tool does not expose edit-enabling or permission-bypass flags.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["task"],
      properties: {
        task: { type: "string", description: "Bounded opencode task text." },
        timeout: { type: "string", description: "Go duration such as 30s or 10m0s." },
        background: { type: "boolean", description: "Run opencode in the background." }
      }
    }
  }
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function assertObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("arguments must be an object");
  }
  return value;
}

function rejectUnknown(args, allowed) {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new Error(`unknown argument: ${key}`);
    }
  }
}

function optionalString(args, key, { max = 4000, pattern = null } = {}) {
  if (args[key] == null) {
    return null;
  }
  if (typeof args[key] !== "string") {
    throw new Error(`${key} must be a string`);
  }
  const value = args[key].trim();
  if (!value) {
    return null;
  }
  if (value.length > max) {
    throw new Error(`${key} is too long`);
  }
  if (pattern && !pattern.test(value)) {
    throw new Error(`${key} contains unsupported characters`);
  }
  return value;
}

function requiredString(args, key, options = {}) {
  const value = optionalString(args, key, options);
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function optionalBoolean(args, key) {
  if (args[key] == null) {
    return false;
  }
  if (typeof args[key] !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return args[key];
}

function optionalDuration(args) {
  const timeout = optionalString(args, "timeout", { max: 32 });
  if (timeout && !GO_DURATION_PATTERN.test(timeout)) {
    throw new Error("timeout must be a Go duration such as 30s or 10m0s");
  }
  return timeout;
}

function addCommonRunArgs(argv, args) {
  const timeout = optionalDuration(args);
  const model = optionalString(args, "model", { max: 128, pattern: SAFE_MODEL_PATTERN });
  if (optionalBoolean(args, "background")) {
    argv.push("--background");
  }
  if (timeout) {
    argv.push("--timeout", timeout);
  }
  // Emitted before any "--" terminator so the companion parses it as a flag,
  // never as positional prompt text.
  if (model) {
    argv.push("--model", model);
  }
}

function runCompanion(command, argv = []) {
  const result = spawnSync(process.execPath, [COMPANION, command, ...argv], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    shell: false
  });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return {
    content: [{ type: "text", text: text || "(no output)\n" }],
    isError: Boolean(result.error) || result.status !== 0
  };
}

function jobArg(args, required = false) {
  const value = required
    ? requiredString(args, "jobId", { max: 128, pattern: SAFE_JOB_PATTERN })
    : optionalString(args, "jobId", { max: 128, pattern: SAFE_JOB_PATTERN });
  return value ? [value] : [];
}

function reviewArgs(args) {
  rejectUnknown(args, ["focus", "base", "model", "timeout", "background"]);
  const argv = [];
  addCommonRunArgs(argv, args);
  const base = optionalString(args, "base", { max: 128, pattern: SAFE_REF_PATTERN });
  if (base) {
    argv.push("--base", base);
  }
  const focus = optionalString(args, "focus", { max: 4000 });
  if (focus) {
    // "--" terminator: the companion treats everything after it as positional
    // text, so flag-like focus text cannot be reparsed into CLI options.
    argv.push("--", focus);
  }
  return argv;
}

function rescueArgs(args) {
  // Intentionally omits "model": rescue via the MCP tool stays minimal and
  // locked down. Model selection is a review-panel concern (oc_review only).
  rejectUnknown(args, ["task", "timeout", "background"]);
  const argv = [];
  addCommonRunArgs(argv, args);
  // "--" terminator keeps flag-like task text from being reparsed into options.
  argv.push("--", requiredString(args, "task", { max: 8000 }));
  return argv;
}

function callTool(name, rawArgs = {}) {
  const args = assertObject(rawArgs);
  switch (name) {
    case "oc_setup":
      rejectUnknown(args, []);
      return runCompanion("setup");
    case "oc_status":
      rejectUnknown(args, ["jobId"]);
      return runCompanion("status", jobArg(args));
    case "oc_result":
      rejectUnknown(args, ["jobId"]);
      return runCompanion("result", jobArg(args));
    case "oc_cancel":
      rejectUnknown(args, ["jobId"]);
      return runCompanion("cancel", jobArg(args, true));
    case "oc_review":
      return runCompanion("review", reviewArgs(args));
    case "oc_adversarial_review":
      return runCompanion("adversarial-review", reviewArgs(args));
    case "oc_rescue":
      return runCompanion("rescue", rescueArgs(args));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handle(message) {
  const { id, method, params } = message;
  if (id == null) {
    return;
  }
  try {
    switch (method) {
      case "initialize":
        sendResult(id, {
          protocolVersion: params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "oc", version: "0.1.0" }
        });
        break;
      case "ping":
        sendResult(id, {});
        break;
      case "tools/list":
        sendResult(id, { tools });
        break;
      case "tools/call":
        sendResult(id, callTool(params?.name, params?.arguments ?? {}));
        break;
      default:
        sendError(id, -32601, `Method not found: ${method}`);
        break;
    }
  } catch (error) {
    sendError(id, -32602, error instanceof Error ? error.message : String(error));
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline === -1) {
      break;
    }
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) {
      continue;
    }
    try {
      void handle(JSON.parse(line));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
});
