import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { run, initGitRepo, makeTempDir } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MCP_SERVER = path.join(ROOT, "plugins", "codex", "scripts", "mcp-server.mjs");

// Drive the stdio MCP server with a full batch of newline-delimited JSON-RPC
// messages. The server processes them, then exits when stdin closes (and all
// in-flight requests have drained), so spawnSync captures every response.
function driveServer(messages, options = {}) {
  const input = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  const result = run("node", [MCP_SERVER], { cwd: ROOT, input, ...options });
  const responses = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { result, responses };
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } }
};
const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };

test("mcp server completes the initialize handshake", () => {
  const { result, responses } = driveServer([INITIALIZE, INITIALIZED]);
  assert.equal(result.status, 0, result.stderr);

  const init = responses.find((r) => r.id === 1);
  assert.ok(init, "expected an initialize response");
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "codex-gpt");
  assert.ok(init.result.capabilities.tools, "advertises tools capability");
});

test("mcp server echoes the client's protocol version", () => {
  const { responses } = driveServer([
    { ...INITIALIZE, params: { ...INITIALIZE.params, protocolVersion: "2099-01-01" } }
  ]);
  const init = responses.find((r) => r.id === 1);
  assert.equal(init.result.protocolVersion, "2099-01-01");
});

test("mcp server lists the ping tool", () => {
  const { responses } = driveServer([
    INITIALIZE,
    INITIALIZED,
    { jsonrpc: "2.0", id: 2, method: "tools/list" }
  ]);
  const list = responses.find((r) => r.id === 2);
  assert.ok(list, "expected a tools/list response");
  const names = list.result.tools.map((t) => t.name);
  assert.ok(names.includes("ping"), `ping not in tool list: ${names.join(", ")}`);
  const ping = list.result.tools.find((t) => t.name === "ping");
  assert.equal(ping.inputSchema.type, "object");
});

test("mcp server answers a ping tools/call", () => {
  const { responses } = driveServer([
    INITIALIZE,
    INITIALIZED,
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ping", arguments: { echo: "hi" } } }
  ]);
  const call = responses.find((r) => r.id === 3);
  assert.ok(call, "expected a tools/call response");
  assert.equal(call.result.isError, false);
  const text = call.result.content[0].text;
  assert.match(text, /^pong /);
  assert.match(text, /echo=hi/);
});

test("mcp server returns an error for an unknown tool", () => {
  const { responses } = driveServer([
    INITIALIZE,
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "does-not-exist", arguments: {} } }
  ]);
  const call = responses.find((r) => r.id === 4);
  assert.ok(call, "expected a response");
  assert.ok(call.error, "expected a JSON-RPC error for unknown tool");
  assert.equal(call.error.code, -32602);
});

test("mcp server replies to a JSON-RPC ping", () => {
  const { responses } = driveServer([INITIALIZE, { jsonrpc: "2.0", id: 5, method: "ping" }]);
  const pong = responses.find((r) => r.id === 5);
  assert.ok(pong, "expected a ping response");
  assert.deepEqual(pong.result, {});
});

// Exercises the real codex-companion.mjs subprocess via the fake codex fixture,
// so it proves the end-to-end shell: MCP tool -> companion -> structured JSON ->
// compact result + off-tree report file.
function setupReviewRepo() {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");
  return { repo, binDir };
}

test("adversarial_review tool returns a compact verdict and writes an off-tree report", () => {
  const { repo, binDir } = setupReviewRepo();
  const dataDir = makeTempDir();

  const { result, responses } = driveServer(
    [
      INITIALIZE,
      INITIALIZED,
      { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "adversarial_review", arguments: {} } }
    ],
    { cwd: repo, env: { ...buildEnv(binDir), CLAUDE_PLUGIN_DATA: dataDir } }
  );

  assert.equal(result.status, 0, result.stderr);
  const call = responses.find((r) => r.id === 10);
  assert.ok(call, "expected an adversarial_review response");
  assert.equal(call.result.isError, false);
  const text = call.result.content[0].text;

  assert.match(text, /needs-attention/);
  assert.match(text, /1 finding\(s\)/);
  assert.match(text, /1 high/);
  assert.match(text, /BLOCKING/);

  // The compact result must NOT inline the full finding bodies.
  assert.ok(!text.includes("The change assumes data is always present."), "report body leaked into compact result");

  // The full report is written under CLAUDE_PLUGIN_DATA, never into the repo.
  const pathMatch = text.match(/Full report: (.+)/);
  assert.ok(pathMatch, "expected a report path");
  const reportPath = pathMatch[1].trim();
  assert.ok(reportPath.startsWith(dataDir), `report not under plugin data dir: ${reportPath}`);
  assert.ok(!reportPath.startsWith(repo), "report must not be written into the reviewed tree");
  const report = fs.readFileSync(reportPath, "utf8");
  assert.match(report, /Missing empty-state guard/);
  assert.match(report, /Handle empty collections before indexing/);
});
