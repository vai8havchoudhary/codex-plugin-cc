# `_context/` — why this fork exists and what we're changing

Full context dump for the maintained fork. Read in order:

1. **[01-session-analysis.md](01-session-analysis.md)** — the investigation that produced this fork
   (Claude Code session `41961880-0f13-4585-8160-feea4900f6ea`): the silent‑Opus‑fallback bug, the
   "do we really need `codex-consult.sh`?" question, and the verified verdict (KEEP — but it should
   be upstream).
2. **[02-architecture.md](02-architecture.md)** — how the plugin reaches GPT (companion → broker →
   app‑server → codex CLI), and the **one real blocker**: the broker is single‑flight by
   construction. With exact `file:line` refs against plugin **v1.0.5**.
3. **[03-planned-changes.md](03-planned-changes.md)** — the changes we carry in this fork, with
   target files/lines, the honest two‑track split (plugin‑landable vs. Anthropic‑only), and what
   stays ours regardless.
4. **[homegrown/](homegrown/)** — verbatim copies of the shims/agents this fork is meant to replace
   (`codex-ask.mjs`, `codex-consult.sh`, `codex-worker.md`, `maxfanout-guard.mjs`), so the fork is
   self‑contained and the diff target is legible.

## TL;DR

- **Goal:** native, fan‑outable Codex engine in `maxfanout-workflow` — delete the homegrown shims.
- **Movable here (plugin):** a first‑class `consult --isolated --json` subcommand + a plugin‑shipped
  fannable `codex-consult` agent. This is the parallel, fail‑loud path, upstream‑shaped.
- **NOT movable here (Anthropic harness):** `agent({model:'gpt-5.5'})` with no subprocess. The
  Workflow runtime has no non‑Anthropic engine slot. File that separately with Claude Code.
- **Stays ours regardless:** the `maxfanout-guard.mjs` engine‑binding safety (agentType ≠ engine;
  omitting `model:` silently inherits Opus). Orthogonal to the plugin.
