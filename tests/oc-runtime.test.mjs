import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  analyzeOpencodeHelpResult,
  buildOpencodeArgv,
  createJob,
  goDurationToMilliseconds,
  normalizeRunOptions,
  runJobFile,
  resolveStateDir
} from "../plugins/oc/scripts/lib/oc-runtime.mjs";
import { collectGitReviewContext } from "../plugins/oc/scripts/lib/git-context.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_HELP = "run --agent --model --session --continue --pure --dangerously-skip-permissions";

function writeFakeOpencode(binDir, script) {
  fs.mkdirSync(binDir, { recursive: true });
  const fake = path.join(binDir, "opencode");
  fs.writeFileSync(fake, script, "utf8");
  fs.chmodSync(fake, 0o755);
  return fake;
}

function fakeEnv(cwd, binDir) {
  return {
    ...process.env,
    CLAUDE_PLUGIN_DATA: path.join(cwd, "plugin-data"),
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`
  };
}

test("buildOpencodeArgv maps read-only review to the plan agent plus --pure; prompt is never in argv", () => {
  const prompt = 'review this"; rm -rf / #';
  const argv = buildOpencodeArgv({ prompt, sandbox: true });

  // opencode run reads the prompt from stdin. Keeping it out of argv also keeps
  // it off the OS process list, so it is intentionally absent here.
  assert.deepEqual(argv, ["run", "--agent", "plan", "--pure"]);
  assert.ok(!argv.includes(prompt));
});

test("buildOpencodeArgv maps edit/rescue mode to the build agent and emits no agy-only flags", () => {
  const argv = buildOpencodeArgv({ prompt: "x", sandbox: false });
  assert.deepEqual(argv, ["run", "--agent", "build"]);
  for (const stale of ["--print", "--print-timeout", "--sandbox", "--add-dir", "--log-file", "--pure"]) {
    assert.ok(!argv.includes(stale), `${stale} must not appear`);
  }
});

test("buildOpencodeArgv passes model, continue, and session through in order", () => {
  const argv = buildOpencodeArgv({
    prompt: "x",
    sandbox: false,
    model: "anthropic/claude-opus-4",
    continueLast: true,
    session: "abc123"
  });
  assert.deepEqual(argv, [
    "run",
    "--agent",
    "build",
    "--model",
    "anthropic/claude-opus-4",
    "--continue",
    "--session",
    "abc123"
  ]);
});

test("dangerous permission bypass is explicit, never enabled by default, and gated on support", () => {
  assert.ok(!buildOpencodeArgv({ prompt: "x" }).includes("--dangerously-skip-permissions"));
  assert.ok(
    buildOpencodeArgv({ prompt: "x", dangerouslySkipPermissions: true }).includes("--dangerously-skip-permissions")
  );
  // When the local opencode build does not advertise the flag, it is omitted.
  assert.ok(
    !buildOpencodeArgv({ prompt: "x", dangerouslySkipPermissions: true }, { agent: true, dangerouslySkipPermissions: false })
      .includes("--dangerously-skip-permissions")
  );
});

test("buildOpencodeArgv omits flags the local opencode build does not support", () => {
  const argv = buildOpencodeArgv({ prompt: "x", sandbox: true }, { agent: false, pure: false });
  assert.deepEqual(argv, ["run"]);
});

test("normalizeRunOptions rejects argv-injecting model and session values", () => {
  assert.throws(() => normalizeRunOptions({ prompt: "x", model: "-evil" }), /model/i);
  assert.throws(() => normalizeRunOptions({ prompt: "x", session: "--dangerously-skip-permissions" }), /session/i);
  // Legitimate values are accepted.
  assert.equal(normalizeRunOptions({ prompt: "x", model: "anthropic/claude-opus-4" }).model, "anthropic/claude-opus-4");
});

test("normalizeRunOptions rejects invalid user-controlled values with opencode-accurate messages", () => {
  assert.throws(() => normalizeRunOptions({ prompt: "" }), /prompt is required/i);
  assert.throws(() => normalizeRunOptions({ prompt: "x", timeout: "../bad" }), /timeout must be a Go duration/i);
});

test("state dir prefers CLAUDE_PLUGIN_DATA and falls back outside the workspace as oc-companion", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oc-runtime-"));
  const pluginData = path.join(cwd, "plugin-data");

  assert.equal(resolveStateDir(cwd, { CLAUDE_PLUGIN_DATA: pluginData }), path.join(pluginData, "state"));
  assert.ok(resolveStateDir(cwd, {}).startsWith(path.join(os.tmpdir(), "oc-companion")));
});

test("analyzeOpencodeHelpResult treats EPERM with valid help output as available", () => {
  const report = analyzeOpencodeHelpResult({
    status: 0,
    error: new Error("spawnSync opencode EPERM"),
    stdout: "",
    stderr: "run --agent --model --session --continue --pure"
  });

  assert.equal(report.available, true);
  assert.equal(report.error, "spawnSync opencode EPERM");
  assert.equal(report.supports.agent, true);
  assert.equal(report.supports.pure, true);
});

test("analyzeOpencodeHelpResult reports unavailable when the --agent flag is missing", () => {
  const report = analyzeOpencodeHelpResult({
    status: 0,
    error: null,
    stdout: "run --model --session",
    stderr: ""
  });
  assert.equal(report.available, false);
  assert.equal(report.supports.agent, false);
});

test("goDurationToMilliseconds parses bounded Go-style durations", () => {
  assert.equal(goDurationToMilliseconds("100ms"), 100);
  assert.equal(goDurationToMilliseconds("1.5s"), 1500);
  assert.equal(goDurationToMilliseconds("10m0s"), 600000);
  assert.equal(goDurationToMilliseconds("1h30m"), 5400000);
});

test("runJobFile enforces a hard wrapper timeout because opencode has no run-timeout flag", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oc-timeout-"));
  const binDir = path.join(cwd, "bin");
  writeFakeOpencode(
    binDir,
    `#!/usr/bin/env node
if (process.argv.includes("--help")) {
  console.log("${FAKE_HELP}");
  process.exit(0);
}
setTimeout(() => process.stdout.write("late output"), 1000);
`
  );

  const env = fakeEnv(cwd, binDir);
  const payload = createJob(cwd, {
    kind: "rescue",
    prompt: "x",
    timeout: "100ms",
    sandbox: true
  }, env);

  const result = await runJobFile(payload.jobFile, env);

  assert.equal(result.status, "failed");
  assert.match(fs.readFileSync(payload.resultFile, "utf8"), /timed out after 100ms/i);
});

test("runJobFile pipes the prompt through stdin without leaking it to argv or command logs", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oc-stdin-"));
  const binDir = path.join(cwd, "bin");
  writeFakeOpencode(
    binDir,
    `#!/usr/bin/env node
if (process.argv.includes("--help")) {
  console.log("${FAKE_HELP}");
  process.exit(0);
}
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin }));
});
`
  );

  const env = fakeEnv(cwd, binDir);
  const prompt = 'review this"; keep me off argv';
  const payload = createJob(cwd, {
    kind: "rescue",
    prompt,
    timeout: "5s",
    sandbox: true
  }, env);

  const result = await runJobFile(payload.jobFile, env);
  const out = JSON.parse(result.stdout);
  const log = fs.readFileSync(payload.logFile, "utf8");

  assert.equal(result.status, "succeeded");
  assert.equal(out.stdin, prompt);
  assert.ok(!out.argv.includes(prompt));
  assert.ok(!log.includes(prompt));
  assert.match(log, /\$ opencode "run"/);
});

test("runJobFile keeps opencode stderr log noise out of the clean result file", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oc-clean-"));
  const binDir = path.join(cwd, "bin");
  writeFakeOpencode(
    binDir,
    `#!/usr/bin/env node
if (process.argv.includes("--help")) {
  console.log("${FAKE_HELP}");
  process.exit(0);
}
process.stderr.write("service=models refreshing NOISE_LINE\\n");
process.stdout.write("CLEAN_RESULT");
process.exit(0);
`
  );

  const env = fakeEnv(cwd, binDir);
  const payload = createJob(cwd, { kind: "review", prompt: "x", timeout: "5s", sandbox: true }, env);
  const result = await runJobFile(payload.jobFile, env);
  const resultText = fs.readFileSync(payload.resultFile, "utf8");
  const log = fs.readFileSync(payload.logFile, "utf8");

  assert.equal(result.status, "succeeded");
  assert.equal(resultText, "CLEAN_RESULT");
  assert.ok(!resultText.includes("NOISE_LINE"));
  // The log keeps everything for debugging.
  assert.ok(log.includes("NOISE_LINE"));
});

test("runJobFile survives stdin EPIPE when opencode exits before draining a large prompt", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oc-epipe-"));
  const binDir = path.join(cwd, "bin");
  writeFakeOpencode(
    binDir,
    `#!/usr/bin/env node
if (process.argv.includes("--help")) {
  console.log("${FAKE_HELP}");
  process.exit(0);
}
process.exit(0);
`
  );

  const helper = path.join(cwd, "run-helper.mjs");
  fs.writeFileSync(
    helper,
    `import { createJob, runJobFile } from ${JSON.stringify(path.join(ROOT, "plugins/oc/scripts/lib/oc-runtime.mjs"))};
import fs from "node:fs";
import path from "node:path";

const cwd = ${JSON.stringify(cwd)};
const env = {
  ...process.env,
  CLAUDE_PLUGIN_DATA: path.join(cwd, "plugin-data"),
  PATH: ${JSON.stringify(binDir)} + path.delimiter + process.env.PATH
};
const payload = createJob(cwd, {
  kind: "rescue",
  prompt: "x".repeat(16 * 1024 * 1024),
  timeout: "5s",
  sandbox: true
}, env);
const result = await runJobFile(payload.jobFile, env);
await new Promise((resolve) => setTimeout(resolve, 100));
if (result.status !== "failed") {
  throw new Error("expected stdin write failure to fail the job");
}
const resultText = fs.readFileSync(payload.resultFile, "utf8");
if (!/stdin write failed/i.test(resultText)) {
  throw new Error("expected result file to mention stdin write failure");
}
`,
    "utf8"
  );

  const result = spawnSync(process.execPath, [helper], {
    cwd,
    env: fakeEnv(cwd, binDir),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
});

test("git review context skips untracked symlinks instead of following them into secrets", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oc-symlink-"));
  spawnSync("git", ["init"], { cwd, encoding: "utf8" });
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "oc-secret-"));
  const secretFile = path.join(external, "id_rsa");
  fs.writeFileSync(secretFile, "SUPER_SECRET_KEY_MATERIAL\n", "utf8");
  fs.symlinkSync(secretFile, path.join(cwd, "leak.txt"));

  const context = collectGitReviewContext(cwd);

  assert.match(context.content, /leak\.txt/);
  assert.match(context.content, /skipped: symbolic link/i);
  assert.ok(!context.content.includes("SUPER_SECRET_KEY_MATERIAL"));
});

test("git review context includes bounded untracked file contents", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oc-git-context-"));
  spawnSync("git", ["init"], { cwd, encoding: "utf8" });
  fs.writeFileSync(path.join(cwd, "new-feature.js"), "export const value = 42;\n", "utf8");

  const context = collectGitReviewContext(cwd);

  assert.match(context.content, /## untracked file contents/);
  assert.match(context.content, /### new-feature\.js/);
  assert.match(context.content, /export const value = 42;/);
});

test("git review context rejects a flag-like base ref before it reaches git", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oc-base-"));
  spawnSync("git", ["init"], { cwd, encoding: "utf8" });
  const injected = path.join(cwd, "oc-base-injection");

  // A base beginning with "-" would otherwise be parsed by git as a flag such
  // as --output=FILE, writing an attacker-chosen path. It must be rejected.
  assert.throws(
    () => collectGitReviewContext(cwd, { base: `--output=${injected}` }),
    /base ref contains unsupported characters/
  );
  assert.ok(!fs.existsSync(injected));

  // A normal rev like HEAD~1 still passes validation (no throw from the guard).
  assert.doesNotThrow(() => collectGitReviewContext(cwd, { base: "HEAD~1" }));
});
