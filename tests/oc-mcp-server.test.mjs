import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "plugins", "oc", "scripts", "oc-mcp-server.mjs");

function writeFakeOpencode(binDir) {
  const fake = path.join(binDir, "opencode");
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env node
if (process.argv.includes("--help")) {
  console.log("run --agent --model --session --continue --pure --dangerously-skip-permissions");
  process.exit(0);
}
console.log("fake opencode invoked");
`,
    "utf8"
  );
  fs.chmodSync(fake, 0o755);
}

function createMcpClient(env) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oc-mcp-"));
  const child = spawn(process.execPath, [SERVER], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false
  });
  let nextId = 1;
  let buffer = "";
  const pending = new Map();
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
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
      const message = JSON.parse(line);
      const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        entry.resolve(message);
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  function request(method, params = {}) {
    const id = nextId;
    nextId += 1;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}. stderr: ${stderr}`));
      }, 5000);
      pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        }
      });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return promise;
  }

  function close() {
    child.kill("SIGTERM");
  }

  return { request, close };
}

test("opencode MCP server exposes setup as a callable tool", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-bin-"));
  writeFakeOpencode(binDir);
  const client = createMcpClient({
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`
  });

  try {
    const init = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" }
    });
    assert.equal(init.result.serverInfo.name, "oc");

    const tools = await client.request("tools/list");
    assert.ok(tools.result.tools.some((tool) => tool.name === "oc_setup"));

    const setup = await client.request("tools/call", {
      name: "oc_setup",
      arguments: {}
    });
    assert.match(setup.result.content[0].text, /opencode ready: yes/);
  } finally {
    client.close();
  }
});

test("opencode MCP rescue does not expose edit-enabling or permission-bypass flags", async () => {
  const client = createMcpClient(process.env);

  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" }
    });

    const tools = await client.request("tools/list");
    const rescue = tools.result.tools.find((tool) => tool.name === "oc_rescue");
    assert.ok(rescue);
    assert.ok(!Object.hasOwn(rescue.inputSchema.properties, "allowEdits"));
    assert.ok(!Object.hasOwn(rescue.inputSchema.properties, "dangerouslySkipPermissions"));
    assert.ok(!Object.hasOwn(rescue.inputSchema.properties, "model"));
    assert.ok(!Object.hasOwn(rescue.inputSchema.properties, "session"));

    const rejected = await client.request("tools/call", {
      name: "oc_rescue",
      arguments: { task: "inspect safely", dangerouslySkipPermissions: true }
    });
    assert.match(rejected.error.message, /unknown argument: dangerouslySkipPermissions/);
  } finally {
    client.close();
  }
});

test("flag-like task text cannot escalate permissions through the companion", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-bin-"));
  writeFakeOpencode(binDir);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-data-"));
  const client = createMcpClient({
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    CLAUDE_PLUGIN_DATA: dataDir
  });

  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" }
    });

    await client.request("tools/call", {
      name: "oc_rescue",
      arguments: { task: "investigate --allow-edits --dangerously-skip-permissions the bug" }
    });

    const jobsDir = path.join(dataDir, "state", "jobs");
    const jobFile = fs.readdirSync(jobsDir).find((file) => file.endsWith(".json"));
    const payload = JSON.parse(fs.readFileSync(path.join(jobsDir, jobFile), "utf8"));

    // The flag-like words stayed inside the task prompt and were never parsed
    // into CLI options, so the job remains read-only with no permission bypass.
    assert.equal(payload.runOptions.sandbox, true);
    assert.equal(payload.runOptions.dangerouslySkipPermissions, false);
    assert.match(payload.runOptions.prompt, /--allow-edits/);
  } finally {
    client.close();
  }
});
