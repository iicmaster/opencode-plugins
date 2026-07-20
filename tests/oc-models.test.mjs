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
