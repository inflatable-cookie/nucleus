import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchPrLookupOutcome, blockedReturnDecision, classifyWorkerObservation } from '../core/recovery/worker-reconcile';
import { workspaceReplayAllowed } from '../core/recovery/creation-recovery';
import type { Task } from '../shared/contracts';
import type { AgentObservation } from '../core/host';

test('branch PR lookup outcomes', () => {
  for (const [error, count, result] of [[new Error('offline'), 0, 'unverified'], [null, 0, 'empty'], [null, 1, 'found'], [null, 2, 'ambiguous']] as const)
    assert.equal(branchPrLookupOutcome(error, count), result);
});

test('worker observation outcomes', () => {
  const task = { phase: 'working', runId: null, resolution: {} } as Task;
  for (const [status, active, permissions, result] of [['idle', false, false, 'stopped'], ['error', false, false, 'stopped'], ['running', false, false, 'live'], ['idle', true, false, 'live'], ['idle', false, true, 'live']] as const)
    assert.equal(classifyWorkerObservation(task, { status, active, permissions } as AgentObservation), result);
  assert.equal(classifyWorkerObservation({ ...task, phase: 'needs_attention' }, { status: 'running' } as AgentObservation), 'live_recover');
  assert.equal(classifyWorkerObservation({ ...task, runId: 'r', transientProviderRetry: { runId: 'r', status: 'waiting' } } as Task, { status: 'error' } as AgentObservation), 'transient');
});

test('blocked return choices', () => {
  const base = { unfinished: false, providerFailureWithoutImpediment: false, unfinishedPushed: false, firstNonDelivery: false, nonDeliveryPushed: false };
  for (const [facts, expected] of [[{}, 'continue'], [{ unfinished: true }, 'unfinished'], [{ unfinished: true, providerFailureWithoutImpediment: true }, 'continue'], [{ unfinished: true, unfinishedPushed: true }, 'continue'], [{ firstNonDelivery: true }, 'non_delivery'], [{ firstNonDelivery: true, nonDeliveryPushed: true }, 'continue'], [{ unfinished: true, firstNonDelivery: true }, 'unfinished']] as const)
    assert.equal(blockedReturnDecision({ ...base, ...facts }), expected);
});

test('workspace replay facts', () => {
  const task = { phase: 'dispatching', resolution: {} } as Task;
  for (const [patch, kind, remove, runs, replay, expected] of [
    [{}, 'absent', false, false, false, true], [{}, 'partial', true, false, false, true],
    [{}, 'partial', false, false, false, false], [{}, 'found_done', true, false, false, false],
    [{ agentId: 'a' }, 'absent', false, false, false, false], [{ phase: 'working' }, 'absent', false, false, false, false],
    [{ resolution: { attention: true } }, 'absent', false, false, false, false], [{}, 'absent', false, true, false, false],
    [{}, 'absent', false, false, true, false],
  ] as const) assert.equal(workspaceReplayAllowed({ ...task, ...patch } as Task, kind, remove, runs, replay), expected);
});

test('transient provider observation choices, including map bug 27', async () => {
  const { transientResumeDecision } = await import('../core/recovery/transient-resume');
  for (const [busy, status, retry, quota, expected] of [
    [true, 'error', 'intent', false, 'busy'], [false, 'idle', 'sent', false, 'settled'],
    [false, 'error', 'intent', true, 'quota'], [false, 'error', 'intent', false, 'uncertain'],
    [false, 'error', 'uncertain', false, 'uncertain'], [false, 'error', 'exhausted', false, 'exhausted'],
    [false, 'error', 'sent', false, 'sent'], [false, 'error', 'waiting', false, 'schedule'],
    [false, 'error', undefined, false, 'schedule'],
  ] as const) assert.equal(transientResumeDecision(busy, status, retry, quota), expected);
});

test('transient retry gates preserve waiting, exhaustion and channel order', async () => {
  const { transientSentDecision, transientWaitingDecision } = await import('../core/recovery/transient-resume');
  for (const [transient, old, resumes, expected] of [[false, true, 99, 'failed'], [true, true, 99, 'wait'], [true, false, 99, 'exhausted'], [true, false, 0, 'schedule']] as const)
    assert.equal(transientSentDecision(transient, old, resumes), expected);
  for (const [before, resumes, channel, expected] of [[true, 99, false, 'wait'], [false, 99, false, 'exhausted'], [false, 0, false, 'no_channel'], [false, 0, true, 'send']] as const)
    assert.equal(transientWaitingDecision(before, resumes, channel), expected);
});
