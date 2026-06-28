# HANDOFF — maintained fork of `openai/codex-plugin-cc`

For a fresh agent picking up this work. The native-GPT-engine effort is **implemented, verified, and
live**. This file reflects state as of **2026-06-28** (supersedes the original pre-implementation handoff).

## What this fork delivers (done)

GPT (the whole GPT model family) is a **first-class, fan-outable Workflow engine, peer to sonnet/opus**
— reached through native plugin agents, no homegrown shims. Plugin is at **v1.0.12**, installed as the
active `codex@openai-codex` (local marketplace → `~/scratch/cc_codex_plugin`).

### Fanout orchestration (NEW — v1.0.13)

A full two-level fanout-and-merge pipeline, Workflow-tracked, with dual-judge convergence loops.

**Files:**
- `plugins/codex/agents/fanout-worker.md` — Sonnet captain per worktree. GPT (karpathy) writes all
  code. Each round: karpathy → scoped tests → `git diff` + commit → adversarial-review → `advisor()`
  unconditional → DONE or next round. Cap: **5 rounds**. Terminal states: `DONE` / `FAILED_AFTER_5_ROUNDS`.
- `plugins/codex/agents/fanout-merge.md` — Opus captain. Same loop: karpathy merges/glues →
  full test suite → adversarial-review → `advisor()` → DONE or next round. Cap: **5 rounds**.
- `plugins/codex/skills/fanout/SKILL.md` — orchestration skill. Phase 0 (contract + confirm gate)
  runs in the main session; after human confirms, launches `fanout-workflow.js` as a Workflow. Contract
  specifies shared interfaces + `dependsOn` per chunk; **no file ownership** (worktree isolation handles it).
  Dependency-aware quorum: 0 FAILED → proceed; 1 FAILED → check dependents, warn, proceed; >1 FAILED → abort.
  Confirm gate shows expected (~40–60 min) vs worst-case (~100 min, +66% cost if all workers hit round 5).
- `plugins/codex/scripts/fanout-workflow.js` — Workflow script (phases: Fanout / Quorum / Merge).
  Progress visible in `/workflows`. Spawns workers via `agentType: 'codex:fanout-worker'` + `isolation: 'worktree'`.

**Key gotcha — Workflow `args` injection:** The `args` global is `undefined` when invoking via `scriptPath`
without a prior inline run. Workaround: embed contract data as a hardcoded `const RUN = {...}` in the
script body. The skill instructs Claude to construct a tailored inline script for each run.

**Key finding — cross-worktree deps:** Workers with `dependsOn` cannot run scoped tests against the
dependency (it lives in another worktree). The worker correctly handles this: `advisor()` pre-work call
flags it, GPT creates a throwaway conformant stub to verify test logic, deletes it, commits only the
test file. Both judges accept the expected `ERR_MODULE_NOT_FOUND` as non-blocking.

**Verified (end-to-end test runs, 2026-06-28):**
- Smoke test (greet.ts): 2 parallel workers, round 1 each, 3/3 tests PASS post-merge.
  `advisor()` pre-work call (chunk-1) flagged scope-creep risk; shaped karpathy prompt to prevent it.
  `advisor()` pre-work call (chunk-2) flagged cross-worktree isolation problem before it occurred.
- Multi-round test (retry.ts): 1 worker, **3 rounds**. Round 1 had a real HIGH finding (async `onError`
  rejection escaping guard); fixed in round 2; advisor confirmed PASS in round 3. Merge: 2 rounds,
  108/108 tests pass with isolated state. HIGH finding caught and fixed before DONE reported.

### Native plugin agents (in `plugins/codex/agents/`)
- **`codex:codex-consult`** — stateless, read-only, **isolated-by-default** parallel fan-out worker.
  Shells `consult --json --isolated`; structured `{status,model,output,threadId,turnId,reason}` + exit
  codes (0/3/2). `sonnet` + `effort:low` relay, ironclad forward-only rules.
- **`codex:codex-session`** — steerable multi-turn collaborator (one persistent shared-broker thread;
  SendMessage → interrupt+resume).
- **`codex:karpathy`** — high-calibre **write-capable** end-of-phase fixer: `task --write --model
  gpt-5.5 --effort xhigh` with the bundled Karpathy discipline (`plugins/codex/karpathy/PERSONA.md`).
- **`codex:codex-adversarial-review`** — GPT adversarial-review gate on git state.
- **`codex-rescue`** (existing) — hardened with the same forward-only rules (was silently substituting).

### Plugin core (`scripts/codex-companion.mjs`, `lib/codex.mjs`)
- New **`consult`** subcommand (read-only, synchronous, isolated). `runAppServerTurn(..,{isolated})` →
  `withDirectAppServer` (per-process app-server, off the single-flight broker). Fail-closed model check
  (`resolveConsultModel`): a requested `gpt-*` that can't be confirmed → `status:unavailable`. Concise
  `reason` for codex JSON-error envelopes (mixed stderr preserved raw). 8 consult tests, full suite
  94 pass / 4 pre-existing-env fails.

### Verified (not asserted)
- 4 concurrent `consult --isolated` ≈ 1× wall-clock, **zero BROKER_BUSY**, all real `gpt-5.5`.
- End-to-end maxfanout workflow: GPT fan-out + Sonnet fallback on injected error (`viaGpt:2,fellBack:1`).
- All 7 codex agents invocation-tested. The implement→adversarial-review→karpathy-fix loop dogfooded.

## Consumer wiring (the orchestration layer, `~/startup`)
- `maxfanout-workflow/SKILL.md` — fully migrated: `wf()` guard + `gptOk()` backstop; GPT model/effort
  via **`gptModel`/`gptEffort`** (NEVER `model:` — that selects the Anthropic relay engine and a `gpt-*`
  there makes the node fail; this bug was caught by the integration test). End-of-phase fix-loop section.
- `maxfanout-guard.mjs` — allow-lists the native agents; `wf()`/`w()` regex; `codex-worker` removed.
- `CLAUDE.md` — flipped to native; `HOW-IT-WORKS.md` carries a migration note.
- `~/startup/.claude/agents/codex-worker.md` — **retired** (copy preserved in `_context/homegrown/`).

## Still open / next
- **Layer 1 (true zero-relay `model:'gpt-5.5'`):** confirmed NOT possible today (harness model resolver
  is Anthropic-only; no engine-adapter plugin point). Feature request drafted:
  `docs/superpowers/specs/2026-06-26-engine-adapter-feature-request.md`. The relay agents are the bridge
  until it lands; they're designed to collapse to native when it does.
- **`codex-consult.sh` / `codex-ask.mjs` NOT deleted** — the separate **deep-research** workflow's
  `codex-bridge` agent (`~/.claude/agents/codex-bridge.md`) still shells them. Migrate `codex-bridge`
  to native `consult` first, then they can be removed.
- Optional: move `codex-reviewer`/`codex-ops` (bare user agents) into the plugin as `codex:` agents for
  naming consistency.

## Specs
- `docs/superpowers/specs/2026-06-26-native-gpt-engine-design.md` — the design (Codex-reviewed; all
  corrections folded in).
- `docs/superpowers/specs/2026-06-26-engine-adapter-feature-request.md` — Layer-1 feature request.
