---
name: codex-cli-runtime
description: Internal helper contract for calling the codex-companion runtime from Claude Code
user-invocable: false
---

# Codex Runtime

Use this skill only inside Codex relay subagents: `codex:codex-rescue`, `codex:codex-consult`, and `codex:codex-session`.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task "<raw arguments>"`
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" consult --json --isolated -- "<prompt>"`

Rescue execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct Codex CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `codex:codex-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `gpt-5-4-prompting` skill to rewrite the user's request into a tighter Codex prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--effort` unset unless the user explicitly requests a specific effort.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- Map `spark` to `--model gpt-5.3-codex-spark`.
- Default to a write-capable Codex run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model`, normalize `spark` to `gpt-5.3-codex-spark` and pass it through to `task`.
- If the forwarded request includes `--effort`, pass it through to `task`.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Safety rules:
- Default to write-capable Codex work in `codex:codex-rescue` unless the user explicitly asks for read-only behavior.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Codex cannot be invoked, return nothing.

Consult helper:
- `consult` is the stateless, read-only GPT fan-out primitive.
- Use `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" consult --json --isolated [--effort <effort>] [--model <model>] [--output-schema <schema-file>] -- "<prompt>"`.
- `--isolated` is the default for consult and routes around the shared broker so multiple consult calls can run concurrently.
- `consult` has no `--write`; it always runs with read-only sandboxing.
- Leave `--effort` unset unless the invoker supplied an explicit effort. Accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`; `max` is clamped by the companion to `xhigh`.
- Leave model unset unless the invoker supplied a model. `spark` maps to `gpt-5.3-codex-spark`; concrete `gpt-*` ids are passed through with `--model`.
- If a structured-output schema is attached, write the schema to a unique temp file and pass `--output-schema <schema-file>`. Do not re-derive structure from prose.
- Return the JSON stdout exactly as-is. Do not add preamble, summary, or markers.

Consult JSON contract:
```json
{
  "status": "ok",
  "model": "gpt-5.5-codex",
  "output": "...",
  "threadId": "thr_...",
  "turnId": "turn_...",
  "reason": null
}
```

- `status` is `"ok"` or `"unavailable"`.
- `output` is raw text, or an object when `--output-schema` is set and Codex returned parseable JSON.
- `model` is the actual start/resume model when Codex reports it; a requested `gpt-*` model that cannot be confirmed fails closed as `"unavailable"`.
- Exit code `0` means ok, `3` means unavailable, and `2` means usage error.
- If `status` is `"unavailable"`, degrade explicitly: drop, retry elsewhere, or report unavailable. Never treat it as a valid GPT answer.

Fan-out pattern:
```text
Run N independent `codex:codex-consult` workers for read-only breadth.
For each JSON response:
  if status === "ok": use output
  if status === "unavailable": degrade or retry; do not fabricate
```

Session helper:
- `codex:codex-session` is the steerable collaborator relay.
- It uses `task --background --write`, never `consult`, and never `--isolated`.
- Start command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --background --write [--effort <effort>] [--model <model>] -- "<task text>"`.
- Steering command after interrupt acknowledgement: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --background --write --resume-last [--effort <effort>] [--model <model>] -- "<steer text>"`.
- Interrupt command while a job is active: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" cancel <job-id> --json`.
- One session owns one persistent Codex thread and keeps one active turn at a time.
- Before a steering resume, cancel any active job and wait for the `cancel --json` acknowledgement.
- Resume continues the same Codex thread with prior context. Interrupted write-capable turns have no transactional rollback, so partial file changes may remain.
- Surface companion stdout/status as the source of truth. Do not fabricate Codex output.
