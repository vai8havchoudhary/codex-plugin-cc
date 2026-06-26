# HANDOFF — maintained fork of `openai/codex-plugin-cc`

For a fresh agent picking up this work. Read this, then the referenced artifacts. Do **not**
re-derive what's already written down — it's all in `_context/`.

## Goal (one line)

Make Codex (GPT‑5.5) a first‑class, **fan‑outable** engine for Claude Code Workflows — specifically
the `maxfanout-workflow` skill under `~/startup` — by landing changes in this maintained fork and
rebasing on upstream, instead of running OpenAI's PR process.

## Where things stand

- **Repo:** `~/scratch/cc_codex_plugin` → pushed to `https://github.com/vai8havchoudhary/codex-plugin-cc` (`main`).
- **Remotes:** `origin` = our fork; `upstream` = `openai/codex-plugin-cc`. Baseline pinned at
  **v1.0.5 / `80c31f9`** (see `.upstream-baseline.sha`). Sync = `git fetch upstream && git rebase upstream/main`.
- **Done so far:** context dump only (commit `1ebdb89`). **No plugin code changed yet.**
- **The clone is v1.0.5**, newer than the v1.0.4 in `~/.claude/plugins/cache`. All line refs in
  `_context/` are verified against **1.0.5** — trust those, not the cache.

## Read these (don't duplicate them)

- `../FORK.md` — remote model + upstream sync workflow.
- `01-session-analysis.md` — *why* this fork exists (session `41961880`: silent‑Opus‑fallback bug;
  verdict that `codex-consult.sh` is load‑bearing but belongs upstream).
- `02-architecture.md` — the path to GPT and **the one blocker**: single‑flight broker at
  `plugins/codex/scripts/app-server-broker.mjs:173-182` (with all v1.0.5 `file:line` refs).
- `03-planned-changes.md` — **the work list** (Track A = plugin‑landable; Track B = Anthropic‑only).
  Has a status checklist; everything is unchecked.
- `homegrown/` — verbatim copies of the shims being retired (`codex-ask.mjs`, `codex-consult.sh`)
  and the pieces being repointed (`codex-worker.md`, `maxfanout-guard.mjs`).

## Next action (start here)

**A1 + A2** from `03-planned-changes.md` — the load‑bearing pair that retires both homegrown shims:

1. **A1** — add `case "consult":` to the dispatch switch at `codex-companion.mjs:1026-1061` (+ usage
   string near `:82`). Read‑only, synchronous, `--json` output
   `{status:"ok"|"unavailable", model, output, threadId}` with distinct exit codes.
2. **A2** — `--isolated` / `--session-namespace <id>` flag: when set, **don't** reuse the shared
   broker (`lib/codex.mjs:910/944/982`); spawn a per‑call detached app‑server with its own broker
   session dir (`lib/broker-lifecycle.mjs` → `createBrokerSessionDir`), always `--fresh`. This is the
   exact proven parallelism mechanism from `homegrown/codex-ask.mjs`, made native.

Then A3 (`agents/codex-consult.md` fannable agent), A4 (docs), then repoint the homegrown
`codex-worker` + guard and delete the two shims from `~/.claude/workflows/lib/`.

**Validate parallelism the way the session did:** N concurrent `consult --isolated` calls must show
N distinct PIDs, overlapping wall‑clock (not serial), each self‑reporting a `gpt-*` model, **zero**
`BROKER_BUSY`, and **zero** Claude fallback. Don't assert it — prove it (the session's recurring
lesson: Codex claims were repeatedly wrong; verify empirically).

## Watch out for

- **Track B is NOT in this fork's gift.** `agent({model:'gpt-5.5'})` with no subprocess needs an
  Anthropic harness change (no non‑Anthropic engine slot in the Workflow runtime). File it with
  Claude Code separately; don't block Track A on it.
- **`maxfanout-guard.mjs` stays ours** (Claude‑side engine‑binding safety; `agentType` ≠ engine —
  omitting `model:` silently inherits Opus). The fork makes the *worker* native; the guard still
  prevents the silent‑Opus bug. Just swap the allow‑listed agent name when A3 lands.
- **Keep changes small + additive** (new subcommand, new flag, new agent file) so the
  `git rebase upstream/main` stays cheap.

## Suggested skills for the next agent

- **`superpowers:brainstorming`** — before implementing A1/A2, if any interface detail of the
  `consult` contract (JSON shape, exit codes, flag names) is still open.
- **`superpowers:test-driven-development`** — write the parallelism/fail‑loud proof harness *before*
  the implementation; the acceptance criteria above are the tests.
- **`superpowers:verification-before-completion`** — gate any "it works" claim on the empirical
  N‑way real‑GPT proof, not assertion.
- **`maxfanout-workflow`** (under `~/startup`) — the consumer this whole fork serves; consult it for
  how `codex-worker`/`codex:codex-consult` must be invoked and engine‑bound.
- **`codex:setup`** — confirm the local Codex CLI is authenticated before running any live consult.
