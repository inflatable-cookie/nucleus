import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskSchema } from '../shared/contracts';
import type { Task } from '../shared/contracts';
import { archiveFailureIsTeardown, archiveFailureKeepsScope } from '../core/workspaces/archive-failure';
import { BACKPRESSURE_DEFERRAL } from '../core/host/admission';
import { archiveRetryWaiting, terminalArchiveSource, terminalArchiveWorkspaces } from '../core/closeout/terminal-archive';

const base = 'a'.repeat(40), head = 'b'.repeat(40), merged = 'c'.repeat(40);
const scraped = (overrides: Record<string, unknown> = {}): Task => taskSchema.parse({
  submissionId: 's', title: 'T', repoPath: '/repo', planningCommit: base, handoffPath: 'h.md', originAgentId: 'o',
  id: 'task-1', hostId: 'host', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  version: 1, phase: 'done', reason: '', held: false, handoffText: '', planningBase: base,
  workspaceId: 'ws', directory: '/worktree', branch: 'ns-task-1', agentId: null, runId: null, profile: null,
  workspaceIntent: false, agentIntent: false, lastAgentStatus: null, idleSince: null, completion: null,
  agentActive: null, lastObservedAt: null, prUrl: 'https://example.test/pr/1', prHead: head, coordinatorGeneration: 1,
  ...overrides,
});

test('an archive failure keeps a captured runtime scope only for a teardown or retirement refusal', () => {
  const scoped = { hasScope: () => true }, unscoped = { hasScope: () => false };
  const error = (message: string) => new Error(message);
  const cases: [string, { hasScope: (taskId: string, workspaceId: string) => boolean }, Error, boolean][] = [
    ['a teardown refusal keeps its scope', unscoped, error('worktree.teardown refused: workspace busy'), true],
    ['a runtime retire failure keeps its captured scope', scoped, error('runtime retirement failed: exit 1'), true],
    ['a runtime scope read failure keeps its captured scope', scoped, error('runtime scope read failed'), true],
    ['a retirement refusal without a captured scope keeps nothing', unscoped, error('runtime retirement failed: exit 1'), false],
    ['a Queue-authored ownership refusal keeps nothing', scoped, error('Workspace is referenced by another task'), false],
  ];
  for (const [label, scope, failure, expected] of cases) {
    assert.equal(archiveFailureKeepsScope(scope, 'task-1', 'ws', failure), expected, label);
  }
  assert.equal(archiveFailureKeepsScope(scoped, 'task-1', 'ws', 'runtime retirement failed'), true, 'a non-Error refusal is classified the same way');
  assert.equal(archiveFailureIsTeardown(error('worktree.teardown refused')), true);
  assert.equal(archiveFailureIsTeardown(error('runtime retire timed out')), true);
  assert.equal(archiveFailureIsTeardown(error('Workspace archive held by task identity')), false);
});

test('a bounded archive retry waits on its backoff and a breaker deferral is due at once', () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();
  const retry = (error: string, nextAttemptAt: string) => ({ workspaceId: 'ws', attempts: 1, error, nextAttemptAt });
  assert.equal(archiveRetryWaiting(retry('teardown refused', future)), true, 'a failed attempt waits for its backoff');
  assert.equal(archiveRetryWaiting(retry('teardown refused', past)), false, 'a due attempt runs');
  assert.equal(archiveRetryWaiting(retry(`${BACKPRESSURE_DEFERRAL}degraded`, future)), false,
    'a breaker deferral never reached the host, so it is due on the first admitted pass');
  assert.equal(archiveRetryWaiting(undefined), false, 'no record means nothing is waiting');
});

test('a proof-only task is never a report-only source and archives its detached commit', () => {
  const proof = scraped({
    entrypoint: 'proof', prUrl: null,
    proofOnly: { commit: merged },
    resolution: { mergedCommit: merged, syncedCommit: merged },
  });
  assert.deepEqual(terminalArchiveSource(proof), { reportOnly: false, proofOnlyDone: true });
  assert.deepEqual(terminalArchiveWorkspaces(proof, []).filter(workspace => workspace.id).map(workspace => [workspace.id, workspace.head, workspace.reportSource]), [['ws', merged, false]],
    'the proof checkout archives at its own commit, not at a report-only base');

  const reportOnly = scraped({
    prUrl: null, prHead: null,
    reportAcceptance: { acceptedBy: 'owner', reason: 'The report is the outcome', acceptedAt: '2026-01-01T00:00:00.000Z', taskVersion: 1 },
  });
  assert.deepEqual(terminalArchiveSource(reportOnly), { reportOnly: true, proofOnlyDone: false });
  assert.deepEqual(terminalArchiveWorkspaces(reportOnly, []).filter(workspace => workspace.id).map(workspace => [workspace.head, workspace.reportSource]), [[base, true]]);

  const unfinished = scraped({ prUrl: null, prHead: null });
  assert.deepEqual(terminalArchiveWorkspaces(unfinished, []), [], 'a done task with no recorded merge or report acceptance archives nothing');
});
