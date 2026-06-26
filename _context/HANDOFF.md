# HANDOFF — maintained fork of `openai/codex-plugin-cc`

For a fresh agent picking up this work. The native-GPT-engine effort is **implemented, verified, and
live**. This file reflects state as of **2026-06-27** (supersedes the original pre-implementation handoff).

## What this fork delivers (done)

GPT (the whole GPT model family) is a **first-class, fan-outable Workflow engine, peer to sonnet/opus**
— reached through native plugin agents, no homegrown shims. Plugin is at **v1.0.12**, installed as the
active `codex@openai-codex` (local marketplace → `~/scratch/cc_codex_plugin`).

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
