# 01 — Session analysis (the investigation behind this fork)

Source: Claude Code session `41961880-0f13-4585-8160-feea4900f6ea` (project `~/startup/toplogy`),
plus the follow‑up conversation that created this fork. This is the *why*.

## The bug that started it

While running a `maxfanout-workflow` build, a late workflow stage that was supposed to call Codex
(GPT‑5.5) **ran on Opus instead and errored out**, then Opus retried as itself. The skill explicitly
forbids Opus as a fan‑out/worker engine (the "IRON LAW"). Root cause:

> The Workflow `agent()` API has **no safe default**. Omit the engine and the agent inherits the
> **session model — which is Opus**. `agentType` alone does **not** bind an engine; the engine comes
> from the agent definition's `model:` frontmatter, or (absent that) the session model. A "GPT"
> agent with no `model:` frontmatter silently ran as Opus.

This is captured as a standing safety property in `maxfanout-guard.mjs` and the user's memory
`workflow-pin-model-and-confirm-config`. It is a **Claude‑side** concern, independent of this fork.

## The question that produced this fork

The user asked, repeatedly: **why do we need `codex-consult.sh` at all? Why a shell shim instead of
integrating Codex directly into the workflow / the codex plugin?**

A background agent was tasked to (a) verify the load‑bearing claims and (b) interrogate whether the
shim is genuinely necessary. Findings (empirically verified, not asserted):

- **Real GPT, no Claude fallback — CONFIRMED.** 5 concurrent jobs each self‑reported `gpt-5` /
  `gpt-5-codex`; 0/5 fell back to Claude. No Claude‑fallback branch exists in the script.
- **Genuine parallelism — CONFIRMED.** 5 distinct PIDs, same start epoch, wall‑clock ≈ 1×
  (serial would be ~35s+). Clean at 4× full GPT‑5.5 and 6× Spark.
- **Raw `codex exec` + the codex MCP tool are denied by environment policy — CONFIRMED.**
  `codex-consult.sh` is the one allow‑listed door.

## The verdict: KEEP the mechanism — but it belongs upstream

The mechanism is genuinely load‑bearing, for three evidenced reasons:

1. **It's the only allow‑listed path to real GPT here** (raw `codex exec` + MCP are denied). *Policy,
   not physics* — but the guardrail stands.
2. **`--isolated` is the parallelism mechanism.** `codex-ask.mjs --isolated` gives each call a unique
   per‑process session namespace (`…:subagent:<pid>:<stamp>`) and forces `--fresh`, so each consult
   is a one‑shot detached job that never touches the warm companion thread — taking calls **off the
   single shared broker's mutex**. That is *what* makes `codex-worker` fan out.
3. **Fail‑loud kills the silent‑fallback class.** Failure returns the `CODEX_UNAVAILABLE` sentinel,
   never a fabricated answer; the `CODEX_BEGIN/END` markers exist so a mis‑relayed failure can't be
   mistaken for a real Codex reply. This is the cleanest answer to the exact ghost that haunted the
   session (silent substitution of Claude for GPT).

## The architectural reason the shell can't simply vanish

> A workflow node is a **Claude (Anthropic)** agent. The Workflow/Agent runtime can only host
> Anthropic models for `model:` — `sonnet|opus|haiku|fable`. There is **no in‑process GPT**. GPT‑5.5
> runs in a *separate process* (the codex CLI/companion). So reaching GPT from a workflow node
> **requires spawning an external process** — period. That's the shell. This is true of *every* GPT
> path here, including `codex:codex-rescue`, which also shells the companion under the hood.

So the real choice is **which subprocess**, not shell‑vs‑no‑shell:

- the **warm companion** (`codex:codex-rescue`) → single shared, **serial mutex** path; or
- **`codex-consult.sh --isolated`** → per‑process detached job → **parallel**.

The genuinely "direct" version is **getting the plugin to expose an isolated‑parallel consult path as
a native, fannable capability** — then the homegrown shim disappears and `codex-worker` becomes
plugin‑native. That is precisely what this fork does, now that the plugin is open source.

## Honest corrections recorded in the session (so we don't relitigate)

- The broker comment `SHARED WARM RUNTIME` is **accurate, not stale**: parallelism comes from each
  `--isolated` call being its own detached job against the **same shared broker mode**, *not* from
  separate runtimes. Mental model: "same shared broker, but each isolated call is its own detached
  one‑shot job."
- The `codex:codex-rescue` "mutex" claim is **documented, not re‑proven** as a hard mutex — it is
  "not built for fan‑out." Don't overstate it.
