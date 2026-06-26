#!/usr/bin/env node
// codex-ask — the ONE canonical, read-only Codex consult/oracle entrypoint for this repo.
//
// WHY THIS EXISTS (do not reintroduce the alternatives):
//   - Raw `codex exec` spins a COLD runtime every call (no shared warm runtime, no audit).
//   - `mcp__codex-cli__codex` is SLOW (re-reads the whole thread) and renders as stuck.
//   This wrapper drives the openai-codex PLUGIN's SHARED warm runtime (codex-companion.mjs)
//   the way the plugin intends, and persists an auditable transcript. SSOT for the rule:
//   docs/orchestration/CODEX-ORACLE.md §Runtime. Write/fix work -> `/codex:rescue`;
//   broad branch review -> `/codex:adversarial-review`. This script is READ-ONLY by default.
//
// SESSION BINDING (Codex-reviewed Design B-plus):
//   Strong 1:1 — ONE Codex thread per Claude Code session. Within a session, every codex-ask
//   call reuses that session's oracle thread; a DIFFERENT Claude session gets its own (no bleed).
//   Mechanism: tag the Codex thread with a DERIVED session namespace `${claudeSessionId}:oracle`
//   (the companion filters resume + SessionEnd-cleanup by CODEX_COMPANION_SESSION_ID). The
//   `:oracle` suffix isolates the oracle thread from `/codex:rescue` threads (which use the bare
//   session id) so a rescue run can't hijack the oracle thread. FAILS CLOSED if no session id is
//   present (never falls back to workspace/cross-session scope).
//   Subagents: there is NO env signal to auto-detect a subagent, and `--fresh` alone is not enough
//   (a fresh oracle thread still becomes "newest" and would be resumed by the main session). A
//   subagent that must call Codex uses `--isolated`/`--subagent` (a unique one-shot namespace,
//   always fresh) OR routes through `/codex:rescue`. Leaf agents MUST NOT call plain `codex-ask`.
//
// USAGE:
//   node scripts/codex-ask.mjs [--slug s] [--effort none|minimal|low|medium|high|xhigh]
//                              [--model m] [--write] [--fresh] [--isolated|--subagent]
//                              [--timeout SEC] [--stall SEC]
//                              [--file PROMPT.md | -- "prompt text" | (stdin)]
//   make codex-ask Q="prompt text" [SLUG=... EFFORT=high]
//   --fresh    : start a NEW oracle thread for this session (e.g. an ORACLE GATE — must be memoryless).
//   --isolated : one-shot isolated thread (for subagents); never reused, never pollutes the main thread.
//
// RELIABILITY: long runs are launched with `task --background`, polled via `status --json` to a
//   terminal state with a stall detector, then fetched via `result --json` — decoupling a slow
//   Codex run from any caller timeout. FAILS CLOSED (non-zero exit + FAILED transcript) on a
//   wedged/empty/failed job.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();

function die(msg) {
  process.stderr.write(`codex-ask: ${msg}\n`);
  process.exit(2);
}

// ---- 1. Resolve the companion helper (drift-proof, in priority order) -------------------
//   1) $CODEX_COMPANION explicit override
//   2) $CLAUDE_PLUGIN_ROOT/scripts/codex-companion.mjs (the plugin's own contract)
//   3) newest installed openai-codex plugin under the cache (validated to exist).
function resolveCompanion() {
  const candidates = [];
  if (process.env.CODEX_COMPANION) candidates.push(process.env.CODEX_COMPANION);
  if (process.env.CLAUDE_PLUGIN_ROOT)
    candidates.push(path.join(process.env.CLAUDE_PLUGIN_ROOT, "scripts", "codex-companion.mjs"));
  const cacheRoot = path.join(HOME, ".claude", "plugins", "cache", "openai-codex", "codex");
  if (fs.existsSync(cacheRoot)) {
    const versions = fs
      .readdirSync(cacheRoot)
      .filter((v) => fs.existsSync(path.join(cacheRoot, v, "scripts", "codex-companion.mjs")))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) candidates.push(path.join(cacheRoot, v, "scripts", "codex-companion.mjs"));
  }
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  die(
    "no codex-companion.mjs found. Install the openai-codex plugin or set $CODEX_COMPANION. " +
      "Run /codex:setup to check readiness."
  );
}

function companionVersion(companionPath) {
  const m = companionPath.match(/openai-codex\/codex\/([^/]+)\//);
  return m ? m[1] : "unknown";
}

function parseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function utcStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function slugify(s) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "ask"
  );
}

// ---- 2. Args ----------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    effort: null, model: null, slug: "ask", write: false,
    timeoutSec: 900, stallSec: 240, file: null, fresh: false, isolated: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--effort") opts.effort = argv[++i];
    else if (a === "--model") opts.model = argv[++i];
    else if (a === "--slug") opts.slug = argv[++i];
    else if (a === "--timeout") opts.timeoutSec = Number(argv[++i]);
    else if (a === "--stall") opts.stallSec = Number(argv[++i]);
    else if (a === "--file") opts.file = argv[++i];
    else if (a === "--write") opts.write = true;
    else if (a === "--read-only") opts.write = false;
    else if (a === "--fresh") opts.fresh = true;
    else if (a === "--resume" || a === "--resume-last") opts.fresh = false;
    else if (a === "--isolated" || a === "--subagent") opts.isolated = true;
    else if (a === "--") rest.push(...argv.slice(i + 1)), (i = argv.length);
    else rest.push(a);
  }
  opts.prompt = rest.join(" ").trim();
  return opts;
}

function readPrompt(opts) {
  if (opts.file) return fs.readFileSync(opts.file, "utf8").trim();
  if (opts.prompt) return opts.prompt;
  try {
    const s = fs.readFileSync(0, "utf8").trim();
    if (s) return s;
  } catch {
    /* no stdin */
  }
  die("no prompt given. Pass it as args, --file PATH, or on stdin.");
}

// ---- 3. Session binding: derive the per-Claude-session oracle namespace ------------------
const opts = parseArgs(process.argv.slice(2));
const stamp = utcStamp();
const nativeSession = process.env.CODEX_COMPANION_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || null;
let askSessionId;
let scopeLabel;
if (opts.isolated) {
  // One-shot isolated thread (subagents): unique namespace, never reused, never pollutes the main thread.
  askSessionId = `${nativeSession || "nosess"}:subagent:${process.pid}:${stamp}`;
  scopeLabel = "claude-session-subagent";
  opts.fresh = true;
} else {
  // FAIL CLOSED: never fall back to workspace/cross-session scope (Codex review).
  if (!nativeSession)
    die("no Claude session id (CODEX_COMPANION_SESSION_ID / CLAUDE_CODE_SESSION_ID). Run inside a Claude session, or use --isolated.");
  askSessionId = `${nativeSession}:oracle`;
  scopeLabel = "claude-session-oracle";
}

// All companion calls run with CODEX_COMPANION_SESSION_ID = the derived namespace, so job tagging,
// session-scoped resume, and (for the bare-session jobs) SessionEnd cleanup behave consistently.
const SESSION_ENV = { ...process.env, CODEX_COMPANION_SESSION_ID: askSessionId };

function runCompanion(companionPath, args, { timeoutMs } = {}) {
  const res = spawnSync("node", [companionPath, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    env: SESSION_ENV,
  });
  return { code: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
}

const prompt = readPrompt(opts);
const companion = resolveCompanion();
const version = companionVersion(companion);
const repoRoot = process.cwd();
const artifactsDir = path.join(repoRoot, "artifacts", "codex");
fs.mkdirSync(artifactsDir, { recursive: true });
const transcriptPath = path.join(artifactsDir, `${stamp}-${slugify(opts.slug)}.md`);

// ---- 4. Runtime mode + this-session resumable-thread detection --------------------------
let runtimeMode = "unknown";
let runtimeEndpoint = "";
let willResume = false;
let resumeFromThread = null;
let preflightNote = "";
{
  const st = parseJson(runCompanion(companion, ["status", "--all", "--json"]).stdout) || {};
  if (st.sessionRuntime) {
    runtimeMode = st.sessionRuntime.mode || "unknown";
    runtimeEndpoint = st.sessionRuntime.endpoint || "";
  }
  if (!opts.fresh) {
    // Only THIS session's oracle threads (exact sessionId match). Inspect the NEWEST one so the
    // preflight agrees with what `--resume-last` will actually resume. Collect jobs from ALL buckets:
    // `status --all --json` returns `latestFinished` as a single OBJECT and `running`/`recent` as
    // arrays — flatten both, dedupe by id (latestFinished often repeats in recent).
    const byId = new Map();
    for (const v of Object.values(st)) {
      const items = Array.isArray(v) ? v : [v];
      for (const x of items) if (x && typeof x === "object" && x.id && x.jobClass) byId.set(x.id, x);
    }
    const mine = [...byId.values()]
      .filter((j) => j.jobClass === "task" && j.sessionId === askSessionId)
      .sort((a, b) => String(b.updatedAt ?? b.createdAt ?? "").localeCompare(String(a.updatedAt ?? a.createdAt ?? "")));
    const newest = mine[0];
    if (newest) {
      if (newest.status === "completed" && newest.threadId) {
        willResume = true;
        resumeFromThread = newest.threadId;
      } else if (newest.status === "running" || newest.status === "queued") {
        // Deliberate: an active/wedged oracle turn blocks --resume-last ("still running").
        // Cancel it and start fresh rather than guess.
        runCompanion(companion, ["cancel", newest.id, "--json"]);
        preflightNote = `cancelled active oracle job ${newest.id} (${newest.status}) -> fresh`;
      }
      // failed/canceled newest -> leave willResume=false -> fresh
    }
  }
}

function writeTranscript({ status, jobId, threadId, turnId, response, error }) {
  const sandbox = opts.write ? "WRITE" : "read-only";
  const threadLine = willResume ? `RESUMED ${threadId || resumeFromThread}` : "fresh";
  const body = [
    "# codex-ask transcript",
    "",
    `- when:     ${stamp}`,
    `- runtime:  codex-companion.mjs task (openai-codex plugin v${version}) · mode=${runtimeMode}${runtimeEndpoint ? ` · ${runtimeEndpoint}` : ""}`,
    `- thread:   ${threadLine}${opts.fresh ? " (fresh)" : ""} · scope: ${scopeLabel} · ns: ${askSessionId}${preflightNote ? ` · ${preflightNote}` : ""}`,
    `- sandbox:  ${sandbox} · effort: ${opts.effort || "config-default"} · model: ${opts.model || "config-default"} · cwd: ${repoRoot}`,
    `- job:      ${jobId || "(none)"} · thread: ${threadId || "(none)"} · turn: ${turnId || "(none)"} · status: ${status}`,
    "",
    "## Prompt",
    "",
    "```",
    prompt,
    "```",
    "",
    "## Codex response",
    "",
    error ? `**FAILED (fail-closed): ${error}**` : response || "(empty)",
    "",
  ].join("\n");
  fs.writeFileSync(transcriptPath, body, "utf8");
}

// ---- 5. Launch (read-only unless --write), resume this session's oracle thread if present
const taskArgs = ["task", "--background"];
if (opts.write) taskArgs.push("--write");
if (willResume) taskArgs.push("--resume-last"); // session-scoped via SESSION_ENV -> continues THIS session's oracle thread
if (opts.model) taskArgs.push("--model", opts.model);
if (opts.effort) taskArgs.push("--effort", opts.effort);
taskArgs.push(prompt);

const launch = runCompanion(companion, taskArgs);
const launchText = `${launch.stdout}\n${launch.stderr}`;
const idMatch = launchText.match(/as\s+(task-[^\s.]+)/);
if (!idMatch) {
  writeTranscript({ status: "launch-failed", error: `could not parse job id from launch: ${launchText.trim().slice(0, 300)}` });
  die(`launch failed; see ${transcriptPath}`);
}
const jobId = idMatch[1];

// ---- 6. Poll to terminal with stall detection ------------------------------------------
const start = Date.now();
let lastSize = -1;
let lastGrow = Date.now();
let job = null;
for (;;) {
  const elapsed = (Date.now() - start) / 1000;
  if (elapsed > opts.timeoutSec) {
    runCompanion(companion, ["cancel", jobId, "--json"]);
    writeTranscript({ status: "timeout", jobId, error: `exceeded --timeout ${opts.timeoutSec}s` });
    die(`timeout after ${opts.timeoutSec}s; canceled ${jobId}; see ${transcriptPath}`);
  }
  const st = parseJson(runCompanion(companion, ["status", jobId, "--json"]).stdout);
  job = st?.job || null;
  const status = job?.status;
  if (status === "completed" || status === "failed" || status === "canceled") break;
  const logFile = job?.logFile;
  if (logFile && fs.existsSync(logFile)) {
    const size = fs.statSync(logFile).size;
    if (size > lastSize) {
      lastSize = size;
      lastGrow = Date.now();
    }
  }
  if ((Date.now() - lastGrow) / 1000 > opts.stallSec && (status === "running" || status === "queued")) {
    runCompanion(companion, ["cancel", jobId, "--json"]);
    writeTranscript({ status: "stalled", jobId, threadId: job?.threadId, error: `no log growth for ${opts.stallSec}s (wedged job)` });
    die(`stalled (no progress ${opts.stallSec}s); canceled ${jobId}; see ${transcriptPath}`);
  }
  spawnSync("sleep", ["3"]);
}

// ---- 7. Fetch + persist ----------------------------------------------------------------
const resJson = parseJson(runCompanion(companion, ["result", jobId, "--json"]).stdout);
const stored = resJson?.storedJob || resJson?.job || {};
const result = stored.result || {};
const response = (result.rawOutput || "").trim();
const threadId = stored.threadId || job?.threadId;
const turnId = stored.turnId || job?.turnId;
const finalStatus = stored.status || job?.status || "unknown";

if (finalStatus !== "completed" || !response) {
  writeTranscript({
    status: finalStatus,
    jobId,
    threadId,
    turnId,
    error: finalStatus !== "completed" ? `job ${finalStatus}` : "empty response (capture failed)",
  });
  die(`job ${finalStatus} / empty response; see ${transcriptPath}`);
}

writeTranscript({ status: finalStatus, jobId, threadId, turnId, response });
process.stdout.write(`${response}\n`);
process.stderr.write(`\ncodex-ask: transcript -> ${path.relative(repoRoot, transcriptPath)}\n`);
