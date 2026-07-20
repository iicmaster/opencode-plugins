import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

const COMPANION = new URL("../plugins/oc/scripts/oc-companion.mjs", import.meta.url).pathname;

function writeFullFakeOpencode(binDir) {
  writeFakeOpencode(binDir, `#!/usr/bin/env node
if (process.argv[2] === "models") {
  process.stdout.write("zai-coding-plan/glm-5.2\\nkimi-for-coding/k3\\n");
  process.exit(0);
}
if (process.argv.includes("--help")) {
  console.log("run --agent --model --session --continue --pure --dangerously-skip-permissions");
  process.exit(0);
}
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin }));
});
`);
}

function companionEnv(cwd) {
  const binDir = path.join(cwd, "bin");
  const dataDir = path.join(cwd, "plugin-data");
  return {
    binDir,
    dataDir,
    env: {
      ...process.env,
      OC_MODEL: "",
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      CLAUDE_PLUGIN_DATA: dataDir
    }
  };
}

function readSoleJobPayload(dataDir) {
  const jobsDir = path.join(dataDir, "state", "jobs");
  const jobFile = fs.readdirSync(jobsDir).find((file) => file.endsWith(".json"));
  return JSON.parse(fs.readFileSync(path.join(jobsDir, jobFile), "utf8"));
}

test("companion review resolves an alias, records it, and forwards the full id", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oc-alias-run-"));
  spawnSync("git", ["init"], { cwd, encoding: "utf8" });
  const { binDir, dataDir, env } = companionEnv(cwd);
  writeFullFakeOpencode(binDir);

  const run = spawnSync(process.execPath, [COMPANION, "review", "--model", "kimi", "--", "check the diff"], {
    cwd, env, encoding: "utf8"
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /model: kimi-for-coding\/k3 \(alias "kimi"\)/);

  const payload = readSoleJobPayload(dataDir);
  assert.equal(payload.runOptions.model, "kimi-for-coding/k3");
  const job = loadState(cwd, env).jobs.find((entry) => entry.id === payload.id);
  assert.equal(job.model, "kimi-for-coding/k3");
  assert.equal(job.modelSource, "flag");

  const invocation = JSON.parse(fs.readFileSync(payload.resultFile, "utf8"));
  assert.ok(invocation.argv.includes("--model"));
  assert.ok(invocation.argv.includes("kimi-for-coding/k3"));

  const log = fs.readFileSync(payload.logFile, "utf8");
  assert.equal((log.match(/model: kimi-for-coding\/k3/g) ?? []).length, 1);
});

test("companion falls back to OC_MODEL when no --model flag is given", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oc-env-model-"));
  spawnSync("git", ["init"], { cwd, encoding: "utf8" });
  const { binDir, dataDir, env } = companionEnv(cwd);
  writeFullFakeOpencode(binDir);

  const run = spawnSync(process.execPath, [COMPANION, "review", "--", "check"], {
    cwd, env: { ...env, OC_MODEL: "glm" }, encoding: "utf8"
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /model: zai-coding-plan\/glm-5\.2 \(alias "glm", OC_MODEL\)/);
  assert.equal(readSoleJobPayload(dataDir).runOptions.model, "zai-coding-plan/glm-5.2");
});

test("companion review with an unlisted model warns on stderr but still succeeds", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oc-unknown-model-"));
  spawnSync("git", ["init"], { cwd, encoding: "utf8" });
  const { binDir, dataDir, env } = companionEnv(cwd);
  writeFullFakeOpencode(binDir);

  const run = spawnSync(process.execPath, [COMPANION, "review", "--model", "acme/nope-1", "--", "check"], {
    cwd, env, encoding: "utf8"
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /not listed by `opencode models`/);
  const payload = readSoleJobPayload(dataDir);
  assert.equal(payload.runOptions.model, "acme/nope-1");
  assert.ok(fs.readFileSync(payload.logFile, "utf8").includes("not listed by `opencode models`"));
});

test("companion logs a skipped model check when the probe fails and still runs", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oc-probe-fail-"));
  spawnSync("git", ["init"], { cwd, encoding: "utf8" });
  const { binDir, dataDir, env } = companionEnv(cwd);
  writeFakeOpencode(binDir, `#!/usr/bin/env node
if (process.argv[2] === "models") { process.exit(3); }
if (process.argv.includes("--help")) {
  console.log("run --agent --model --session --continue --pure --dangerously-skip-permissions");
  process.exit(0);
}
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) })));
`);

  const run = spawnSync(process.execPath, [COMPANION, "review", "--model", "kimi", "--", "check"], {
    cwd, env, encoding: "utf8"
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(!run.stderr.includes("not listed"));
  const log = fs.readFileSync(readSoleJobPayload(dataDir).logFile, "utf8");
  assert.equal((log.match(/model check skipped \(probe failed\)/g) ?? []).length, 1);
});

test("companion rejects an unsafe OC_MODEL before any job is created", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oc-bad-env-"));
  spawnSync("git", ["init"], { cwd, encoding: "utf8" });
  const { binDir, dataDir, env } = companionEnv(cwd);
  writeFullFakeOpencode(binDir);

  const run = spawnSync(process.execPath, [COMPANION, "review", "--", "check"], {
    cwd, env: { ...env, OC_MODEL: "-evil" }, encoding: "utf8"
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /model contains unsupported characters/);
  assert.ok(!fs.existsSync(path.join(dataDir, "state", "jobs")));
});

test("companion setup lists model aliases and the OC_MODEL value", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oc-setup-"));
  const { binDir, env } = companionEnv(cwd);
  writeFullFakeOpencode(binDir);

  const withEnv = spawnSync(process.execPath, [COMPANION, "setup"], {
    cwd, env: { ...env, OC_MODEL: "kimi" }, encoding: "utf8"
  });
  assert.equal(withEnv.status, 0, withEnv.stderr);
  assert.match(withEnv.stdout, /OC_MODEL: kimi/);
  assert.match(withEnv.stdout, /kimi -> kimi-for-coding\/k3/);
  assert.match(withEnv.stdout, /glm -> zai-coding-plan\/glm-5\.2/);

  const withoutEnv = spawnSync(process.execPath, [COMPANION, "setup"], { cwd, env, encoding: "utf8" });
  assert.match(withoutEnv.stdout, /OC_MODEL: unset/);
});

test("companion status shows the recorded model for each job", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oc-status-model-"));
  const { binDir, dataDir, env } = companionEnv(cwd);
  writeFullFakeOpencode(binDir);
  const payload = createJob(cwd, {
    kind: "review",
    prompt: "x",
    model: "kimi-for-coding/k3",
    modelSource: "flag"
  }, env);

  const run = spawnSync(process.execPath, [COMPANION, "status"], { cwd, env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, new RegExp(`${payload.id}.*kimi-for-coding/k3`));
});

test("background rescue propagates the resolved model and the flag beats OC_MODEL", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oc-bg-model-"));
  const { binDir, dataDir, env } = companionEnv(cwd);
  writeFullFakeOpencode(binDir);

  const submission = spawnSync(
    process.execPath,
    [COMPANION, "rescue", "--background", "--model", "kimi", "--", "investigate the flake"],
    { cwd, env: { ...env, OC_MODEL: "glm" }, encoding: "utf8" }
  );
  assert.equal(submission.status, 0, submission.stderr);
  const jobId = /Job: (\S+)/.exec(submission.stdout)[1];
  assert.ok(jobId);

  let job;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    job = loadState(cwd, env).jobs.find((entry) => entry.id === jobId);
    if (job && ["succeeded", "failed", "cancelled"].includes(job.status)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(job, "background job did not reach a terminal state in time");
  assert.equal(job.status, "succeeded");
  assert.equal(job.model, "kimi-for-coding/k3");
  assert.equal(job.modelSource, "flag");

  const payload = JSON.parse(fs.readFileSync(path.join(dataDir, "state", "jobs", `${jobId}.json`), "utf8"));
  assert.equal(payload.runOptions.model, "kimi-for-coding/k3");
  const invocation = JSON.parse(fs.readFileSync(payload.resultFile, "utf8"));
  const modelFlagIndex = invocation.argv.indexOf("--model");
  assert.ok(modelFlagIndex !== -1);
  assert.equal(invocation.argv[modelFlagIndex + 1], "kimi-for-coding/k3");
});
