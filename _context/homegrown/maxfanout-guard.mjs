#!/usr/bin/env node
// maxfanout-guard — PreToolUse hook on the Workflow tool (scope: ~/startup).
// Enforces the maxfanout-workflow skill MECHANICALLY so an authored workflow cannot
// silently drift from the approved engine config (the failure that turned a GPT-5.5
// verify stage into Opus). Fail-closed: deny unless the script provably binds engines.
//
// Rules:
//  1. References to the removed `wf-worker-gpt` agent  -> DENY.
//  2. Any agentType not in the approved set            -> DENY (may inherit session model = Opus).
//  3. Missing the w() fail-closed engine guard         -> DENY (no runtime backstop for unbound calls).
//  4. Escape hatch: a `MAXFANOUT-APPROVED:` marker in the script -> ALLOW, with a visible warning
//     (use ONLY after the user has explicitly approved the non-standard config).
// On allow, emit a systemMessage listing the engine bindings detected, so the launch the
// user sees maps to what actually runs.

import fs from 'node:fs'

// Approved agentTypes. The codex:* / codex-* forwarders are `model: sonnet` Bash wrappers that shell
// the Codex companion (real GPT-5.5 runs IN the companion) — so they bind a real engine and never
// inherit the session model. codex-worker → PARALLEL GPT breadth worker (shells codex-consult.sh in
// --isolated mode = detached per-process job, off the warm-companion mutex, so N run concurrently);
// codex-reviewer → review/adversarial-review (work nodes); codex-ops → status/result/cancel
// (control-plane, background pattern only).
const APPROVED_AGENT_TYPES = new Set([
  'codex:codex-rescue', 'codex-worker', 'codex-reviewer', 'codex-ops',
  'wf-worker-sonnet', 'wf-reviewer-opus',
])

function emit(decision, reason, systemMessage) {
  const out = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision } }
  if (reason) out.hookSpecificOutput.permissionDecisionReason = reason
  if (systemMessage) out.systemMessage = systemMessage
  process.stdout.write(JSON.stringify(out))
  process.exit(0)
}
const allow = (msg) => emit('allow', undefined, msg)
const deny = (reason) => emit('deny', 'maxfanout-guard: ' + reason)

let raw = ''
try { raw = fs.readFileSync(0, 'utf8') } catch {}
let input = {}
try { input = JSON.parse(raw) } catch {}
const ti = input.tool_input || {}

let script = typeof ti.script === 'string' ? ti.script : ''
if (!script && typeof ti.scriptPath === 'string') {
  try { script = fs.readFileSync(ti.scriptPath, 'utf8') } catch {}
}

// Nothing inspectable (e.g. a name-only saved-workflow invocation) — cannot lint, let it through.
if (!script.trim()) allow()

// (4) explicit-approval escape hatch — visible, never silent.
if (/MAXFANOUT-APPROVED/.test(script)) {
  allow('⚠️ maxfanout-guard: launching under an explicit-approval override (non-standard engine config). Ensure the user actually approved this.')
}

// (1) the removed footgun.
if (/wf-worker-gpt/.test(script)) {
  deny("'wf-worker-gpt' is a removed footgun — it had no model binding and silently ran on Opus. For PARALLEL GPT-5.5 fan-out use agentType:'codex-worker' (or codex:codex-rescue for a lone serial task).")
}

// (2) every agentType used must be in the approved set.
const badTypes = new Set()
for (const m of script.matchAll(/agentType:\s*['"]([^'"]+)['"]/g)) {
  if (!APPROVED_AGENT_TYPES.has(m[1])) badTypes.add(m[1])
}
if (badTypes.size) {
  deny(`unapproved agentType(s): ${[...badTypes].join(', ')}. An agentType with no model: frontmatter inherits the session model (Opus). Approved: codex-worker (parallel GPT-5.5), codex:codex-rescue (serial GPT-5.5), codex-reviewer, codex-ops, wf-worker-sonnet, wf-reviewer-opus. Or add a model: to the call.`)
}

// (2b) raw Codex CLI calls are forbidden — Codex is plugin-only.
const RAW_CODEX = /(?:^|[\s;&|`'"(])codex\s+(?:exec|login|task|review|adversarial-review|e2e|completion)\b/m
if (RAW_CODEX.test(script)) {
  deny('raw codex CLI call detected — Codex is plugin-only (use the companion script or the codex:codex-rescue agent), never `codex exec`.')
}

// (3) require the w() fail-closed guard (throws on a call with no explicit engine).
const hasGuardFn = /function\s+w\s*\(\s*prompt/.test(script)
const hasEngineThrow = /throw\s+new\s+Error\([^]*?engine/i.test(script)
if (!hasGuardFn || !hasEngineThrow) {
  deny("missing the w() fail-closed engine guard. Paste the guard from the maxfanout-workflow skill (ENGINE BINDING section) and route every spawn through w(...), so an unbound call throws instead of inheriting Opus.")
}

// Allow — surface the engine bindings detected so the user can confirm the launch maps to approval.
const engines = []
if (/model:\s*['"]sonnet['"]/.test(script)) engines.push('Sonnet')
if (/agentType:\s*['"]codex:codex-rescue['"]/.test(script)) engines.push('GPT-5.5(codex task)')
if (/agentType:\s*['"]codex-worker['"]/.test(script)) engines.push('GPT-5.5(codex parallel worker)')
if (/agentType:\s*['"]codex-reviewer['"]/.test(script)) engines.push('GPT-5.5(codex review)')
if (/agentType:\s*['"]codex-ops['"]/.test(script)) engines.push('codex-ops(lifecycle)')
if (/wf-worker-sonnet/.test(script)) engines.push('Sonnet(role-agent)')
if (/model:\s*['"]opus['"]/.test(script) || /wf-reviewer-opus/.test(script)) engines.push('Opus(decider)')
allow(`maxfanout-guard ✓ engines bound: ${engines.length ? engines.join(', ') : '(none detected — verify)'}.`)
