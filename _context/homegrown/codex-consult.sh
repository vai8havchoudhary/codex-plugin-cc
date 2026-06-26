#!/usr/bin/env bash
# codex-consult.sh — native, rule-compliant Codex consult for the deep-research workflow.
#
# Drives the openai-codex PLUGIN's SHARED WARM RUNTIME through the blessed `codex-ask.mjs`
# wrapper in `--isolated` mode (one-shot namespace; mandatory for leaf/subagents per
# docs/orchestration/CODEX-ORACLE.md §Runtime — "Leaf agents MUST NOT call plain codex-ask").
# NEVER uses mcp__codex-cli__codex and NEVER uses raw `codex exec` — both are explicitly forbidden.
#
# Usage:   codex-consult.sh <slug> <prompt_file> [--kind semantic|mechanical]
#   No --kind  = LEGACY: byte-identical to the original 2-arg call (deep-research & other callers).
#   --kind semantic   = full Codex, generous stall/timeout (deep reasoning/review gates).
#   --kind mechanical = Codex Spark (gpt-5.3-codex-spark), fast/cheap (mechanical checks).
#   ONLY --kind is accepted (exact-arity, allowlisted) — a caller (incl. an LLM-authored relay)
#   can NEVER inject codex-ask flags (--write/--file/--model). The tier DERIVES model/stall/timeout.
# Output (stdout) is EXACTLY one of:
#   <<<CODEX_BEGIN>>>\n<codex response>\n<<<CODEX_END>>>   — success (caller extracts between markers)
#   CODEX_UNAVAILABLE                                       — any failure (caller degrades to Opus-only)
# Marker-wrapping lets the caller DETECT a mis-relay: stdout with no markers ⇒ treat as unavailable,
# so a failure narrative can never be mistaken for a real Codex answer.
# On failure a short diagnostic goes to STDERR (visible in the agent transcript) — never silently dropped.
set -uo pipefail

slug="${1:-deep-research}"
pf_in="${2:-}"

[ -n "$pf_in" ] && [ -f "$pf_in" ] || { echo "CODEX_UNAVAILABLE"; echo "codex-consult: no prompt file ('$pf_in')" >&2; exit 0; }

# --- Codex TIER selection (allowlist; EXACT-ARITY; NO raw flag passthrough) ------------------------
# Only `--kind semantic|mechanical` is accepted as args 3-4. Exact arity rejects duplicates / trailing
# junk / `--kind=`. The shell DERIVES model/stall/timeout from the tier, so a caller can never inject a
# codex-ask flag. No 3rd arg = LEGACY = byte-identical to the original 2-arg invocation.
kind="legacy"
if [ "$#" -gt 2 ]; then
  { [ "$#" -eq 4 ] && [ "${3:-}" = "--kind" ]; } || { echo "CODEX_UNAVAILABLE"; echo "codex-consult: unexpected args (usage: <slug> <prompt_file> [--kind semantic|mechanical])" >&2; exit 0; }
  kind="${4:-}"
  case "$kind" in semantic|mechanical) ;; *) { echo "CODEX_UNAVAILABLE"; echo "codex-consult: invalid --kind '$kind' (semantic|mechanical)" >&2; exit 0; } ;; esac
fi

# Tier -> codex-ask flags. Spark model id is PINNED (no env/alias indirection => no policy reopening).
case "$kind" in
  legacy)     model_args=(); effort_args=(); stall_args=();            c_timeout=600 ;;  # unchanged: no --model/--stall, timeout 600
  semantic)   model_args=(); effort_args=(--effort xhigh); stall_args=(--stall 420); c_timeout=900 ;;  # full Codex, deep gate
  mechanical) model_args=(--model gpt-5.3-codex-spark); effort_args=(); stall_args=(--stall 180); c_timeout=420 ;;  # Spark, fast/cheap
esac

# Stage the prompt into a private file via an ATOMIC, checked rename (same /tmp dir as the caller's
# file ⇒ rename(2) is atomic). This (a) removes the caller's predictable /tmp file with no leftover,
# and (b) makes a same-label cross-run race FAIL-SAFE: only one mv wins; the loser's mv fails and that
# call degrades to Opus-only rather than cross-feeding another run's prompt.
priv="$(mktemp /tmp/codex-prompt.XXXXXX 2>/dev/null)" || { echo "CODEX_UNAVAILABLE"; echo "codex-consult: mktemp failed" >&2; rm -f "$pf_in" 2>/dev/null; exit 0; }
mv "$pf_in" "$priv" 2>/dev/null || { echo "CODEX_UNAVAILABLE"; echo "codex-consult: could not stage prompt file (lost a race, or it vanished)" >&2; rm -f "$priv" 2>/dev/null; exit 0; }
chmod 600 "$priv" 2>/dev/null
diag="$(mktemp /tmp/codex-diag.XXXXXX 2>/dev/null)"
cleanup() { rm -f "$priv" "$diag" 2>/dev/null; }
trap cleanup EXIT

# Resolve the blessed codex-ask wrapper, SSOT-first (drift-proof):
#   1) $CODEX_ASK explicit override
#   2) the current repo's tracked wrapper (e.g. ai-sre's scripts/codex-ask.mjs — current, audited)
#   3) the global copy under ~/.claude/workflows/lib/ (so it works outside such a repo too)
ask=""
if   [ -n "${CODEX_ASK:-}" ] && [ -f "${CODEX_ASK}" ]; then ask="${CODEX_ASK}"
elif [ -f "${PWD}/scripts/codex-ask.mjs" ]; then ask="${PWD}/scripts/codex-ask.mjs"
elif [ -f "${HOME}/.claude/workflows/lib/codex-ask.mjs" ]; then ask="${HOME}/.claude/workflows/lib/codex-ask.mjs"
fi
[ -n "$ask" ] || { echo "CODEX_UNAVAILABLE"; echo "codex-consult: no codex-ask.mjs found (\$CODEX_ASK / \$PWD/scripts / global copy)" >&2; exit 0; }

# Read-only --isolated consult. stderr captured to $diag; stdout is the Codex answer.
# Tier-derived flags only (model_args/stall_args). LEGACY expands to the original line byte-for-byte.
out="$(node "$ask" --isolated --slug "$slug" --timeout "$c_timeout" --file "$priv" ${stall_args[@]+"${stall_args[@]}"} ${effort_args[@]+"${effort_args[@]}"} ${model_args[@]+"${model_args[@]}"} 2>"$diag")"
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "CODEX_UNAVAILABLE"
  { echo "codex-consult: codex-ask exited $rc; stderr tail:"; tail -n 4 "$diag" 2>/dev/null; } >&2
  exit 0
fi
if [ -z "$out" ]; then
  echo "CODEX_UNAVAILABLE"
  { echo "codex-consult: codex-ask returned empty output; stderr tail:"; tail -n 4 "$diag" 2>/dev/null; } >&2
  exit 0
fi

printf '<<<CODEX_BEGIN>>>\n%s\n<<<CODEX_END>>>\n' "$out"
