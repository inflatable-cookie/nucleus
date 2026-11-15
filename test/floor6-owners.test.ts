import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CLOSEOUT_BASE_RENEWAL_LIMIT, CLOSEOUT_BASE_RENEWED_KIND, closeoutBaseRenewalAllowed, closeoutBaseRenewalsSinceMerge } from '../core/closeout/closeout-base-refresh';
import { hookRefusalKind, isStaleBaseRefusal } from '../core/hooks/hook-refusal';
import { workspaceThreadFacts } from '../core/workspaces/owned-workspace-threads';
import { WorkspaceTeardownRefusal } from '../core/workspaces/owned-workspace-archive';

/**
 * Boundary tests for the leaf owners floor 6 introduced. Each answers one
 * question from typed facts, so these assert the decision at the module's real
 * edge: the stale-base closeout budget, the decoded hook refusal, the thread
 * inventory's ownership verdict and the typed teardown refusal.
 */

const staleBase = { refusalKind: 'stale_base' as const, error: 'Integration HEAD moved from the event base' };
const semantic = { refusalKind: null, error: 'The repository hook rejected the change' };

test('the closeout base rule counts its own re-pins since the merge and stops at its limit', () => {
  const event = (kind: string) => ({ kind });
  const renewals = (count: number) => Array.from({ length: count }, () => event(CLOSEOUT_BASE_RENEWED_KIND));
  assert.equal(closeoutBaseRenewalsSinceMerge([...renewals(2), event('merge_verified'), ...renewals(5)]), 2,
    're-pins before the merge belong to the previous closeout');
  for (let spent = 0; spent <= CLOSEOUT_BASE_RENEWAL_LIMIT; spent += 1) {
    assert.equal(closeoutBaseRenewalAllowed(renewals(spent), staleBase), spent < CLOSEOUT_BASE_RENEWAL_LIMIT);
  }
});

test('only a recorded stale-base refusal may re-pin a closeout base', () => {
  assert.equal(closeoutBaseRenewalAllowed([], staleBase), true);
  assert.equal(closeoutBaseRenewalAllowed([], semantic), false, 'a semantic refusal stays parked for a human');
  assert.equal(closeoutBaseRenewalAllowed([], null), false);
  // History recorded before the typed field existed still decodes once, in the owner.
  assert.equal(closeoutBaseRenewalAllowed([], { refusalKind: null, error: 'Integration write requires a clean synchronized base: local main is behind origin' }), true);
  assert.equal(closeoutBaseRenewalAllowed([], { refusalKind: null, error: 'Integration checkout has tracked or untracked changes' }), false);
});

test('the hook refusal decoder keeps the closed stale-base class and nothing else', () => {
  assert.equal(hookRefusalKind('Integration write requires a clean synchronized base: anything'), 'stale_base');
  assert.equal(hookRefusalKind('Integration HEAD moved from the event base'), 'stale_base');
  assert.equal(hookRefusalKind('Local integration base differs from origin'), 'stale_base');
  assert.equal(hookRefusalKind('The repository hook rejected the change'), null);
  assert.equal(hookRefusalKind(''), null);
  assert.equal(hookRefusalKind(undefined), null);
  assert.equal(isStaleBaseRefusal({ refusalKind: 'stale_base', error: 'anything' }), true, 'the typed field wins');
  assert.equal(isStaleBaseRefusal({ refusalKind: null, error: 'Integration HEAD moved from the event base' }), true, 'stored history still decodes');
});

test('the thread inventory decides ownership and idleness as typed facts', () => {
  const thread = (id: string, over: Record<string, unknown> = {}) => ({ agent: { id, workspaceId: 'ws', labels: { 'nucleus.task': 'task-1' }, status: 'idle', ...over } });
  assert.deepEqual(workspaceThreadFacts([thread('a')], 'task-1', new Set(), false), { foreignAgentIds: [] });
  assert.deepEqual(workspaceThreadFacts([thread('a', { labels: { 'nucleus.task': 'other' } })], 'task-1', new Set(), true), { foreignAgentIds: ['a'] },
    'a foreign thread is named only when the caller allows one');
  assert.throws(() => workspaceThreadFacts([thread('a', { labels: { 'nucleus.task': 'other' } })], 'task-1', new Set(), false), /unrelated thread/);
  assert.deepEqual(workspaceThreadFacts([thread('a', { labels: { 'nucleus.task': 'other' } })], 'task-1', new Set(['a']), false), { foreignAgentIds: [] },
    'an attached participant is not foreign');
  for (const live of [{ activeTurn: 'turn-1' }, { pendingPermissions: [{}] }, { status: 'running' }]) {
    assert.throws(() => workspaceThreadFacts([thread('a', live)], 'task-1', new Set(), true), /become idle/, JSON.stringify(live));
  }
});

test('a failed teardown carries its own code, not only its message', () => {
  const refusal = new WorkspaceTeardownRefusal('incomplete', 'Queue-owned worktree directory remains after archive');
  assert.equal(refusal.code, 'incomplete');
  assert.match(refusal.message, /^worktree\.teardown failed: Queue-owned worktree directory remains after archive$/);
  assert.ok(refusal instanceof Error);
});
