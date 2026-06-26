# 02 — Architecture & the one real blocker

All `file:line` refs are against the cloned baseline (plugin **v1.0.5**, upstream `80c31f9`).
Paths are repo‑relative under `plugins/codex/`.

## The path to GPT

```
Workflow agent() node  (Anthropic: sonnet|opus|haiku|fable — NO gpt)
        │  must cross a process boundary; there is no in-process GPT
        ▼
Bash: node scripts/codex-companion.mjs <subcommand> …      ← the plugin's public entrypoint
        │   subcommand dispatch switch @ codex-companion.mjs:1026-1061
        │   (setup | review | task | status | result | cancel)
        ▼
scripts/lib/codex.mjs   ← connects to a SHARED broker, reuseExistingBroker:true
        │   mode: "shared"            @ codex.mjs:910
        │   reuseExistingBroker:true  @ codex.mjs:944, :982
        ▼
scripts/app-server-broker.mjs   ← ONE long-lived broker per Claude session dir
        │   *** SINGLE-FLIGHT GATE *** @ app-server-broker.mjs:173-182
        ▼
codex CLI `app-server` (real GPT-5.5 runs here, in its own process)
```

## The blocker: the broker is single‑flight by construction

`scripts/app-server-broker.mjs:173-182` — if **any** request from a *different* socket is already in
flight, the next caller is rejected:

```js
if (
  ((activeRequestSocket && activeRequestSocket !== socket) ||
   (activeStreamSocket  && activeStreamSocket  !== socket)) &&
  !allowInterruptDuringActiveStream
) {
  send(socket, {
    id: message.id,
    error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")   // :179
  });
  continue;
}
```

There is exactly **one** `activeRequestSocket` / `activeStreamSocket` (declared near
`app-server-broker.mjs:69-71`). The broker does **not** multiplex concurrent threads — a second
concurrent request gets `BROKER_BUSY_RPC_CODE` (`-32001`, defined in `lib/app-server.mjs`). The
caller side treats that as retry/back‑off (see `lib/codex.mjs:615-618`).

Combine that with **one shared broker per session** (`mode:"shared"` + `reuseExistingBroker:true`):
every workflow node in a session funnels through a single Codex runtime, **serially**. That is the
entire reason fan‑out doesn't work natively, and the entire reason the homegrown `--isolated`
mechanism exists (it side‑steps the shared broker by spawning a fresh per‑process runtime).

## Two ways to lift the blocker (trade‑offs)

| Approach | What changes | Pro | Con |
|---|---|---|---|
| **A. Isolated spawn** (recommended first PR) | a `--isolated` mode that gives each consult its own broker session dir → its own app‑server process | small, additive, mirrors the proven homegrown mechanism; no risk to the shared‑broker path | N processes = N runtimes (heavier than thread multiplexing) |
| **B. Multiplex the broker** | lift the single‑flight gate at `:173-182` to track multiple in‑flight requests and **demux streaming notifications by `threadId`** | one runtime serves many concurrent threads (lighter) | invasive; streaming demux is the hard part; higher rebase/conflict risk with upstream |

Start with **A** (matches what's already empirically proven to work); keep **B** as a later option
if process overhead becomes the bottleneck.

## Native agent surface today

`plugins/codex/agents/` contains only **`codex-rescue.md`** — a `model: sonnet` thin forwarder to
`codex-companion.mjs task` over the **shared (serial)** runtime. There is no fannable, read‑only
consult agent. Adding one (pointed at the new isolated consult subcommand) is change #3 in the plan.
