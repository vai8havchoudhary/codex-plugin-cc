# Feature request (ready to file): Pluggable model providers / engine adapters

**Target:** `anthropics/claude-code` (GitHub issue)
**Source:** Layer 1 investigation, 2026-06-26 (verified against Claude Code CLI v2.1.193 + official docs).
**Why this exists:** this is the **only** change that removes the last Anthropic relay between a Workflow
node and an external engine (e.g. GPT-5.5 via the `codex@openai-codex` plugin). It is the "Layer 1 /
true native" track for the [native GPT engine design](./2026-06-26-native-gpt-engine-design.md).

## Confirmed blockers (today, CC v2.1.193)

- **Hardcoded Anthropic model resolver.** Subagent/`agent()` `model:` resolves only
  `sonnet|opus|haiku|fable`, full `claude-*` IDs, and `inherit`, checked against the org
  `availableModels` allowlist; an unresolved/excluded value falls back to the *inherited* model (this
  is exactly the silent-Opus trap). Unknown tokens are **not** passed through to any external endpoint.
  (Resolution order: `CLAUDE_CODE_SUBAGENT_MODEL` env → per-call `model` → frontmatter `model` →
  parent model.) — code.claude.com/docs/en/sub-agents#choose-a-model
- **No model-provider plugin surface.** Plugin components are skills, agents, hooks, MCP servers, LSP
  servers, monitors — and `hooks`/`mcpServers`/`permissionMode` are *ignored* for plugin-shipped
  agents. There is no engine-adapter / backend-registration point. —
  code.claude.com/docs/en/plugins-reference#agents
- **Third-party env flags host Anthropic models only.** `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY/…`
  route the Anthropic API to another cloud; they do not enable non-Anthropic model selection. —
  code.claude.com/docs/en/agent-sdk/overview
- **`ANTHROPIC_BASE_URL` is whole-session, not per-node**, and the harness validates the model token
  *before* transmission, so a proxy never even sees a `gpt-5.5` token unless it's globally allowlisted
  — which defeats per-node selection. Not a path to Layer 1.

## Proposed: engine-adapter plugin point

Let a plugin register a model id that the resolver routes to a plugin-provided handler emitting an
Anthropic-compatible event stream.

**Manifest:**
```json
{
  "name": "openai-models",
  "engineAdapters": [
    { "modelId": "gpt-5.5", "displayName": "GPT-5.5",
      "handler": "providers/gpt-5.5.js", "contract": "anthropic-compatible" }
  ]
}
```

**Handler contract:**
```typescript
interface EngineAdapter {
  invoke(request: {
    systemPrompt: string; userPrompt: string;
    tools?: ToolDefinition[];        // Anthropic tool format
    outputSchema?: JSONSchema;       // structured output
    effort?: 'low'|'medium'|'high'|'xhigh'|'max';
    maxTokens?: number; temperature?: number;
  }): AsyncGenerator<StreamEvent>;   // yields message_start / content_block_* / message_delta /
                                     // tool_use / Anthropic-format errors
}
```

**Resolver flow:** parse `model:'gpt-5.5'` → allowlist check → query enabled plugins for a registered
adapter → load handler → `invoke(...)` → harness consumes the Anthropic-compatible stream as if native.
Tool calls, structured output, effort, and errors all flow through the documented contract.

**Why it matters:** multi-engine decorrelated workflows (Sonnet breadth, GPT depth, Haiku summary in
one DAG) with native per-node selection, real parallelism, and no relay agent in the graph. Backward
compatible (adapters opt-in; the Anthropic resolver is unchanged).

**Steering note (for codex-session lifecycle):** to support a *steerable* external engine (multi-turn,
interruptible collaborator, not just one-shot), the adapter contract also needs a resumable/interrupt
surface — e.g. an optional `resume(threadId, input)` and `interrupt(threadId, turnId)` alongside
`invoke`, mapping to the harness's teammate/SendMessage + turn-interrupt machinery. Without it, an
external engine can be a one-shot node but not a steered teammate.

**Scope in:** agent frontmatter `model:`, `agent()` model param, Agent SDK `model`, Workflow nodes,
CLI `--model`. **Scope out:** Anthropic API changes, transport changes, per-plugin auth (adapter owns
its own keys), cross-provider token counting (handler estimates).

## Acceptance

Example `openai-adapter` plugin in docs; tool-call/structured-output/effort mapping verified; mixed
Sonnet→GPT-5.5→Haiku DAG runs; enable/disable registers/removes the model id; permissions + allowlist
still apply per model.

---
*ETA/roadmap timing intentionally omitted — ask the Claude Code team in the issue rather than guess.*
