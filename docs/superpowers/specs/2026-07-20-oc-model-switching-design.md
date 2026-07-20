# oc Plugin — Model Switching (aliases, default env var, pre-run validation)

Status: DRAFT v4 — pending owner approval. v2 incorporated an external Codex review
(VERDICT: OBJECTIONS — 2 blockers, 6 majors, 1 minor; all accepted). v3 incorporated an
external Antigravity (agy) review (VERDICT: OBJECTIONS — 1 major, 3 minors; findings 1-3
accepted, finding 4 already covered by v2 and made explicit). v4 incorporates an external
Claude Opus review (VERDICT: PASS — 7 minors; findings 1-6 accepted, finding 7 accepted in
part: shorter probe timeout yes, result caching no per YAGNI). Convergence notes: Codex
finding #3 and agy finding #1 both target visibility of an ignored model selection
(>=2-of-3 agreement = must-fix, fixed in v3); Codex finding #6 and Opus finding #3 both
target test-environment hygiene (>=2-of-3 agreement, extended to the MCP suite in v4).
Date: 2026-07-20
Scope: `plugins/oc` (Claude Code commands + Codex MCP server + shared companion runtime).

## Summary

The plugin already forwards an optional `--model <provider/model>` value to `opencode run --model`, but
nothing in the plugin helps users discover or conveniently switch models. This change adds first-class
model switching: built-in short aliases (e.g. `kimi` -> `kimi-for-coding/k3`), a default-model environment
variable `OC_MODEL`, and a warn-only pre-run check that the resolved model id appears in `opencode models`.

## Goals

- Let users switch models with short, memorable aliases instead of full `provider/model` ids.
- Let users set a default model for plugin runs via `OC_MODEL` without editing `opencode.json`.
- Warn (never block) when a resolved model id is not listed by the local `opencode models`.
- Expose the `model` parameter on the Codex MCP `oc_rescue` tool (parity with `/oc:rescue`).
- Document the behavior in README, command hints, SKILL.md, and architecture/security notes.

## Non-goals

- No user-defined aliases (no `OC_MODEL_ALIASES`, no external alias config file) — built-in map only (YAGNI).
- No hard failure on unknown model ids — validation is warn-only.
- No changes to how opencode itself resolves or authenticates providers.
- No model routing policy (e.g. per-kind defaults) beyond the single `OC_MODEL` default.

## Current state (verified 2026-07-20)

- `plugins/oc/scripts/lib/oc-runtime.mjs`: `normalizeRunOptions` accepts an optional `model` and validates it
  against `SAFE_VALUE_PATTERN` (`/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,127}$/`); `buildOpencodeArgv` emits
  `--model <id>` only when a model is set and the probed opencode build advertises `--model`.
  **`createJob` stores `options.model` raw** — normalization only happens later inside `runJobFile` via
  `buildOpencodeArgv`, so validation today happens after persistence (this change moves it earlier).
- `plugins/oc/scripts/oc-companion.mjs`: `parseArgs` accepts `--model`; `runPromptJob` passes it into
  `createJob` for review, adversarial-review, and rescue.
- `plugins/oc/scripts/oc-mcp-server.mjs`: `oc_review` and `oc_adversarial_review` accept `model`;
  `oc_rescue` intentionally rejects it today ("Model selection is a review-panel concern").
  Claude command `/oc:rescue` already accepts `--model`, so the MCP restriction is an inconsistency.
  Existing tests assert both the absence of `model` in the rescue schema and its rejection
  (`tests/oc-mcp-server.test.mjs`) — those assertions are rewritten by this change.
- Only documentation/examples reference a concrete model (`zai-coding-plan/glm-5.2`); nothing is hardcoded.
- Latent bug this design fixes as a side effect (surfaced by the Opus review): today an invalid
  `--model` passed directly to the companion throws inside `runJobFile` **after**
  `upsertJob(status: "running")`, leaving the job stuck in `running` forever. Validating the resolved
  model before `createJob` (step 2 below) closes that hole.
- Owner's local opencode (1.17.20) has `zai-coding-plan/glm-5.2` as default and `kimi-for-coding/k3`
  available via `KIMI_API_KEY`, so the two target aliases resolve against real, authenticated providers.
- Repository convention: `oc-runtime.mjs` owns all opencode process execution (`opencodeAvailable` is the
  one existing probe); adapters and helpers stay thin and do not spawn opencode themselves.

## Design

### Module split (Codex review finding #1)

- **`plugins/oc/scripts/lib/models.mjs` — pure, no process execution:**
  - `MODEL_ALIASES` — frozen built-in map, exact lowercase match only:
    - `kimi`, `kimi-k3` -> `kimi-for-coding/k3`
    - `glm`, `glm-5.2` -> `zai-coding-plan/glm-5.2`
    - Any value containing `/` is treated as a full id and never matched as an alias.
  - `resolveModel(requested, env)` — precedence: explicit `--model` value, then `env.OC_MODEL`
    (aliases resolve here too; empty string counts as unset), then `null` (no `--model` emitted;
    opencode uses its own configured default). `requested` is trimmed and an empty/whitespace value
    counts as unset, so `--model ""` falls through to `OC_MODEL` instead of failing validation
    (agy finding #3). Returns `{ model, aliasUsed, source: "flag" | "env" | null }`.
  - `unknownModelWarning(model, models)` — returns a warning string when `models` is a `Set` not
    containing `model`; returns `null` when `models` is `null` (probe failed -> silently skip) or when found.
- **`plugins/oc/scripts/lib/oc-runtime.mjs` — owns the probe (keeps single process-execution owner):**
  - `listOpencodeModels(cwd, env, { timeoutMs = 5_000 } = {})` — `spawnSync("opencode", ["models"])`
    with `shell: false`, fixed argv, bounded timeout; strips ANSI escape
    sequences from stdout, then extracts ids matching `provider/model` (agy finding #2 — tolerant of
    colorized or table-formatted output) into a `Set`. Returns `null` on any failure (non-zero exit,
    timeout, spawn error) and never throws. The default timeout is 5s (not the 20s help-probe mirror):
    the probe runs on every model'd invocation including background submissions, and its failure mode
    is a benign skip (Opus finding #7); `timeoutMs` is a parameter so tests can shrink it further.
    Result caching was considered and deferred (YAGNI).
  - `assertSafeModelValue(model)` — exports the existing `normalizeArgvValue(value, "model")` check so
    callers can validate a resolved model **before** persisting or logging it.

### Companion integration (`oc-companion.mjs`)

Order of operations inside `runPromptJob` (Codex review finding #2 — validate before persist/probe/log):

1. `resolveModel(options.model, process.env)` -> `{ model, aliasUsed, source }`.
2. If `model` is set, `assertSafeModelValue(model)` — throws immediately on an invalid value (same hard
   error contract as an invalid `--model` today), **before** any probing, logging, or `createJob`.
3. Warn-only checks (never block):
   a. If `model` is set, call `listOpencodeModels` once; on a miss print `unknownModelWarning` to stderr
      and append it to the job log after creation. If the probe itself returns `null`, append a single
      `model check skipped (probe failed)` line to the job log — warn-only must not mean silent
      (Opus finding #5).
   b. `runJobFile` (runtime) additionally warns when `payload.runOptions.model` is set but the help
      probe reports no `--model` support — the model would otherwise be **silently dropped** by
      `buildOpencodeArgv` (Codex finding #3). The warning is appended to the job log **and** written
      directly with `process.stderr.write()` so it is visible in foreground runs; in background workers
      stderr is discarded by design, so the job log remains the record there (agy finding #1).
4. `createJob` receives the validated, resolved model; the payload stores the full id.
5. State visibility (Codex review finding #4, agy finding #4): `createJob` gains a `modelSource`
   option and its `upsertJob` call records `model` (resolved id or `null`, from
   `payload.runOptions.model`) and `modelSource` (`options.modelSource ?? null`) on the state job
   entry; `renderStatus` appends the model when present; `result --json` exposes the recorded
   state-entry `model`/`modelSource` through its `job` object (Opus finding #1 — the exposure path is
   the new state fields, not the payload).
6. Foreground output prints one short line with the effective model and its source
   (e.g. `model: kimi-for-coding/k3 (alias "kimi")` / `(from OC_MODEL)`), also appended to the job log.
7. `setup` output lists the built-in alias table and the current `OC_MODEL` value (or "unset").

### Codex MCP server (`oc-mcp-server.mjs`)

- `oc_rescue` gains an optional `model` parameter: add it to the tool's `inputSchema`, allow the `model`
  key in `rescueArgs` (`addCommonRunArgs` already forwards it), and replace the "intentionally omits
  model" comment with a note that rescue stays read-only regardless of model choice.
- The MCP server still does **not** resolve aliases itself — it validates the raw string with the existing
  `SAFE_MODEL_PATTERN` and forwards it; the companion resolves. Adapters stay thin.
- Tool descriptions for `model` mention alias support with both examples
  (`kimi` / `kimi-for-coding/k3`, `glm` / `zai-coding-plan/glm-5.2`).

### Documentation

- README: new "Model selection" section — precedence (`--model` > `OC_MODEL` > opencode default),
  alias table, warn-only validation behavior (including the unsupported-`--model` warning), examples.
- `commands/review.md`, `commands/adversarial-review.md`, `commands/rescue.md`: argument hint becomes
  `[--model <id|alias>]` plus one line naming the aliases and `OC_MODEL`.
- `skills/oc/SKILL.md`: note alias/`OC_MODEL` support on the MCP tools (rescue included).
- `docs/architecture.md`: replace "`--model` is an optional passthrough" with the resolution/validation flow.
- `AGENTS.md` / `SECURITY.md`: note that aliases resolve inside the companion and are validated by the
  existing safe-value pattern before persistence, so the injection guarantees are unchanged.
- `CHANGELOG.md`: entries under `0.1.0 - Unreleased`.

## Data flow

```
--model kimi  (slash command or MCP tool)
  -> companion parseArgs
  -> resolveModel("kimi", env)            # alias -> kimi-for-coding/k3, source: "flag"
  -> assertSafeModelValue (throws early on invalid value, before persist/log)
  -> listOpencodeModels() (runtime-owned probe) -> warn-if-unknown (stderr + job log, never blocking)
  -> createJob (payload.runOptions.model = full id; state entry records model + modelSource)
  -> runJobFile / background worker (warns if local opencode lacks --model support)
  -> opencode run --model kimi-for-coding/k3
```

## Error handling

- Invalid resolved model (flag or `OC_MODEL`) failing the safe-value pattern -> hard error at step 2,
  before any job is created; an invalid `OC_MODEL` can never reach the payload, logs, or a worker.
- Unknown alias -> treated as a full id and passed through; the warn-only probe flags it if the local
  opencode does not list it. opencode remains the final authority.
- Probe failure (timeout, non-zero exit, offline) -> validation is skipped with a single job-log note
  (`model check skipped (probe failed)`) when a model was requested; the run proceeds.
- Local opencode without `--model` support -> explicit warning in log + stderr; run continues with the
  model omitted (current silent behavior becomes visible).
- No `OC_MODEL` and no `--model` -> behavior unchanged from today (no `--model` emitted).

## Security considerations

- Alias resolution happens before the existing `SAFE_VALUE_PATTERN` validation; resolved values are full
  ids from a fixed map, so alias input cannot widen the injection surface.
- `OC_MODEL` is read only from the process environment of the invoking host; it is never read from job
  payloads or user prompt text. It is validated before persistence, so it cannot inject control
  characters into logs, terminal output, or state files.
- The `opencode models` probe lives in `oc-runtime.mjs`, is `spawnSync` with `shell: false`, fixed argv,
  and a bounded timeout — no user input reaches it.
- `oc_rescue` gaining `model` does not change its sandbox posture: still the read-only `plan` agent,
  still no edit-enabling or permission-bypass flags.

## Test plan

New `tests/oc-models.test.mjs` plus focused rewrites in existing suites (Node test runner, fake
`opencode` binary on `PATH` as in `tests/oc-runtime.test.mjs`).

Test infrastructure (Codex review finding #6):

- Fake `opencode` binaries must dispatch on argv: `--help` (help text), `models` (prints a fixed model
  list), otherwise `run` behavior — so the probe never confuses a run fake, and the hanging-fake timeout
  test cannot block the 20s probe (the fake answers `models` instantly; probe timeout is also injectable).
- `fakeEnv` sets `OC_MODEL: ""` so tests never inherit an ambient developer value.

Unit tests (`models.mjs`, pure):

- Each alias resolves; full ids pass through; unknown alias passes through; precedence
  flag > `OC_MODEL` > null; alias inside `OC_MODEL` resolves; empty `OC_MODEL` treated as unset;
  `--model ""` / whitespace-only flag value treated as unset and falls back to `OC_MODEL` (agy #3).
- `unknownModelWarning`: found -> null; missing -> warning string; `models === null` -> null.

Runtime tests:

- `listOpencodeModels`: parses a fake listing (including a colorized/ANSI-noisy variant, agy #2);
  returns `null` on non-zero exit, on spawn error, and on timeout (with a shrunk `timeoutMs`).
- `runJobFile` writes the unsupported-`--model` warning to the job log exactly once and emits it via
  `process.stderr.write()` so it is visible on successful foreground runs (agy #1).

Companion/integration tests:

- Review run with `--model kimi`: job payload + state entry record the resolved full id; output line and
  job log show model + source exactly once (Codex review finding #8).
- `renderStatus` appends the resolved model on a job entry that has one (Opus finding #2).
- `setup` output lists the alias table and the current `OC_MODEL` value or "unset" (Opus finding #2).
- Probe returning `null` while a model is set: job log contains the `model check skipped (probe failed)`
  line exactly once, and the job still succeeds (Opus finding #5).
- Unlisted model prints a warning but the job still succeeds; failing probe produces no warning and the
  job still succeeds.
- Invalid `OC_MODEL` fails before job creation (no payload file written).
- **Automated background test** (Codex review finding #7): `--background` with `OC_MODEL=glm` and with an
  explicit flag; poll job completion and assert the fake `run` received the resolved full id, including
  flag-over-env precedence.

MCP tests (Codex review finding #5 — rewrite, not just add):

- Rewrite the existing rescue test block: assert `oc_rescue` inputSchema **has** `model`; a call with
  `model: "kimi"` results in `payload.runOptions.model === "kimi-for-coding/k3"` (the payload stores the
  **resolved** id, not the alias — Opus finding #6); unknown arguments,
  edit-enabling, permission-bypass, and `session` remain rejected.
- The MCP test client env also sets `OC_MODEL: ""` so ambient developer values cannot leak in
  (Opus finding #3; same hygiene as the runtime `fakeEnv`, per Codex finding #6).

Regression:

- The full existing suite (`npm test`) passes unchanged when no model options are used.

## Rollout

1. Implement `lib/models.mjs` (pure) + `listOpencodeModels`/`assertSafeModelValue` in `oc-runtime.mjs`.
2. Wire companion (`runPromptJob` order above, setup output, status rendering).
3. MCP server changes (schema, `rescueArgs`, descriptions).
4. Tests per plan above; `npm test` green.
5. Docs listed above.
6. Manual smoke: `node plugins/oc/scripts/oc-companion.mjs review --model kimi --background` on this repo,
   then `oc_status`/`oc_result`; same with `OC_MODEL=glm` and no flag. Plus one bogus-model run
   (`--model acme/nope-1`) confirming the warning appears on stderr and in the job log (Opus finding #4).
   Note: the real `opencode models` output format on 1.17.20 was verified during design (plain
   newline-separated `provider/model` ids, no ANSI decoration) — re-verify at rollout in case it changed.
