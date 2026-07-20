import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MODEL_ALIASES, resolveModel, unknownModelWarning } from "../plugins/oc/scripts/lib/models.mjs";
import { assertSafeModelValue, createJob, listOpencodeModels, loadState } from "../plugins/oc/scripts/lib/oc-runtime.mjs";

test("resolveModel resolves built-in aliases and passes full ids through", () => {
  assert.deepEqual(resolveModel("kimi", {}), { model: "kimi-for-coding/k3", aliasUsed: "kimi", source: "flag" });
  assert.deepEqual(resolveModel("kimi-k3", {}), { model: "kimi-for-coding/k3", aliasUsed: "kimi-k3", source: "flag" });
  assert.deepEqual(resolveModel("glm", {}), { model: "zai-coding-plan/glm-5.2", aliasUsed: "glm", source: "flag" });
  assert.deepEqual(resolveModel("glm-5.2", {}), { model: "zai-coding-plan/glm-5.2", aliasUsed: "glm-5.2", source: "flag" });
  assert.deepEqual(resolveModel("anthropic/claude-opus-4", {}), {
    model: "anthropic/claude-opus-4",
    aliasUsed: null,
    source: "flag"
  });
});

test("resolveModel treats unknown alias-shaped values as full ids", () => {
  assert.deepEqual(resolveModel("claude", {}), { model: "claude", aliasUsed: null, source: "flag" });
});

test("resolveModel prefers the flag over OC_MODEL and resolves aliases inside OC_MODEL", () => {
  const env = { OC_MODEL: "glm" };
  assert.deepEqual(resolveModel("kimi", env), { model: "kimi-for-coding/k3", aliasUsed: "kimi", source: "flag" });
  assert.deepEqual(resolveModel(null, env), { model: "zai-coding-plan/glm-5.2", aliasUsed: "glm", source: "env" });
});

test("resolveModel treats empty and whitespace-only values as unset", () => {
  const env = { OC_MODEL: " kimi " };
  assert.deepEqual(resolveModel("", env), { model: "kimi-for-coding/k3", aliasUsed: "kimi", source: "env" });
  assert.equal(resolveModel("   ", env).source, "env");
  assert.deepEqual(resolveModel(null, {}), { model: null, aliasUsed: null, source: null });
  assert.deepEqual(resolveModel(null, { OC_MODEL: "  " }), { model: null, aliasUsed: null, source: null });
});

test("unknownModelWarning warns only for unlisted models and never when the probe failed", () => {
  const models = new Set(["kimi-for-coding/k3"]);
  assert.equal(unknownModelWarning("kimi-for-coding/k3", models), null);
  assert.match(unknownModelWarning("acme/nope-1", models), /not listed by `opencode models`/);
  assert.equal(unknownModelWarning("acme/nope-1", null), null);
});

test("MODEL_ALIASES is frozen and contains only the built-in entries", () => {
  assert.equal(Object.isFrozen(MODEL_ALIASES), true);
  assert.deepEqual(Object.keys(MODEL_ALIASES).sort(), ["glm", "glm-5.2", "kimi", "kimi-k3"]);
});

function writeFakeOpencode(binDir, script) {
  fs.mkdirSync(binDir, { recursive: true });
  const fake = path.join(binDir, "opencode");
  fs.writeFileSync(fake, script, "utf8");
  fs.chmodSync(fake, 0o755);
  return fake;
}

function probeEnv(binDir) {
  return { ...process.env, OC_MODEL: "", PATH: `${binDir}${path.delimiter}${process.env.PATH}` };
}

test("assertSafeModelValue accepts ids and aliases but rejects flag-like values", () => {
  assert.equal(assertSafeModelValue("kimi-for-coding/k3"), "kimi-for-coding/k3");
  assert.equal(assertSafeModelValue("kimi"), "kimi");
  assert.throws(() => assertSafeModelValue("-evil"), /model contains unsupported characters/);
  assert.throws(() => assertSafeModelValue("bad value"), /model contains unsupported characters/);
});

test("listOpencodeModels parses a colorized, multi-segment listing into an id set", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oc-models-"));
  const binDir = path.join(cwd, "bin");
  writeFakeOpencode(binDir, `#!/usr/bin/env node
process.stdout.write("\\u001b[32mzai-coding-plan/glm-5.2\\u001b[0m\\nkimi-for-coding/k3\\ncloudflare-ai-gateway/workers-ai/@cf/moonshotai/kimi-k2.5\\n");
`);
  const models = listOpencodeModels(cwd, probeEnv(binDir));
  assert.ok(models.has("zai-coding-plan/glm-5.2"));
  assert.ok(models.has("kimi-for-coding/k3"));
  assert.ok(models.has("cloudflare-ai-gateway/workers-ai/@cf/moonshotai/kimi-k2.5"));
});

test("listOpencodeModels returns null on non-zero exit", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oc-models-fail-"));
  const binDir = path.join(cwd, "bin");
  writeFakeOpencode(binDir, `#!/usr/bin/env node
process.exit(3);
`);
  assert.equal(listOpencodeModels(cwd, probeEnv(binDir)), null);
});

test("listOpencodeModels returns null on timeout instead of throwing", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oc-models-slow-"));
  const binDir = path.join(cwd, "bin");
  writeFakeOpencode(binDir, `#!/usr/bin/env node
setInterval(() => {}, 1000);
`);
  assert.equal(listOpencodeModels(cwd, probeEnv(binDir), { timeoutMs: 200 }), null);
});

test("listOpencodeModels returns null when opencode is not on PATH", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oc-models-none-"));
  const emptyBin = path.join(cwd, "empty-bin");
  fs.mkdirSync(emptyBin, { recursive: true });
  assert.equal(listOpencodeModels(cwd, { ...process.env, OC_MODEL: "", PATH: emptyBin }), null);
});

test("createJob records the resolved model and its source in state", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oc-job-model-"));
  const env = { ...process.env, OC_MODEL: "", CLAUDE_PLUGIN_DATA: path.join(cwd, "plugin-data") };
  const payload = createJob(cwd, {
    kind: "review",
    prompt: "x",
    model: "kimi-for-coding/k3",
    modelSource: "flag"
  }, env);

  assert.equal(payload.runOptions.model, "kimi-for-coding/k3");
  const job = loadState(cwd, env).jobs.find((entry) => entry.id === payload.id);
  assert.equal(job.model, "kimi-for-coding/k3");
  assert.equal(job.modelSource, "flag");
});
