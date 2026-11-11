import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Task, TaskControlInput } from '../shared/contracts';
import type { MergeGateResult } from '../core/resolution';
import { forceMergeAdmission, forceMovePatch } from '../core/verbs/force';

test('force merge check admission', () => {
  const gate = {checksFailed: true} as MergeGateResult;
  const required = {head: 'h', requirements: {known: true}, advisory: [{name: 'job', jobUrl: 'url', conclusion: 'FAILURE'}]} as MergeGateResult;
  const cases: Array<[Partial<MergeGateResult>, string, string]> = [
    [{head: 'other'}, 'job url unrelated', 'GitHub-required or unknown checks cannot be forced'],
    [{wait: 'wait'}, 'job url unrelated', 'GitHub-required or unknown checks cannot be forced'],
    [{advisory: []}, 'job url unrelated', 'GitHub-required or unknown checks cannot be forced'],
    [{}, 'job url', 'Name each failed check, its job URL and why this diff cannot have caused it'],
    [{}, 'job url unrelated', 'ok'],
  ];
  for (const [change, reason, expected] of cases) {
    const result = forceMergeAdmission('h', reason, gate, {...required, ...change});
    assert.equal('refusal' in result ? result.refusal : 'ok', expected);
  }
});

test('force move patch selects phase and merge changes', () => {
  const task = {resolution: {ownerAcceptances: [], ownerSettlements: [], forcedChecks: [], mergedWithNone: false}} as unknown as Task;
  const facts = {settled: task, reason: 'reason', observedHead: 'h', observedUrl: null, observedNumber: null,
    mergedCommit: null, acceptance: null, records: [], forcedChecks: [], selfForceRunId: undefined,
    participants: new Map<string, string>(), uncertainties: [], requestedAt: 'now'};
  for (const [to, phase, intent] of [['work','changes_requested',false], ['review','awaiting_review',false], ['merge','merging',true]] as const) {
    const patch = forceMovePatch({...facts, input: {to} as TaskControlInput});
    assert.equal(patch.phase, phase);
    assert.equal(patch.resolution?.mergeIntent, intent);
    if (to === 'merge') assert.equal(patch.resolution?.mergeRequestedAt, 'now');
  }
});

test('force merge source and acceptance rules', async () => {
  const { forceMergeSourceRefusal, forceMergeAcceptance } = await import('../core/verbs/force');
  const task = {id: 't', phase: 'verifying', prHead: 'h', disposition: null,
    resolution: {review: null, mergeIntent: false, mergedCommit: null}} as unknown as Task;
  for (const [head, role, expected] of [
    ['other', null, 'The PR head is other'], ['h', 'worker', 'Self-force merge requires'], ['h', null, null],
  ] as const) {
    const refusal = forceMergeSourceRefusal(task, {} as TaskControlInput, head, role);
    if (expected) assert.ok(refusal?.includes(expected)); else assert.equal(refusal, null);
  }
  const accepted = {...task, resolution: {...task.resolution, review: {head: 'h', status: 'ready_to_merge'}}} as Task;
  assert.equal(forceMergeAcceptance(accepted, {} as TaskControlInput, 'h', []).kind, 'none');
  assert.equal(forceMergeAcceptance(task, {} as TaskControlInput, 'h', []).kind, 'refuse');
  const input = {qualification: 'accepted', caller: 'operator', relayed: true, note: 'Tom accepted'} as TaskControlInput;
  assert.equal(forceMergeAcceptance(task, input, 'h', []).kind, 'accept');
});

test('force move to closeout carries merged evidence and participants', () => {
  const task = {resolution: {ownerAcceptances: [], ownerSettlements: [], forcedChecks: [], mergedWithNone: true}} as unknown as Task;
  const patch = forceMovePatch({settled: task, input: {to: 'closeout'} as TaskControlInput, reason: 'reason',
    observedHead: 'h', observedUrl: null, observedNumber: null, mergedCommit: 'commit', acceptance: null,
    records: [], forcedChecks: [], selfForceRunId: undefined, participants: new Map([['agent', 'workspace']]),
    uncertainties: [], requestedAt: null});
  assert.equal(patch.phase, 'syncing');
  assert.equal(patch.resolution?.mergedCommit, 'commit');
  assert.deepEqual(patch.resolution?.ownerCloseoutParticipants, [{agentId: 'agent', workspaceId: 'workspace'}]);
});
