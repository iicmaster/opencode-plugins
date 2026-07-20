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
