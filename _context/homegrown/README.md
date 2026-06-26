# homegrown/ — the shims this fork replaces (verbatim copies, for reference)

These are **copies** of the private mechanism living under `~/.claude/` and `~/startup/.claude/` at
the time the fork was created. They are the *diff target*: Track A in `../03-planned-changes.md` makes
the first two obsolete and repoints the last two.

| File | Origin | Fate under this fork |
|------|--------|----------------------|
| `codex-ask.mjs` | `~/.claude/workflows/lib/codex-ask.mjs` | **retire** → replaced by native `codex-companion.mjs consult --isolated --json` (A1+A2) |
| `codex-consult.sh` | `~/.claude/workflows/lib/codex-consult.sh` | **retire** → the `--isolated` subcommand removes the need for the wrapper (A2) |
| `codex-worker.md` | `~/startup/.claude/agents/codex-worker.md` | **repoint** → becomes/forwards to plugin‑native `codex:codex-consult` (A3) |
| `maxfanout-guard.mjs` | `~/startup/.claude/hooks/maxfanout-guard.mjs` | **stays ours** (Claude‑side engine‑binding safety); just swaps the allow‑listed agent name |

These are reference snapshots — do not wire them into the plugin build. They exist so the fork is
self‑contained and the intended replacement is legible to anyone reading the change plan.
