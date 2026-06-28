export const meta = {
  name: 'fanout',
  description: 'Fan N GPT-writing worktree workers then integrate with a single Opus merge node',
  phases: [
    { title: 'Fanout', detail: 'N workers in parallel worktrees (Sonnet + karpathy + adversarial-review + advisor)' },
    { title: 'Quorum', detail: 'dependency-aware worker quorum check' },
    { title: 'Merge',  detail: 'Opus merge node integrates all DONE branches' },
  ],
}

// args shape (populated by the fanout skill after the confirm gate):
// {
//   baseSha:            string,
//   integrationBranch:  string,
//   contract:           string,   // shared interface contract text
//   chunks: Array<{
//     id:          string,
//     branch:      string,
//     description: string,        // full chunk description + acceptance criteria
//     scopedTest:  string | null,
//     dependsOn:   string[],      // chunk ids whose interface this chunk consumes
//   }>
// }

const WORKER_SCHEMA = {
  type: 'object',
  required: ['status', 'chunkId', 'branch'],
  properties: {
    status:         { type: 'string', enum: ['DONE', 'FAILED'] },
    terminalState:  { type: 'string' },
    chunkId:        { type: 'string' },
    branch:         { type: 'string' },
    commitSha:      { type: 'string' },
    filesChanged:   { type: 'array', items: { type: 'string' } },
    testStatus:     { type: 'string' },
    reviewVerdict:  { type: 'string' },
    advisorVerdict: { type: 'string' },
    residualRisks:  { type: 'string' },
    roundsUsed:     { type: 'number' },
  },
}

const MERGE_SCHEMA = {
  type: 'object',
  required: ['status', 'integrationBranch'],
  properties: {
    status:               { type: 'string', enum: ['DONE', 'FAILED'] },
    terminalState:        { type: 'string' },
    integrationBranch:    { type: 'string' },
    workerBranchesMerged: { type: 'array', items: { type: 'string' } },
    workerCommitShas:     { type: 'array', items: { type: 'string' } },
    commitSha:            { type: 'string' },
    filesChanged:         { type: 'array', items: { type: 'string' } },
    testStatus:           { type: 'string' },
    reviewVerdict:        { type: 'string' },
    advisorVerdict:       { type: 'string' },
    residualRisks:        { type: 'string' },
    roundsUsed:           { type: 'number' },
  },
}

// ── Phase 1: FANOUT ──────────────────────────────────────────────────────────

phase('Fanout')
log(`Spawning ${args.chunks.length} workers in parallel worktrees`)

const rawResults = await parallel(
  args.chunks.map(chunk => () =>
    agent(
      [
        '# Fanout worker task',
        '',
        `Chunk ID: ${chunk.id}`,
        `Branch: ${chunk.branch}`,
        `Base SHA: ${args.baseSha}`,
        '',
        '## Scoped test command',
        chunk.scopedTest || '(none — run full test suite)',
        '',
        '## Shared interface contract',
        args.contract,
        '',
        '## Your chunk',
        chunk.description,
      ].join('\n'),
      {
        label: `worker:${chunk.id}`,
        phase: 'Fanout',
        agentType: 'codex:fanout-worker',
        isolation: 'worktree',
        schema: WORKER_SCHEMA,
      }
    )
  )
)

const workerResults = rawResults.filter(Boolean)

// ── Phase 2: QUORUM ──────────────────────────────────────────────────────────

phase('Quorum')

const doneWorkers   = workerResults.filter(r => r.status === 'DONE')
const failedWorkers = workerResults.filter(r => r.status === 'FAILED')

log(`${doneWorkers.length} DONE, ${failedWorkers.length} FAILED`)

if (failedWorkers.length > 1) {
  const ids = failedWorkers.map(w => w.chunkId).join(', ')
  log(`ABORT — ${failedWorkers.length} workers failed [${ids}]. Skipping merge node.`)
  return {
    status: 'ABORTED',
    reason: `${failedWorkers.length} workers failed`,
    failedWorkers,
    doneWorkers,
  }
}

if (failedWorkers.length === 1) {
  const failed = failedWorkers[0]
  const dependents = args.chunks.filter(
    c => Array.isArray(c.dependsOn) && c.dependsOn.includes(failed.chunkId)
  )
  if (dependents.length > 0) {
    const depList = dependents.map(d => d.id).join(', ')
    log(`WARNING: chunk ${failed.chunkId} FAILED; [${depList}] depend on its interface — merge may fail`)
  } else {
    log(`Chunk ${failed.chunkId} FAILED (no dependents) — proceeding without it, gap flagged in report`)
  }
}

// ── Phase 3: MERGE ───────────────────────────────────────────────────────────

phase('Merge')

const mergePrompt = [
  '# Fanout merge task',
  '',
  `Integration base SHA: ${args.baseSha}`,
  `Integration branch: ${args.integrationBranch}`,
  '',
  '## DONE worker branches to merge',
  JSON.stringify(
    doneWorkers.map(w => ({ chunkId: w.chunkId, branch: w.branch, commitSha: w.commitSha })),
    null, 2
  ),
  '',
  '## Worker reports',
  JSON.stringify(doneWorkers, null, 2),
  failedWorkers.length > 0
    ? '\n## Skipped (FAILED) workers\n' + JSON.stringify(failedWorkers, null, 2)
    : '',
  '',
  '## Shared interface contract',
  args.contract,
].join('\n')

const mergeResult = await agent(mergePrompt, {
  label: 'merge',
  phase: 'Merge',
  agentType: 'codex:fanout-merge',
  isolation: 'worktree',
  schema: MERGE_SCHEMA,
})

if (!mergeResult) {
  return { status: 'FAILED', reason: 'merge agent returned null' }
}

log(`Merge ${mergeResult.status}: ${mergeResult.integrationBranch}${mergeResult.commitSha ? ' @ ' + mergeResult.commitSha : ''}`)

return {
  status: mergeResult.status,
  integrationBranch: mergeResult.integrationBranch,
  commitSha: mergeResult.commitSha,
  workerSummary: { done: doneWorkers.length, failed: failedWorkers.length },
  skippedChunks: failedWorkers.map(w => w.chunkId),
  mergeReport: mergeResult,
  workerReports: workerResults,
}
