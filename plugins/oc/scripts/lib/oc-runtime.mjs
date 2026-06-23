import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const DEFAULT_TIMEOUT = "10m0s";
const GO_DURATION_PATTERN = /^(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+$/;
const FORCE_KILL_GRACE_MS = 2000;
const HELP_PROBE_TIMEOUT_MS = 20_000;
// opencode parses argv values that begin with "-" as flags. A user-controlled
// model or session value must therefore start with an alphanumeric character
// so it can never be injected as a flag, and must be bounded and free of
// whitespace/shell metacharacters.
const SAFE_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,127}$/;

function nowIso() {
  return new Date().toISOString();
}

function workspaceSlug(cwd) {
  const base = path.basename(cwd) || "workspace";
  const slug = base.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 16);
  return `${slug}-${hash}`;
}

export function resolveStateDir(cwd = process.cwd(), env = process.env) {
  if (env.CLAUDE_PLUGIN_DATA) {
    return path.join(env.CLAUDE_PLUGIN_DATA, "state");
  }
  return path.join(os.tmpdir(), "oc-companion", workspaceSlug(cwd));
}

export function resolveJobsDir(cwd = process.cwd(), env = process.env) {
  return path.join(resolveStateDir(cwd, env), JOBS_DIR_NAME);
}

export function resolveStateFile(cwd = process.cwd(), env = process.env) {
  return path.join(resolveStateDir(cwd, env), STATE_FILE_NAME);
}

export function ensureStateDir(cwd = process.cwd(), env = process.env) {
  fs.mkdirSync(resolveJobsDir(cwd, env), { recursive: true });
}

function normalizeArgvValue(value, label) {
  const text = String(value).trim();
  if (!SAFE_VALUE_PATTERN.test(text)) {
    throw new Error(`${label} contains unsupported characters or starts with "-"`);
  }
  return text;
}

export function normalizeRunOptions(options = {}) {
  const prompt = String(options.prompt ?? "").trim();
  if (!prompt) {
    throw new Error("prompt is required");
  }

  const timeout = String(options.timeout ?? DEFAULT_TIMEOUT).trim();
  if (!GO_DURATION_PATTERN.test(timeout)) {
    throw new Error("timeout must be a Go duration such as 30s or 10m0s");
  }

  const model = options.model ? normalizeArgvValue(options.model, "model") : null;
  const session = options.session ? normalizeArgvValue(options.session, "session") : null;

  return {
    prompt,
    timeout,
    sandbox: options.sandbox === undefined ? true : Boolean(options.sandbox),
    dangerouslySkipPermissions: Boolean(options.dangerouslySkipPermissions),
    continueLast: Boolean(options.continueLast),
    session,
    model
  };
}

export function goDurationToMilliseconds(duration) {
  const value = String(duration ?? "").trim();
  if (!GO_DURATION_PATTERN.test(value)) {
    throw new Error("duration must be a Go duration such as 30s or 10m0s");
  }

  const unitToMilliseconds = {
    ns: 1 / 1_000_000,
    us: 1 / 1000,
    "µs": 1 / 1000,
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000
  };
  let total = 0;
  const matcher = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;
  for (const match of value.matchAll(matcher)) {
    total += Number(match[1]) * unitToMilliseconds[match[2]];
  }
  return Math.ceil(total);
}

const DEFAULT_SUPPORTS = {
  run: true,
  agent: true,
  pure: true,
  model: true,
  session: true,
  continue: true,
  dangerouslySkipPermissions: true
};

export function buildOpencodeArgv(options = {}, supports = DEFAULT_SUPPORTS) {
  const normalized = normalizeRunOptions(options);
  const argv = ["run"];

  // "Sandbox"/read-only maps to opencode's read-only `plan` agent (which denies
  // file edits); edits map to the primary `build` agent. opencode has no
  // process-level sandbox flag, so read-only is also reinforced with `--pure`
  // (no external/project plugins run) and prompt-level read-only constraints.
  if (supports.agent) {
    argv.push("--agent", normalized.sandbox ? "plan" : "build");
  }
  if (normalized.sandbox && supports.pure) {
    argv.push("--pure");
  }
  // Dangerous permission bypass is never default and only emitted when the
  // local opencode build actually advertises the flag.
  if (normalized.dangerouslySkipPermissions && supports.dangerouslySkipPermissions) {
    argv.push("--dangerously-skip-permissions");
  }
  if (normalized.model && supports.model) {
    argv.push("--model", normalized.model);
  }
  if (normalized.continueLast && supports.continue) {
    argv.push("--continue");
  }
  if (normalized.session && supports.session) {
    argv.push("--session", normalized.session);
  }

  // opencode run reads the prompt from stdin when no positional message is
  // given. Keeping the prompt out of argv also keeps it off the OS process
  // list, so it is intentionally absent here and piped via stdin in runJobFile().
  return argv;
}

export function generateJobId(prefix = "oc") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function defaultState() {
  return {
    version: 1,
    jobs: []
  };
}

export function loadState(cwd = process.cwd(), env = process.env) {
  const stateFile = resolveStateFile(cwd, env);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

export function saveState(cwd, state, env = process.env) {
  ensureStateDir(cwd, env);
  const nextState = {
    version: 1,
    jobs: [...(state.jobs ?? [])]
      .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
      .slice(0, 50)
  };
  fs.writeFileSync(resolveStateFile(cwd, env), `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  return nextState;
}

export function upsertJob(cwd, patch, env = process.env) {
  const state = loadState(cwd, env);
  const timestamp = nowIso();
  const existingIndex = state.jobs.findIndex((job) => job.id === patch.id);
  if (existingIndex === -1) {
    state.jobs.unshift({
      createdAt: timestamp,
      updatedAt: timestamp,
      ...patch
    });
  } else {
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...patch,
      updatedAt: timestamp
    };
  }
  return saveState(cwd, state, env);
}

export function listJobs(cwd = process.cwd(), env = process.env) {
  return [...loadState(cwd, env).jobs].sort((left, right) =>
    String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
  );
}

export function resolveJobPaths(cwd, jobId, env = process.env) {
  const jobsDir = resolveJobsDir(cwd, env);
  return {
    jobFile: path.join(jobsDir, `${jobId}.json`),
    logFile: path.join(jobsDir, `${jobId}.log`),
    promptFile: path.join(jobsDir, `${jobId}.prompt.md`),
    resultFile: path.join(jobsDir, `${jobId}.result.md`)
  };
}

export function writeJobPayload(cwd, payload, env = process.env) {
  ensureStateDir(cwd, env);
  fs.writeFileSync(payload.jobFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload.jobFile;
}

export function readJobPayload(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

export function createJob(cwd, options, env = process.env) {
  const id = generateJobId(options.kind ?? "oc");
  const paths = resolveJobPaths(cwd, id, env);
  const prompt = String(options.prompt ?? "");
  fs.mkdirSync(path.dirname(paths.jobFile), { recursive: true });
  fs.writeFileSync(paths.promptFile, prompt, "utf8");

  const payload = {
    id,
    kind: options.kind ?? "task",
    cwd: path.resolve(cwd),
    status: "queued",
    promptFile: paths.promptFile,
    logFile: paths.logFile,
    resultFile: paths.resultFile,
    jobFile: paths.jobFile,
    runOptions: {
      prompt,
      timeout: options.timeout ?? DEFAULT_TIMEOUT,
      sandbox: options.sandbox ?? true,
      dangerouslySkipPermissions: Boolean(options.dangerouslySkipPermissions),
      continueLast: Boolean(options.continueLast),
      session: options.session ?? null,
      model: options.model ?? null
    }
  };

  writeJobPayload(cwd, payload, env);
  upsertJob(cwd, {
    id,
    kind: payload.kind,
    status: payload.status,
    cwd: payload.cwd,
    jobFile: payload.jobFile,
    logFile: payload.logFile,
    resultFile: payload.resultFile,
    promptFile: payload.promptFile
  }, env);
  return payload;
}

export function findJob(cwd, reference = null, env = process.env) {
  const jobs = listJobs(cwd, env);
  if (!reference) {
    return jobs[0] ?? null;
  }
  const exact = jobs.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }
  const matches = jobs.filter((job) => job.id.startsWith(reference));
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous.`);
  }
  return null;
}

export function analyzeOpencodeHelpResult(result) {
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const supports = {
    run: /\brun\b/.test(output),
    agent: output.includes("--agent"),
    pure: output.includes("--pure"),
    model: output.includes("--model") || output.includes("-m,"),
    session: output.includes("--session") || output.includes("-s,"),
    continue: output.includes("--continue") || output.includes("-c,"),
    dangerouslySkipPermissions: output.includes("--dangerously-skip-permissions")
  };
  return {
    // `--agent` is the stable signal that `opencode run --help` loaded and that
    // this build supports the read-only/edit agent split the plugin relies on.
    available: result.status === 0 && supports.agent,
    status: result.status,
    error: result.error?.message ?? null,
    help: output,
    supports
  };
}

export function opencodeAvailable(cwd = process.cwd(), env = process.env) {
  const result = spawnSync("opencode", ["run", "--help"], {
    cwd,
    env,
    encoding: "utf8",
    timeout: HELP_PROBE_TIMEOUT_MS
  });
  return analyzeOpencodeHelpResult(result);
}

export async function runJobFile(jobFile, env = process.env) {
  const payload = readJobPayload(jobFile);
  const cwd = payload.cwd;
  const startedAt = nowIso();

  upsertJob(cwd, {
    id: payload.id,
    status: "running",
    startedAt,
    pid: process.pid
  }, env);

  const opencode = opencodeAvailable(cwd, env);
  const argv = buildOpencodeArgv(payload.runOptions, opencode.supports);
  await fs.promises.appendFile(payload.logFile, `$ opencode ${argv.map((arg) => JSON.stringify(arg)).join(" ")}\n`, "utf8");

  return new Promise((resolve) => {
    const child = spawn("opencode", argv, {
      cwd,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });

    upsertJob(cwd, {
      id: payload.id,
      childPid: child.pid
    }, env);

    let stdout = "";
    let stderr = "";
    let stdinError = null;
    let timedOut = false;
    let settled = false;
    let forceKillTimer = null;
    // Clamp to the 32-bit setTimeout ceiling: a duration above ~24.8 days would
    // otherwise overflow and fire almost immediately, killing the job at once.
    const timeoutMs = Math.min(goDurationToMilliseconds(payload.runOptions.timeout), 2_147_483_647);
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      const message = `opencode timed out after ${payload.runOptions.timeout}\n`;
      stderr += message;
      fs.appendFileSync(payload.logFile, message, "utf8");
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, FORCE_KILL_GRACE_MS);
      forceKillTimer.unref();
    }, timeoutMs);
    timeoutTimer.unref();

    function clearProcessTimers() {
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
    }

    function recordStdinError(error) {
      if (stdinError) {
        return;
      }
      stdinError = error;
      const message = `opencode stdin write failed: ${error.message}\n`;
      stderr += message;
      fs.appendFileSync(payload.logFile, message, "utf8");
      if (!settled) {
        child.kill("SIGTERM");
      }
    }

    // setEncoding routes chunks through a StringDecoder that holds incomplete
    // multibyte sequences across boundaries, so Thai/CJK chars never split.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (text) => {
      stdout += text;
      fs.appendFileSync(payload.logFile, text, "utf8");
    });

    child.stderr.on("data", (text) => {
      stderr += text;
      fs.appendFileSync(payload.logFile, text, "utf8");
    });

    if (child.stdin) {
      child.stdin.on("error", recordStdinError);
      try {
        child.stdin.end(payload.runOptions.prompt ?? "", "utf8");
      } catch (error) {
        recordStdinError(error);
      }
    }

    child.on("error", (error) => {
      clearProcessTimers();
      const endedAt = nowIso();
      fs.writeFileSync(payload.resultFile, `opencode failed to start: ${error.message}\n`, "utf8");
      upsertJob(cwd, {
        id: payload.id,
        status: "failed",
        error: error.message,
        endedAt
      }, env);
      resolve({ status: "failed", stdout, stderr, error });
    });

    child.on("close", (exitCode, signal) => {
      if (settled) {
        return;
      }
      clearProcessTimers();
      const endedAt = nowIso();
      // Keep result.md clean: on success only the model's stdout is captured
      // (opencode streams log noise such as "service=models refreshing" to
      // stderr). Failures surface stderr, and timeout/stdin failures write an
      // explicit sentinel so the result is never empty.
      let resultText;
      if (timedOut) {
        resultText = `${stdout ? `${stdout}\n` : ""}opencode timed out after ${payload.runOptions.timeout}\n`;
      } else if (stdinError) {
        resultText = `${stdout ? `${stdout}\n` : ""}opencode stdin write failed: ${stdinError.message}\n`;
      } else if (exitCode === 0) {
        resultText = stdout;
      } else {
        resultText = stdout || stderr || "";
      }
      const status = timedOut || stdinError ? "failed" : exitCode === 0 ? "succeeded" : "failed";
      fs.writeFileSync(payload.resultFile, resultText, "utf8");
      upsertJob(cwd, {
        id: payload.id,
        status,
        exitCode,
        signal,
        error: timedOut
          ? `opencode timed out after ${payload.runOptions.timeout}`
          : stdinError
            ? `opencode stdin write failed: ${stdinError.message}`
            : undefined,
        endedAt
      }, env);
      resolve({ status, stdout, stderr, exitCode, signal });
    });
  });
}

export function startBackgroundWorker(cwd, jobFile, workerFile, env = process.env) {
  const child = spawn(process.execPath, [workerFile, jobFile], {
    cwd,
    env,
    detached: true,
    stdio: "ignore",
    shell: false
  });
  child.unref();
  return child.pid;
}

export function cancelJob(cwd, job, env = process.env) {
  if (!job || !["queued", "running"].includes(job.status)) {
    return false;
  }

  const targetPid = job.childPid ?? job.pid;
  if (!targetPid) {
    upsertJob(cwd, { id: job.id, status: "cancelled", endedAt: nowIso() }, env);
    return true;
  }

  try {
    process.kill(-targetPid, "SIGTERM");
  } catch {
    try {
      process.kill(targetPid, "SIGTERM");
    } catch {
      // The process may have already exited. Still mark the job as cancelled
      // because the user explicitly requested cancellation.
    }
  }

  upsertJob(cwd, { id: job.id, status: "cancelled", endedAt: nowIso() }, env);
  return true;
}
