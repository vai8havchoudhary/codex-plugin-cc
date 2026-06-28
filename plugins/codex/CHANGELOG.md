# Changelog

## 1.0.13

### Added

- **`codex:fanout-worker` agent** (`plugins/codex/agents/fanout-worker.md`) — Sonnet captain running
  in an isolated git worktree. GPT (karpathy, gpt-5.5 xhigh) writes all code; captain orchestrates.
  Convergence loop: karpathy → scoped tests → commit → adversarial-review → advisor() (unconditional
  every round) → DONE or next round. Round cap raised to **5** (was 3). Terminal states:
  `DONE` / `FAILED_AFTER_5_ROUNDS`.
- **`codex:fanout-merge` agent** (`plugins/codex/agents/fanout-merge.md`) — Opus captain.
  Receives DONE worker branches + reports + shared contract. Same convergence loop as worker:
  karpathy merges/glues → full integration test suite → adversarial-review → advisor() → DONE or
  next round. Round cap: **5**.
- **`codex:fanout` skill** (`plugins/codex/skills/fanout/SKILL.md`) — two-level fanout orchestration.
  Phase 0 (contract + confirm gate) runs in the main session. After human confirms, launches
  `fanout-workflow.js` as a Workflow for UI-tracked Phases 1–3. Contract focuses on shared interface
  boundaries; **file ownership dropped** (worktree isolation makes it redundant). Dependency-aware
  quorum check before merge spawn: names dependent chunks when a failure occurs.
- **`fanout-workflow.js`** (`plugins/codex/scripts/fanout-workflow.js`) — Workflow script powering
  Phases 1–3. Parallel worker spawning via `agentType: 'codex:fanout-worker'` + `isolation: 'worktree'`.
  Inline JS quorum check (dependency-aware). Single merge agent. Progress visible in `/workflows`.

### Changed

- `fanout-worker.md` / `fanout-merge.md`: round cap 3 → **5**; terminal state label updated to
  `FAILED_AFTER_5_ROUNDS`; confirm gate shows expected vs worst-case cost (+66% if all hit round 5).
- advisor() now called **unconditionally every round** (previously only after adversarial-review passed);
  both judges always grade the same committed artifact.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
