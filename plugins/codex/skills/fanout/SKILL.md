---
name: fanout
description: Fan a large task across N parallel GPT-writing worktree workers (each gated by advisor + GPT adversarial review), then integrate with a single Opus merge node. Full UI tracking via /workflows.
---

# Fanout

Use this skill for large implementation work that benefits from parallel chunks. **Phase 0 (contract +
confirm gate) runs in the main session. After the human confirms, Phases 1–3 run as a tracked Workflow
visible in `/workflows` — with per-worker progress, quorum check, and merge node all live.**

**GPT (karpathy) writes all code. Claude orchestrates and never writes code itself.**

## Phase 0 — CONTRACT

Make the shared interface contract first-class before spawning workers.

- Decompose the task into N≈4 chunks.
- Pin explicit shared boundaries: types, APIs, naming, data shapes, and integration expectations.
  File ownership is NOT needed — each worker runs in its own isolated worktree.
- For each chunk, record which other chunks it `dependsOn` by id (for dependency-aware quorum).
  A chunk depends on another if it consumes that chunk's exported interface.
- Assign each chunk a scoped test/build command when possible.
- Record the integration base SHA: `git rev-parse HEAD`
- Assign unique branch names using a run id: `fanout/<run-id>/<chunk-id>` and
  `fanout/<run-id>/integration`.

## Confirm gate

Before launching, show the human:

- chunks and their file/API boundaries
- dependency map between chunks (`dependsOn`)
- engine config: Sonnet captains · GPT-5.5 xhigh karpathy writer · GPT xhigh adversarial-review ·
  advisor() every round
- merge node: Opus
- round cap: 5 per worker, 5 for merge
- estimate: ~40–60 min expected; up to ~100 min worst-case (all workers hit round 5, +66% cost)

Never exceed 4 workers without asking. Wait for explicit one-line confirmation before launching.

## Launch

After the human confirms, resolve the absolute path to the fanout Workflow script:

```bash
echo "$(git rev-parse --show-toplevel)/plugins/codex/scripts/fanout-workflow.js"
```

Then invoke the Workflow tool:

```
Workflow({
  scriptPath: '<absolute path from above>',
  args: {
    baseSha:           '<recorded SHA from git rev-parse HEAD>',
    integrationBranch: 'fanout/<run-id>/integration',
    contract:          '<shared interface contract — types, APIs, data shapes, integration expectations>',
    chunks: [
      {
        id:          'chunk-1',
        branch:      'fanout/<run-id>/chunk-1',
        description: '<full chunk description including file boundaries and acceptance criteria>',
        scopedTest:  '<scoped test command, or null>',
        dependsOn:   []
      },
      {
        id:          'chunk-2',
        branch:      'fanout/<run-id>/chunk-2',
        description: '<...>',
        scopedTest:  '<...>',
        dependsOn:   ['chunk-1']
      }
    ]
  }
})
```

The Workflow runs Phases 1–3 fully tracked. Progress is visible in `/workflows`:

```
▸ fanout
  ● Fanout
    ● worker:chunk-1  (worktree)
    ● worker:chunk-2  (worktree)
    ● worker:chunk-3  (worktree)
    ● worker:chunk-4  (worktree)
  ● Quorum
  ● Merge
    ● merge  (worktree)
```

## Artifacts

After the Workflow completes, persist artifacts to a timestamped directory:

- shared interface contract
- integration base SHA + branch assignments
- each worker report (from Workflow result)
- merge report (from Workflow result)
- skipped chunks with residual risks (if any)

Keep all status output tight: short summaries, not full dumps.
