# oc Plugin Model Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class model switching to the oc plugin: built-in aliases (`kimi`, `glm`), an `OC_MODEL` default, warn-only validation against `opencode models`, and a `model` parameter on the MCP `oc_rescue` tool.

**Architecture:** A new pure module `lib/models.mjs` owns aliases and selection logic; `lib/oc-runtime.mjs` keeps its monopoly on opencode process execution and gains a bounded `opencode models` probe plus an early model validator; the companion resolves + validates + probes before `createJob`; the MCP server stays a thin validator/forwarder.

**Tech Stack:** Node.js 18.18+ ESM (`.mjs`), `node:test`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-20-oc-model-switching-design.md` (v4, approved 2026-07-20, commit `3fe42a4`).

## Global Constraints

- Node.js 18.18 or newer (`engines` in `package.json`); ESM only; no new npm dependencies.
- All opencode process execution lives in `plugins/oc/scripts/lib/oc-runtime.mjs` — `spawnSync`/`spawn` with `shell: false`, fixed argv, bounded timeout.
- Validation is warn-only: an unknown model or a failed probe never blocks a run; skips and warnings are always recorded in the job log.
- The resolved model is validated with the existing `SAFE_VALUE_PATTERN` (`/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,127}$/`) BEFORE any probe, log write, or `createJob` call.
- `MODEL_ALIASES` is a frozen built-in map: `kimi`, `kimi-k3` -> `kimi-for-coding/k3`; `glm`, `glm-5.2` -> `zai-coding-plan/glm-5.2`. No user-defined aliases (YAGNI).
- Test environments must not inherit ambient `OC_MODEL` (set `OC_MODEL: ""` in constructed envs).
- Commit style follows repo history: `feat(oc): ...`, `test(oc): ...`, `docs(oc): ...`. Never push to remotes.
- `npm test` (`node --test tests/*.test.mjs`) must be green after every task.

---

### Task 1: Pure model-selection module `lib/models.mjs`

**Files:**
- Create: `plugins/oc/scripts/lib/models.mjs`
- Test: `tests/oc-models.test.mjs`

**Interfaces:**
- Consumes: nothing (new pure module).
- Produces:
  - `MODEL_ALIASES: Readonly<Record<string, string>>`
  - `resolveModel(requested: unknown, env = process.env): { model: string | null, aliasUsed: string | null, source: "flag" | "env" | null }` — precedence flag > `OC_MODEL` > null; empty/whitespace values count as unset.
  - `unknownModelWarning(model: string, models: Set<string> | null): string | null` — null when the probe failed (`models === null`) or the model is listed.

- [ ] **Step 1: Write the failing tests**

Create `tests/oc-models.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import { MODEL_ALIASES, resolveModel, unknownModelWarning } from "../plugins/oc/scripts/lib/models.mjs";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/oc-models.test.mjs`
Expected: FAIL — `Cannot find module '../plugins/oc/scripts/lib/models.mjs'`

- [ ] **Step 3: Create the module**

Create `plugins/oc/scripts/lib/models.mjs`:

```js
// Built-in model aliases and pure model-selection helpers for the oc plugin.
// This module never spawns processes: opencode process execution stays in
// oc-runtime.mjs (listOpencodeModels). Values containing "/" are full
// provider/model ids and are never treated as aliases (alias keys never
// contain one, so an exact-match lookup cannot collide).

export const MODEL_ALIASES = Object.freeze({
  kimi: "kimi-for-coding/k3",
  "kimi-k3": "kimi-for-coding/k3",
  glm: "zai-coding-plan/glm-5.2",
  "glm-5.2": "zai-coding-plan/glm-5.2"
});

function resolveAlias(value) {
  return Object.hasOwn(MODEL_ALIASES, value) ? MODEL_ALIASES[value] : value;
}

// Precedence: explicit --model value, then env.OC_MODEL, then null (opencode's
// own configured default). Empty/whitespace-only values count as unset, so
// `--model ""` falls through to OC_MODEL instead of failing validation.
export function resolveModel(requested, env = process.env) {
  const flag = requested == null ? "" : String(requested).trim();
  if (flag) {
    return {
      model: resolveAlias(flag),
      aliasUsed: Object.hasOwn(MODEL_ALIASES, flag) ? flag : null,
      source: "flag"
    };
  }
  const fromEnv = String(env.OC_MODEL ?? "").trim();
  if (fromEnv) {
    return {
      model: resolveAlias(fromEnv),
      aliasUsed: Object.hasOwn(MODEL_ALIASES, fromEnv) ? fromEnv : null,
      source: "env"
    };
  }
  return { model: null, aliasUsed: null, source: null };
}

// Warn-only contract: a null/undefined models set means the probe failed and
// the check is skipped entirely (the companion records that skip separately).
export function unknownModelWarning(model, models) {
  if (models == null || models.has(model)) {
    return null;
  }
  return `oc: warning: model "${model}" is not listed by \`opencode models\`; running anyway`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/oc-models.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add plugins/oc/scripts/lib/models.mjs tests/oc-models.test.mjs
git commit -m "feat(oc): add pure model-selection module with built-in aliases"
```

---

### Task 2: Runtime probe `listOpencodeModels` + early validator `assertSafeModelValue`

**Files:**
- Modify: `plugins/oc/scripts/lib/oc-runtime.mjs` (after `opencodeAvailable`, ~line 327)
- Test: `tests/oc-models.test.mjs` (append)

**Interfaces:**
- Consumes: existing private `normalizeArgvValue(value, label)` in oc-runtime.mjs.
- Produces:
  - `listOpencodeModels(cwd = process.cwd(), env = process.env, { timeoutMs = 5000 } = {}): Set<string> | null` — never throws; ANSI-stripped, multi-segment-id tolerant.
  - `assertSafeModelValue(model: string): string` — returns the trimmed value or throws `model contains unsupported characters or starts with "-"`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/oc-models.test.mjs` (add imports at top: `import fs from "node:fs"; import os from "node:os"; import path from "node:path";` and `import { assertSafeModelValue, listOpencodeModels } from "../plugins/oc/scripts/lib/oc-runtime.mjs";`):

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/oc-models.test.mjs`
Expected: FAIL — `assertSafeModelValue is not a function` / `listOpencodeModels is not a function` (import error)

- [ ] **Step 3: Implement in oc-runtime.mjs**

Insert after the `opencodeAvailable` function (keep `HELP_PROBE_TIMEOUT_MS` at the top; add the new constant next to it at the top of the file):

```js
const MODELS_PROBE_TIMEOUT_MS = 5_000;
```

Then append after `opencodeAvailable`:

```js
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/g;
// Model ids may span several path segments, e.g.
// cloudflare-ai-gateway/workers-ai/@cf/moonshotai/kimi-k2.5.
const MODEL_ID_PATTERN = /[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._:@-]+)+/g;

// Bounded, never-throwing probe for `opencode models`. Returns a Set of model
// ids, or null on any failure (non-zero exit, timeout, spawn error) so callers
// can skip the warn-only check without blocking the run. The default timeout
// is short because the probe runs on every model'd invocation, including
// background submissions, and its failure mode is a benign, logged skip.
// timeoutMs is injectable so tests can shrink it. Kept here because
// oc-runtime.mjs owns all opencode process execution.
export function listOpencodeModels(cwd = process.cwd(), env = process.env, { timeoutMs = MODELS_PROBE_TIMEOUT_MS } = {}) {
  const result = spawnSync("opencode", ["models"], {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  const clean = String(result.stdout ?? "").replace(ANSI_ESCAPE_PATTERN, "");
  return new Set(clean.match(MODEL_ID_PATTERN) ?? []);
}

// Exported wrapper around normalizeArgvValue so the companion can validate a
// resolved model BEFORE persisting or logging it (previously validation only
// happened inside buildOpencodeArgv, after the job was already written).
export function assertSafeModelValue(model) {
  return normalizeArgvValue(model, "model");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/oc-models.test.mjs`
Expected: PASS (10 tests total)

- [ ] **Step 5: Commit**

```bash
git add plugins/oc/scripts/lib/oc-runtime.mjs tests/oc-models.test.mjs
git commit -m "feat(oc): add bounded opencode models probe and early model validator"
```

---

### Task 3: Record model + modelSource in job state

**Files:**
- Modify: `plugins/oc/scripts/lib/oc-runtime.mjs` (`createJob`, ~line 265)
- Test: `tests/oc-models.test.mjs` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `createJob(cwd, options, env)` now accepts `options.modelSource: string | null`; state job entries gain `model: string | null` and `modelSource: string | null`. Later tasks read these via `loadState(cwd, env).jobs`.

- [ ] **Step 1: Write the failing test**

Append to `tests/oc-models.test.mjs` (add `createJob` and `loadState` to the oc-runtime import):

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/oc-models.test.mjs`
Expected: FAIL — `assert.equal(job.model, "kimi-for-coding/k3")` gets `undefined`

- [ ] **Step 3: Implement**

In `createJob` (oc-runtime.mjs), add the two fields to the `upsertJob` call:

```js
  writeJobPayload(cwd, payload, env);
  upsertJob(cwd, {
    id,
    kind: payload.kind,
    status: payload.status,
    cwd: payload.cwd,
    jobFile: payload.jobFile,
    logFile: payload.logFile,
    resultFile: payload.resultFile,
    promptFile: payload.promptFile,
    model: payload.runOptions.model,
    modelSource: options.modelSource ?? null
  }, env);
  return payload;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/oc-models.test.mjs tests/oc-runtime.test.mjs`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add plugins/oc/scripts/lib/oc-runtime.mjs tests/oc-models.test.mjs
git commit -m "feat(oc): record model and modelSource in job state"
```

---

### Task 4: Warn when the local opencode lacks `--model` support

**Files:**
- Modify: `plugins/oc/scripts/lib/oc-runtime.mjs` (`runJobFile`, ~line 341)
- Test: `tests/oc-runtime.test.mjs` (append; also scrub `OC_MODEL` in `fakeEnv`)

**Interfaces:**
- Consumes: `payload.runOptions.model`, `opencodeAvailable(...).available/.supports.model`.
- Produces: warning text `oc: warning: this opencode build does not advertise --model; model "<id>" will be ignored` written via `process.stderr.write()` AND appended to the job log exactly once per run.

- [ ] **Step 1: Scrub ambient OC_MODEL in the runtime test env**

In `tests/oc-runtime.test.mjs`, update `fakeEnv`:

```js
function fakeEnv(cwd, binDir) {
  return {
    ...process.env,
    CLAUDE_PLUGIN_DATA: path.join(cwd, "plugin-data"),
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    OC_MODEL: ""
  };
}
```

- [ ] **Step 2: Write the failing test**

Append to `tests/oc-runtime.test.mjs`:

```js
test("runJobFile warns on stderr and in the log when the local opencode lacks --model support", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oc-nomodel-"));
  const binDir = path.join(cwd, "bin");
  writeFakeOpencode(
    binDir,
    `#!/usr/bin/env node
if (process.argv.includes("--help")) {
  console.log("run --agent --session --continue --pure");
  process.exit(0);
}
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));
process.exit(0);
`
  );

  const env = fakeEnv(cwd, binDir);
  const payload = createJob(cwd, {
    kind: "review",
    prompt: "x",
    timeout: "5s",
    sandbox: true,
    model: "kimi-for-coding/k3"
  }, env);

  const stderrWrites = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    stderrWrites.push(String(chunk));
    return true;
  };
  let result;
  try {
    result = await runJobFile(payload.jobFile, env);
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.equal(result.status, "succeeded");
  assert.equal(stderrWrites.filter((text) => text.includes("does not advertise --model")).length, 1);
  const log = fs.readFileSync(payload.logFile, "utf8");
  assert.equal(log.match(/does not advertise --model/g).length, 1);
  // The run proceeds with the model omitted.
  assert.ok(!JSON.parse(result.stdout).argv.includes("--model"));
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/oc-runtime.test.mjs`
Expected: FAIL — `stderrWrites.filter(...).length` is `0`

- [ ] **Step 4: Implement**

In `runJobFile` (oc-runtime.mjs), between the `opencodeAvailable` call and `buildOpencodeArgv`:

```js
  const opencode = opencodeAvailable(cwd, env);
  if (payload.runOptions.model && opencode.available && !opencode.supports.model) {
    // buildOpencodeArgv would silently drop the model on this build; surface it
    // on the live stderr (foreground) and always in the job log (background
    // workers have no console).
    const message = `oc: warning: this opencode build does not advertise --model; model "${payload.runOptions.model}" will be ignored\n`;
    process.stderr.write(message);
    await fs.promises.appendFile(payload.logFile, message, "utf8");
  }
  const argv = buildOpencodeArgv(payload.runOptions, opencode.supports);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/oc-runtime.test.mjs`
Expected: PASS (all)

- [ ] **Step 6: Commit**

```bash
git add plugins/oc/scripts/lib/oc-runtime.mjs tests/oc-runtime.test.mjs
git commit -m "feat(oc): warn when opencode lacks --model support instead of dropping silently"
```

---

### Task 5: Companion wiring — resolve, validate, probe, model line, setup, status

**Files:**
- Modify: `plugins/oc/scripts/oc-companion.mjs` (`runPromptJob`, `handleSetup`, `renderSetup`, `renderStatus`, imports)
- Test: `tests/oc-models.test.mjs` (append companion integration tests)

**Interfaces:**
- Consumes: `resolveModel`, `unknownModelWarning` (Task 1); `listOpencodeModels`, `assertSafeModelValue` (Task 2); `createJob` `modelSource` option + state fields (Task 3).
- Produces:
  - Foreground/background submission prints `model: <id> (alias "<alias>"[, OC_MODEL])` or `model: <id> (from OC_MODEL)` or `model: <id>` — also appended to the job log exactly once.
  - Unknown-model warning on stderr + job log; probe failure appends `oc: model check skipped (probe failed)` to the job log.
  - `setup` output contains `OC_MODEL: <value|unset>` and a `model aliases:` block.
  - `status` output appends the model after the kind column.

- [ ] **Step 1: Write the failing tests**

Append to `tests/oc-models.test.mjs` (add `spawnSync` from `node:child_process` to imports; companion path constant):

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/oc-models.test.mjs`
Expected: FAIL — review output has no `model:` line; payloads have no resolved model; setup/status lack the new output.

- [ ] **Step 3: Implement companion changes**

In `plugins/oc/scripts/oc-companion.mjs`, update the imports:

```js
import {
  opencodeAvailable,
  assertSafeModelValue,
  cancelJob,
  createJob,
  findJob,
  listJobs,
  listOpencodeModels,
  readJobPayload,
  resolveStateDir,
  runJobFile,
  startBackgroundWorker,
  upsertJob
} from "./lib/oc-runtime.mjs";
import { MODEL_ALIASES, resolveModel, unknownModelWarning } from "./lib/models.mjs";
```

Replace `runPromptJob` entirely:

```js
async function runPromptJob(kind, prompt, options) {
  const cwd = process.cwd();
  // Review and adversarial review are read-only by contract (opencode `plan`
  // agent). Only rescue may switch to the editing `build` agent, and only when
  // the caller explicitly passes --allow-edits.
  const sandbox = kind === "rescue" ? !options["allow-edits"] : true;

  // Model selection: resolve aliases/OC_MODEL, then validate BEFORE anything is
  // probed, persisted, or logged so an unsafe value can never reach the payload,
  // the logs, or a background worker (previously validation only happened inside
  // runJobFile, after the job was already marked running).
  const resolved = resolveModel(options.model, process.env);
  if (resolved.model) {
    assertSafeModelValue(resolved.model);
  }
  const knownModels = resolved.model ? listOpencodeModels(cwd, process.env) : null;
  const warning = resolved.model ? unknownModelWarning(resolved.model, knownModels) : null;
  if (warning) {
    process.stderr.write(`${warning}\n`);
  }

  const payload = createJob(cwd, {
    kind,
    prompt,
    printTimeout: undefined,
    timeout: options.timeout ?? "10m0s",
    sandbox,
    dangerouslySkipPermissions: Boolean(options["dangerously-skip-permissions"]),
    continueLast: Boolean(options.continue),
    session: options.session ?? null,
    model: resolved.model,
    modelSource: resolved.source
  });

  if (resolved.model) {
    const sourceLabel = resolved.aliasUsed
      ? ` (alias "${resolved.aliasUsed}"${resolved.source === "env" ? ", OC_MODEL" : ""})`
      : resolved.source === "env"
        ? " (from OC_MODEL)"
        : "";
    const modelLine = `model: ${resolved.model}${sourceLabel}\n`;
    process.stdout.write(modelLine);
    fs.appendFileSync(payload.logFile, modelLine, "utf8");
  }
  if (warning) {
    fs.appendFileSync(payload.logFile, `${warning}\n`, "utf8");
  } else if (resolved.model && knownModels === null) {
    // Warn-only must not mean silent: the skip itself goes on the record.
    fs.appendFileSync(payload.logFile, "oc: model check skipped (probe failed)\n", "utf8");
  }

  if (options.background) {
    const pid = startBackgroundWorker(cwd, payload.jobFile, WORKER_FILE);
    upsertJob(cwd, { id: payload.id, pid });
    output(`opencode ${kind} started in the background.\nJob: ${payload.id}\nCheck /oc:status or /oc:result ${payload.id}\n`);
    return;
  }

  const result = await runJobFile(payload.jobFile);
  const statusLine = `\n\n[opencode job ${payload.id}: ${result.status}${result.exitCode != null ? `, exit ${result.exitCode}` : ""}]\n`;
  output(`${result.stdout || result.stderr || ""}${statusLine}`);
}
```

Update `renderSetup` and `handleSetup`:

```js
function renderSetup(report) {
  const lines = [
    `opencode ready: ${report.ready ? "yes" : "no"}`,
    `opencode available: ${report.opencode.available ? "yes" : "no"}`,
    `state dir: ${report.stateDir}`,
    `OC_MODEL: ${report.ocModelEnv ?? "unset"}`,
    "model aliases:",
    ...Object.entries(report.modelAliases).map(([alias, id]) => `  ${alias} -> ${id}`),
    ""
  ];
  // ...remainder unchanged (missingFeatures / Next steps blocks)
```

In `handleSetup`, add the two fields to the report object:

```js
  const report = {
    ready: opencode.available && opencode.supports.agent,
    opencode: {
      available: opencode.available,
      status: opencode.status,
      error: opencode.error,
      supports: opencode.supports
    },
    missingFeatures,
    stateDir: resolveStateDir(cwd),
    modelAliases: MODEL_ALIASES,
    ocModelEnv: String(process.env.OC_MODEL ?? "").trim() || null
  };
```

Update `renderStatus`:

```js
function renderStatus(jobs) {
  if (jobs.length === 0) {
    return "No opencode jobs found.\n";
  }
  return `${jobs.map((job) => {
    const updated = job.updatedAt ?? job.createdAt ?? "";
    const model = job.model ? `  ${job.model}` : "";
    return `${job.id}  ${job.status}  ${job.kind ?? "job"}${model}  ${updated}`;
  }).join("\n")}\n`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/oc-models.test.mjs`
Expected: PASS (all, including Tasks 1-3 tests)

- [ ] **Step 5: Commit**

```bash
git add plugins/oc/scripts/oc-companion.mjs tests/oc-models.test.mjs
git commit -m "feat(oc): resolve and validate models in the companion before job creation"
```

---

### Task 6: Automated background-propagation test

**Files:**
- Test: `tests/oc-models.test.mjs` (append)

**Interfaces:**
- Consumes: Task 5 companion behavior; `loadState` polling; fake opencode from Task 5 helpers.

- [ ] **Step 1: Write the failing-then-passing test**

This test passes only when Task 5 behavior is correct, and guards the background path (companion submission -> detached worker -> `runJobFile`) including flag-over-env precedence. Append to `tests/oc-models.test.mjs`:

```js
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    job = loadState(cwd, env).jobs.find((entry) => entry.id === jobId);
    if (job && ["succeeded", "failed", "cancelled"].includes(job.status)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS (all suites)

- [ ] **Step 3: Commit**

```bash
git add tests/oc-models.test.mjs
git commit -m "test(oc): cover background model propagation and flag-over-env precedence"
```

---

### Task 7: MCP server — `model` on `oc_rescue` + alias-aware descriptions

**Files:**
- Modify: `plugins/oc/scripts/oc-mcp-server.mjs` (tool schemas, `rescueArgs`, pattern comment)
- Test: `tests/oc-mcp-server.test.mjs` (rewrite the rescue block, update fakes, scrub env)

**Interfaces:**
- Consumes: companion resolves aliases (Task 5) — MCP stays a thin validator/forwarder.
- Produces:
  - `oc_rescue` inputSchema gains optional `model: string`; `rescueArgs` allows the `model` key.
  - All three `model` descriptions read: `Optional opencode model id or alias (kimi, glm). Defaults to OC_MODEL when set.`

- [ ] **Step 1: Update the fakes and scrub OC_MODEL in test envs**

In `tests/oc-mcp-server.test.mjs`, update `writeFakeOpencode` and `writeHangingOpencode` to answer the `models` subcommand before the `--help` branch:

```js
function writeFakeOpencode(binDir) {
  const fake = path.join(binDir, "opencode");
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env node
if (process.argv[2] === "models") {
  console.log("zai-coding-plan/glm-5.2");
  console.log("kimi-for-coding/k3");
  process.exit(0);
}
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
```

Same `models` branch prepended inside `writeHangingOpencode` (so a probe can never hang on that fake).

Add `OC_MODEL: ""` to every env object passed to `createMcpClient`, i.e. each object literal shaped `{ ...process.env, PATH: ..., CLAUDE_PLUGIN_DATA: ... }` gains the key, and the two `createMcpClient(process.env)` call sites become `createMcpClient({ ...process.env, OC_MODEL: "" })`.

- [ ] **Step 2: Rewrite the rescue test block (failing first)**

Replace the test `"opencode MCP rescue does not expose edit-enabling or permission-bypass flags"` with:

```js
test("opencode MCP rescue accepts a model but not edit-enabling or permission-bypass flags", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-bin-"));
  writeFakeOpencode(binDir);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-data-"));
  const client = createMcpClient({
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    CLAUDE_PLUGIN_DATA: dataDir,
    OC_MODEL: ""
  });

  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" }
    });

    const tools = await client.request("tools/list");
    const rescue = tools.result.tools.find((tool) => tool.name === "oc_rescue");
    assert.ok(rescue);
    assert.ok(Object.hasOwn(rescue.inputSchema.properties, "model"));
    assert.ok(!Object.hasOwn(rescue.inputSchema.properties, "allowEdits"));
    assert.ok(!Object.hasOwn(rescue.inputSchema.properties, "dangerouslySkipPermissions"));
    assert.ok(!Object.hasOwn(rescue.inputSchema.properties, "session"));

    const rejected = await client.request("tools/call", {
      name: "oc_rescue",
      arguments: { task: "inspect safely", dangerouslySkipPermissions: true }
    });
    assert.match(rejected.error.message, /unknown argument: dangerouslySkipPermissions/);

    // The alias is resolved by the companion, so the payload stores the full id.
    await client.request("tools/call", {
      name: "oc_rescue",
      arguments: { task: "inspect safely", model: "kimi" }
    });

    const jobsDir = path.join(dataDir, "state", "jobs");
    const jobFile = fs.readdirSync(jobsDir).find((file) => file.endsWith(".json"));
    const payload = JSON.parse(fs.readFileSync(path.join(jobsDir, jobFile), "utf8"));
    assert.equal(payload.runOptions.model, "kimi-for-coding/k3");
    // Rescue stays read-only (plan agent) regardless of the selected model.
    assert.equal(payload.runOptions.sandbox, true);
  } finally {
    client.close();
  }
});
```

- [ ] **Step 3: Run to verify the new test fails**

Run: `node --test tests/oc-mcp-server.test.mjs`
Expected: FAIL — `oc_rescue` schema has no `model`; call with `model` rejected as unknown argument.

- [ ] **Step 4: Implement MCP server changes**

In `plugins/oc/scripts/oc-mcp-server.mjs`:

a) Update the pattern comment (keep the pattern itself):

```js
// Mirror the companion's SAFE_VALUE_PATTERN: a model value must start with an
// alphanumeric so it can never be reparsed as an opencode flag (e.g. "-x"), and
// must be bounded and free of whitespace. Allows full ids like
// "zai-coding-plan/glm-5.2" and built-in aliases like "kimi" (aliases are
// resolved by the companion, never here).
const SAFE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,127}$/;
```

b) Use this description for the `model` property in all three tools (`oc_review`, `oc_adversarial_review`, `oc_rescue`):

```js
        model: { type: "string", description: "Optional opencode model id or alias (kimi, glm). Defaults to OC_MODEL when set." },
```

c) Add the same `model` property to the `oc_rescue` inputSchema (between `task` and `timeout`).

d) Replace `rescueArgs`:

```js
function rescueArgs(args) {
  // Rescue accepts a model for parity with the Claude /oc:rescue command. It
  // stays read-only (the plan agent) regardless of model choice, and
  // edit-enabling or permission-bypass flags remain unavailable here.
  rejectUnknown(args, ["task", "model", "timeout", "background"]);
  const argv = [];
  addCommonRunArgs(argv, args);
  // "--" terminator keeps flag-like task text from being reparsed into options.
  argv.push("--", requiredString(args, "task", { max: 8000 }));
  return argv;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/oc-mcp-server.test.mjs`
Expected: PASS (all)

- [ ] **Step 6: Commit**

```bash
git add plugins/oc/scripts/oc-mcp-server.mjs tests/oc-mcp-server.test.mjs
git commit -m "feat(oc): add model selection to the MCP oc_rescue tool"
```

---

### Task 8: Documentation + changelog

**Files:**
- Modify: `README.md`, `plugins/oc/commands/review.md`, `plugins/oc/commands/adversarial-review.md`, `plugins/oc/commands/rescue.md`, `plugins/oc/skills/oc/SKILL.md`, `docs/architecture.md`, `AGENTS.md`, `SECURITY.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: behavior from Tasks 1-7 (alias table, `OC_MODEL` precedence, warn-only contract, setup/status output).

- [ ] **Step 1: README — add a "Model selection" section**

Insert after the `## Requirements` section (before `## AI-Assisted Installation`):

```markdown
## Model Selection

Reviews and rescues run on your opencode default model unless you pick another one:

- `--model <id|alias>` on `/oc:review`, `/oc:adversarial-review`, `/oc:rescue`, or the `model`
  parameter on the Codex MCP tools (including `oc_rescue`).
- `OC_MODEL` environment variable as the default when `--model` is absent.
- Precedence: `--model` > `OC_MODEL` > opencode's own configured default.

Built-in aliases (resolved by the companion; full ids always work too):

| Alias | Model id |
| --- | --- |
| `kimi`, `kimi-k3` | `kimi-for-coding/k3` |
| `glm`, `glm-5.2` | `zai-coding-plan/glm-5.2` |

Before each model'd run the companion checks the resolved id against `opencode models` (bounded 5s
probe). The check is warn-only: an unlisted id prints a warning and runs anyway, and a failed probe is
noted in the job log as skipped. `/oc:setup` lists the aliases and the current `OC_MODEL`; `/oc:status`
shows the model each job ran with.
```

- [ ] **Step 2: Command hints**

In `plugins/oc/commands/review.md` and `plugins/oc/commands/adversarial-review.md`, change the frontmatter `argument-hint` to:

```yaml
argument-hint: "[--wait|--background] [--base <ref>] [--timeout <duration>] [--model <id|alias>] [focus text]"
```

In `plugins/oc/commands/rescue.md`:

```yaml
argument-hint: "[--wait|--background] [--timeout <duration>] [--allow-edits] [--dangerously-skip-permissions] [--model <id|alias>] [task]"
```

In all three files, add one line under the "Core constraints"/"Rules" block:

```markdown
- Model selection: `--model` accepts a full id or an alias (`kimi`, `glm`); `OC_MODEL` is the default when `--model` is absent. Validation against `opencode models` is warn-only.
```

- [ ] **Step 3: Codex-facing skill**

In `plugins/oc/skills/oc/SKILL.md`, extend the tool-list intro:

```markdown
All run tools accept an optional `model` (full opencode id or a built-in alias: `kimi`, `glm`);
`OC_MODEL` provides the default when `model` is omitted, and unknown ids only produce a warning.
```

And add one example:

```bash
node "<path-to-this-skill>/scripts/oc-codex.mjs" review "--model kimi security focus"
```

- [ ] **Step 4: architecture + agent/security notes**

In `docs/architecture.md`, replace the line ``- `--continue` and `--session` cover session continuity; `--model` is an optional passthrough.`` with:

```markdown
- `--continue` and `--session` cover session continuity; `--model` is resolved by the companion (built-in aliases `kimi`/`glm`, then `OC_MODEL`), validated before persistence, checked warn-only against `opencode models`, and recorded in job state.
```

In `AGENTS.md`, after the line ``- User-controlled `--model` / `--session` values must pass the safe-value pattern (no leading `-`) so they cannot be injected as flags.`` add:

```markdown
- Model aliases and `OC_MODEL` resolve inside the companion (`lib/models.mjs`) and are validated by the same safe-value pattern before persistence; `lib/oc-runtime.mjs` owns the bounded `opencode models` probe.
```

In `SECURITY.md`, after the `--model` validation bullet, add:

```markdown
- Aliases and the `OC_MODEL` default resolve to full ids from a fixed map and pass the same safe-value validation before anything is persisted or logged, so they cannot widen the injection surface. The `opencode models` probe is a fixed-argv `spawnSync` with `shell: false` and a 5s timeout.
```

- [ ] **Step 5: CHANGELOG**

Under `## 0.1.0 - Unreleased` -> `### Added`, append:

```markdown
- Built-in model aliases (`kimi`, `kimi-k3`, `glm`, `glm-5.2`) and an `OC_MODEL` default for opencode model selection, resolved and validated in the companion before job creation.
- Warn-only pre-run check of the resolved model against `opencode models` (bounded 5s probe; failures are logged as skipped, never block).
- `model` parameter on the Codex MCP `oc_rescue` tool (parity with `/oc:rescue`); rescue stays read-only regardless of model.
- Job state records the resolved model and its source; `status` shows the model and `setup` lists aliases plus the current `OC_MODEL`.
- Warning when the local opencode build does not advertise `--model` and a selection would be silently ignored.
```

- [ ] **Step 6: Verify docs consistency + full suite**

Run:
```bash
npm test
grep -rn "zai-coding-plan/glm-5.2" plugins/oc/scripts/oc-mcp-server.mjs | head -5
grep -c "model aliases" plugins/oc/scripts/oc-companion.mjs
```
Expected: suite PASS; the old example-only description string is gone from the MCP server (aliases description instead); companion contains the alias block.

- [ ] **Step 7: Commit**

```bash
git add README.md plugins/oc/commands/ plugins/oc/skills/oc/SKILL.md docs/architecture.md AGENTS.md SECURITY.md CHANGELOG.md
git commit -m "docs(oc): document model selection, aliases, and OC_MODEL"
```

---

### Task 9: Manual smoke (real opencode)

**Files:** none (verification only)

- [ ] **Step 1: Alias review in background**

```bash
node plugins/oc/scripts/oc-companion.mjs review --model kimi --background -- smoke test
node plugins/oc/scripts/oc-companion.mjs status
```
Expected: job appears with `kimi-for-coding/k3`; completes; log contains the `model:` line.

- [ ] **Step 2: OC_MODEL default**

```bash
OC_MODEL=glm node plugins/oc/scripts/oc-companion.mjs review --background -- smoke test
```
Expected: `model: zai-coding-plan/glm-5.2 (alias "glm", OC_MODEL)` in submission output.

- [ ] **Step 3: Bogus model warning path**

```bash
node plugins/oc/scripts/oc-companion.mjs review --model acme/nope-1 --background -- smoke test
```
Expected: stderr warning `not listed by \`opencode models\``; job still runs; warning in job log.

- [ ] **Step 4: Report results to the user** — include whether the real `opencode models` output format still matches the parser's expectations.
