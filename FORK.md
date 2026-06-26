# FORK.md — maintained fork of `openai/codex-plugin-cc`

This is a **maintained fork**, not a throwaway clone. We carry a small set of changes that make
Codex (GPT‑5.5) a first‑class, **fan‑outable** engine for Claude Code Workflows — specifically the
`maxfanout-workflow` skill under `~/startup`. Instead of routing every upstream PR through OpenAI's
review process, we land changes here and rebase on upstream as it ships.

## Remote model

| Remote | Points at | Role |
|--------|-----------|------|
| `origin` | `vai8havchoudhary/codex-plugin-cc` | our fork — our changes live here |
| `upstream` | `openai/codex-plugin-cc` | OpenAI's repo — source of truth we track |

- Our work lives on **`main`** (this fork's main).
- Forked from upstream baseline `80c31f9` (= plugin **v1.0.5**); see `.upstream-baseline.sha`.

## Sync with upstream

```bash
git fetch upstream
git rebase upstream/main        # replay our changes on top of the latest plugin
# resolve conflicts (most likely in codex-companion.mjs dispatch + app-server-broker.mjs), re-test
git push --force-with-lease origin main
```

Keep our changes **small and localized** (see `_context/03-planned-changes.md`) precisely so this
rebase stays cheap. Every change should be additive where possible (a new subcommand, a new flag, a
new agent file) rather than a rewrite of upstream logic.

## What this fork is for (one paragraph)

A Workflow node is an **Anthropic** agent; the runtime only hosts Anthropic engines for `model:`
(`sonnet|opus|haiku|fable`). There is **no in‑process GPT**. Reaching GPT‑5.5 from a workflow node
therefore *requires* crossing a process boundary into the Codex CLI. Today we cross it with a
homegrown bash+mjs shim (`codex-consult.sh` → `codex-ask.mjs --isolated`) because the plugin's
native path is a **single shared, single‑flight broker** that serializes fan‑out. This fork makes
the **parallel‑isolated, fail‑loud consult path first‑class in the plugin**, so the shim can be
deleted and we depend on upstream‑shaped code instead of a private fork of the mechanism.

See `_context/` for the full investigation, architecture, and the change plan.
