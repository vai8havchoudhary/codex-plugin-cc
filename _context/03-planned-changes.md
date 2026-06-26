# 03 — Planned changes (what this fork carries)

Two tracks. **Track A is everything this fork can actually land.** Track B is recorded for honesty
and is *not* in the plugin's gift — it's an Anthropic harness change, filed separately.

Refs are against plugin **v1.0.5** (`plugins/codex/…`).

---

## Track A — plugin‑landable (the fork's payload)

### A1. First‑class `consult` subcommand in `codex-companion.mjs`
- **Where:** add `case "consult":` to the dispatch switch at `codex-companion.mjs:1026-1061`; add it
  to the usage string near `:82`.
- **What:** synchronous, **read‑only** Codex consult. Structured `--json` output:
  `{ status: "ok" | "unavailable", model, output, threadId }`, with **distinct exit codes**
  (0 = ok, non‑zero = unavailable). This is `codex-ask.mjs` reborn as a supported subcommand.
- **Why:** the structured `status` field makes fail‑loud **native** — no `CODEX_BEGIN/END` /
  `CODEX_UNAVAILABLE` marker parsing in callers. Kills the silent‑fallback class at the source.

### A2. `--isolated` / `--session-namespace <id>` flag (the parallelism mechanism)
- **Where:** the connect path in `lib/codex.mjs` (`mode:"shared"` @ `:910`,
  `reuseExistingBroker:true` @ `:944`/`:982`) and broker session‑dir creation in
  `lib/broker-lifecycle.mjs` (`createBrokerSessionDir`).
- **What:** when `--isolated` is set, **do not** reuse the shared broker — spawn a per‑call detached
  app‑server with its own broker session dir (unique namespace, always `--fresh`). N concurrent
  `consult --isolated` calls = N independent runtimes, **zero `BROKER_BUSY`**.
- **Why:** this is the *exact* proven mechanism behind the homegrown shim, made native. **This flag
  alone makes `codex-consult.sh` obsolete.**
- *(Alternative B, deferred: multiplex the broker at `app-server-broker.mjs:173-182` instead. See
  `02-architecture.md`. Bigger, riskier on rebase — not the first move.)*

### A3. Ship a fannable agent: `plugins/codex/agents/codex-consult.md`
- **What:** sibling to `codex-rescue.md`; `model: sonnet`; read‑only; tools `Bash`. One Bash call to
  `codex-companion.mjs consult --isolated --json`, returns stdout verbatim. This is `codex-worker`
  upstreamed and plugin‑native.
- **Why:** workflows reference `agentType: 'codex:codex-consult'` directly; no private forwarder.

### A4. Document the consult/parallel contract
- **Where:** the plugin's `skills/codex-cli-runtime` + README.
- **What:** describe `consult`, `--isolated`, the JSON/exit‑code contract, and the fan‑out pattern,
  so consumers don't reinvent the shim.

### Net effect of Track A
- **Delete from `~/.claude/workflows/lib/`:** `codex-ask.mjs`, `codex-consult.sh` (see
  `homegrown/` for the copies being retired).
- **Repoint** `~/startup/.claude/agents/codex-worker.md` and `maxfanout-guard.mjs` at the
  plugin‑native `codex:codex-consult` agent (the guard keeps allow‑listing; just a name swap).

---

## Track B — NOT the plugin's to give (recorded, filed elsewhere)

**True native:** `agent(prompt, { model: 'gpt-5.5' })` inside a Workflow with **no subprocess**.

- **Blocker:** the Claude Code Workflow/Agent runtime only resolves Anthropic engines for `model:`.
  There is no registration point for a non‑Anthropic engine. No plugin change can add one.
- **Action:** file a Claude Code feature request for a pluggable external `agent()` engine (resolve
  `model:'gpt-5.5'` to the codex subprocess transparently). Track separately; **do not block Track A
  on it.** Until then, a GPT workflow node is *always* a Sonnet forwarder that shells a subprocess —
  which is fine, and is what A3 makes clean.

---

## What stays ours regardless of upstream

`maxfanout-guard.mjs` (the engine‑binding safety: `agentType` ≠ engine; omitting `model:` silently
inherits Opus → IRON‑LAW violation). This is a **Claude‑side** safety property and lives in
`~/startup/.claude/`, not in the plugin. The fork makes the *worker* native; the guard still prevents
the silent‑Opus‑fallback that started the whole investigation.

---

## Status checklist (updated 2026-06-27 — see HANDOFF.md)

- [x] A1 — `consult` subcommand (read-only, isolated, structured/fail-loud)
- [x] A2 — `--isolated` parallel mode (`runAppServerTurn({isolated})` → `withDirectAppServer`)
- [x] A3 — `codex:codex-consult` fannable agent (+ `codex:codex-session`, `codex:karpathy`,
  `codex:codex-adversarial-review`; `codex-rescue` hardened)
- [x] A4 — docs/skill contract (plugin skill + README; maxfanout SKILL migrated)
- [x] Repoint homegrown `codex-worker` + guard → plugin‑native agents; `codex-worker.md` retired
- [ ] Delete `codex-ask.mjs` + `codex-consult.sh` — **BLOCKED**: deep-research's `codex-bridge` still
  uses them. Migrate `codex-bridge` to native `consult` first.
- [x] (Track B / Layer 1) Feature request filed-as-draft — confirmed not possible in-plugin today
  (`docs/superpowers/specs/2026-06-26-engine-adapter-feature-request.md`)
