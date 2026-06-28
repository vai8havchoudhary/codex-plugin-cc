#!/usr/bin/env node
/**
 * Codex plugin MCP server.
 *
 * Exposes the native GPT engine as first-class, deterministic tool calls (no
 * Sonnet relay): the main Claude Code loop calls these directly, the same way
 * it calls the built-in `advisor` tool. Each tool is a thin, non-substituting
 * shell over the existing `codex-companion.mjs` runtime — the real GPT-5.5 work
 * still happens in the companion subprocess; this server only forwards.
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdio (same framing the
 * companion's app-server client and broker already speak — see lib/app-server.mjs).
 * Pure Node built-ins, zero runtime dependencies, to match the rest of the plugin.
 *
 * Tools are added incrementally; `ping` is codex-free and exists to prove the
 * transport end-to-end before any tool depends on Codex being installed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "..");
const COMPANION = path.join(SCRIPT_DIR, "codex-companion.mjs");
const PLUGIN_MANIFEST = readPluginManifest(PLUGIN_ROOT);

const SERVER_INFO = {
  name: "codex-gpt",
  version: PLUGIN_MANIFEST.version ?? "0.0.0"
};
// Latest stdio protocol revision we implement. If the client requests a
// different revision we echo theirs back (initialize is a negotiation).
const FALLBACK_PROTOCOL_VERSION = "2025-06-18";

function readPluginManifest(pluginRoot) {
  try {
    const manifestPath = path.join(pluginRoot, ".claude-plugin", "plugin.json");
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return {};
  }
}

// --- Tool registry -------------------------------------------------------
// Each tool: { name, description, inputSchema, handler(args) -> Promise<ToolResult> }
// ToolResult: { text: string, isError?: boolean }

/** @type {Map<string, {name: string, description: string, inputSchema: object, handler: (args: object) => Promise<{text: string, isError?: boolean}>}>} */
const TOOLS = new Map();

function registerTool(tool) {
  TOOLS.set(tool.name, tool);
}

registerTool({
  name: "ping",
  description:
    "Health check for the Codex GPT engine MCP server. Returns 'pong' with the plugin version and working directory. Codex-free — use it to confirm the tool transport is wired before relying on the GPT-backed tools.",
  inputSchema: {
    type: "object",
    properties: {
      echo: {
        type: "string",
        description: "Optional text to echo back in the response."
      }
    },
    additionalProperties: false
  },
  async handler(args) {
    const echo = typeof args?.echo === "string" && args.echo.length > 0 ? ` echo=${args.echo}` : "";
    return {
      text: `pong (codex-gpt v${SERVER_INFO.version}, cwd=${process.cwd()})${echo}`
    };
  }
});

// --- Companion shell helper ----------------------------------------------
// Deterministic, non-substituting forward to the existing codex-companion.mjs
// runtime. Real GPT-5.5 work happens in that subprocess; this server never
// reasons about the task itself.

function spawnCompanion(args, { cwd, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [COMPANION, ...args], {
      cwd: cwd || process.cwd(),
      env: process.env,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ status: -1, stdout, stderr: `${stderr}${error?.message ?? error}` });
    });
    child.on("close", (code) => {
      resolve({ status: code ?? 0, stdout, stderr });
    });
    if (input != null) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

// Review artifacts must never be written into the reviewed working tree, or the
// next working-tree review would ingest its own prior output. Prefer the
// plugin's persistent data dir; fall back to a temp dir.
function reviewArtifactDir() {
  const base = process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), "codex-gpt");
  const dir = path.join(base, "reviews");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function countSeverities(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    if (counts[f.severity] !== undefined) counts[f.severity] += 1;
  }
  return counts;
}

function renderReviewMarkdown(review, meta) {
  const lines = [];
  lines.push(`# Codex Adversarial Review`);
  lines.push("");
  lines.push(`- Verdict: **${review.verdict}**`);
  if (meta.target) lines.push(`- Target: ${meta.target}`);
  if (meta.focus) lines.push(`- Focus: ${meta.focus}`);
  lines.push(`- Generated: ${meta.generatedAt}`);
  lines.push("");
  lines.push(`## Summary`);
  lines.push("");
  lines.push(review.summary || "(none)");
  lines.push("");
  lines.push(`## Findings (${review.findings.length})`);
  lines.push("");
  review.findings.forEach((f, i) => {
    const loc = f.file ? `${f.file}:${f.line_start}-${f.line_end}` : "(no location)";
    lines.push(`### ${i + 1}. [${f.severity}] ${f.title}`);
    lines.push(`*${loc}* · confidence ${f.confidence}`);
    lines.push("");
    lines.push(f.body);
    if (f.recommendation) {
      lines.push("");
      lines.push(`**Recommendation:** ${f.recommendation}`);
    }
    lines.push("");
  });
  if (Array.isArray(review.next_steps) && review.next_steps.length > 0) {
    lines.push(`## Next steps`);
    lines.push("");
    for (const step of review.next_steps) lines.push(`- ${step}`);
    lines.push("");
  }
  return lines.join("\n");
}

registerTool({
  name: "adversarial_review",
  description:
    "Run a GPT-5.5 adversarial review against the repository's LOCAL GIT STATE (challenges design/approach/tradeoffs/assumptions) and write the full findings to a file, returning only a compact verdict + count so the review doesn't flood the conversation. Read-only: it never edits code. Pair it with the karpathy tool to fix what it finds. Reviews the working tree by default; pass base/scope to target a branch diff.",
  inputSchema: {
    type: "object",
    properties: {
      focus: { type: "string", description: "What to challenge/attack (optional focus text)." },
      base: { type: "string", description: "Base ref for a branch-diff review (e.g. 'main')." },
      scope: {
        type: "string",
        enum: ["auto", "working-tree", "branch"],
        description: "Review scope. Defaults to the companion's auto selection."
      },
      effort: {
        type: "string",
        enum: ["none", "minimal", "low", "medium", "high", "xhigh"],
        description: "Reasoning effort. Defaults to xhigh (project policy)."
      },
      cwd: { type: "string", description: "Repository path. Defaults to the server's working directory." }
    },
    additionalProperties: false
  },
  async handler(args) {
    const cliArgs = ["adversarial-review", "--json"];
    if (args.base) cliArgs.push("--base", String(args.base));
    if (args.scope) cliArgs.push("--scope", String(args.scope));
    cliArgs.push("--effort", args.effort ? String(args.effort) : "xhigh");
    const focus = typeof args.focus === "string" ? args.focus.trim() : "";
    if (focus) cliArgs.push(focus);

    const { status, stdout, stderr } = await spawnCompanion(cliArgs, { cwd: args.cwd });

    let payload;
    try {
      payload = JSON.parse(stdout);
    } catch {
      const detail = stderr.trim() || stdout.trim() || `companion exited with status ${status}`;
      return { text: `Adversarial review failed to run: ${detail}`, isError: true };
    }

    const review = payload.result;
    if (!review || payload.parseError) {
      const detail = payload.parseError || payload.codex?.stderr || "review did not return structured findings";
      return { text: `Adversarial review did not produce a verdict: ${detail}`, isError: true };
    }

    const generatedAt = new Date().toISOString();
    const findings = Array.isArray(review.findings) ? review.findings : [];
    const counts = countSeverities(findings);
    const blocking = review.verdict === "needs-attention";

    const dir = reviewArtifactDir();
    const stamp = generatedAt.replace(/[:.]/g, "-");
    const reportPath = path.join(dir, `adversarial-${stamp}-${process.pid}.md`);
    fs.writeFileSync(
      reportPath,
      renderReviewMarkdown(review, { target: payload.target?.label, focus, generatedAt }),
      "utf8"
    );

    const breakdown = `${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low`;
    const text = [
      `Adversarial review: ${review.verdict} — ${findings.length} finding(s) (${breakdown}).`,
      review.summary ? `Summary: ${review.summary}` : null,
      `Full report: ${reportPath}`,
      blocking
        ? `BLOCKING: verdict is needs-attention. Hand this report path to the karpathy tool to fix, then re-review.`
        : `Non-blocking: verdict is approve.`
    ]
      .filter(Boolean)
      .join("\n");

    return { text };
  }
});

// --- JSON-RPC plumbing ---------------------------------------------------

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message, data) {
  const error = data === undefined ? { code, message } : { code, message, data };
  writeMessage({ jsonrpc: "2.0", id, error });
}

function toolResultMessage(toolResult) {
  return {
    content: [{ type: "text", text: toolResult.text }],
    isError: Boolean(toolResult.isError)
  };
}

async function handleToolsCall(id, params) {
  const name = params?.name;
  const tool = name ? TOOLS.get(name) : undefined;
  if (!tool) {
    respondError(id, -32602, `Unknown tool: ${name ?? "(missing name)"}`);
    return;
  }
  const args = params?.arguments ?? {};
  try {
    const result = await tool.handler(args);
    respond(id, toolResultMessage(result));
  } catch (error) {
    // Surface failures as a tool-level error result (isError), not a protocol
    // error, so the model sees the message and can react.
    const message = error instanceof Error ? error.message : String(error);
    respond(id, toolResultMessage({ text: `Tool ${tool.name} failed: ${message}`, isError: true }));
  }
}

async function handleMessage(message) {
  // Notifications have no id and expect no response.
  const isNotification = message.id === undefined || message.id === null;

  switch (message.method) {
    case "initialize": {
      const requested = message.params?.protocolVersion;
      respond(message.id, {
        protocolVersion: typeof requested === "string" ? requested : FALLBACK_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      });
      return;
    }
    case "notifications/initialized":
    case "initialized":
      return; // client handshake completion; nothing to send back
    case "ping":
      if (!isNotification) respond(message.id, {});
      return;
    case "tools/list":
      respond(message.id, {
        tools: [...TOOLS.values()].map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema
        }))
      });
      return;
    case "tools/call":
      await handleToolsCall(message.id, message.params);
      return;
    default:
      if (!isNotification) {
        respondError(message.id, -32601, `Method not found: ${message.method}`);
      }
  }
}

// --- stdio read loop (newline-delimited JSON) ----------------------------

function main() {
  let buffer = "";
  let pending = 0;
  let stdinEnded = false;

  // A long-lived client (Claude Code) keeps stdin open, so this server runs
  // until killed. The batched test harness pipes all messages then closes
  // stdin; in that case exit only once every in-flight request has responded,
  // so async (codex-shelling) tool calls aren't truncated on EOF.
  function maybeExit() {
    if (stdinEnded && pending === 0) {
      process.exit(0);
    }
  }

  function dispatch(message) {
    const isRequest = message.id !== undefined && message.id !== null;
    if (isRequest) pending += 1;
    Promise.resolve(handleMessage(message))
      .catch((error) => {
        process.stderr.write(`[codex-mcp] handler error: ${error?.message ?? error}\n`);
      })
      .finally(() => {
        if (isRequest) pending -= 1;
        maybeExit();
      });
  }

  process.stdin.setEncoding("utf8");

  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      const trimmed = line.trim();
      if (trimmed) {
        let message;
        try {
          message = JSON.parse(trimmed);
        } catch {
          process.stderr.write(`[codex-mcp] dropping non-JSON line\n`);
          newlineIndex = buffer.indexOf("\n");
          continue;
        }
        dispatch(message);
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });

  process.stdin.on("end", () => {
    stdinEnded = true;
    maybeExit();
  });
}

main();
