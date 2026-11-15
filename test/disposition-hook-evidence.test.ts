/**
 * Boundary tests for the disposition hook evidence: the two settlements that let
 * an operator disposition land when a cancellation hook repeats a refusal Queue
 * already recorded. Each case is one side of a predicate — the repeated refusal
 * settles, and every near miss (another refusal, another hook, a delivered
 * channel, an artifact that exists) does not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { settlesLegacyInstructionlessDispositionHook, settlesPreWorkspaceDispositionHook } from '../core/verbs/disposition/hook-evidence';
import { hookRecordSchema, type HookRecord } from '../shared/hooks';
import { submissionSchema, type Task } from '../shared/contracts';
import { HOOK_TEST_TIMEOUT_MS } from './support/budgets';

const base = 'b'.repeat(40);

function storeWithTask(fields: { instruction?: string | null } = {}) {
  const store = new Store(':memory:');
  const inserted = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Hook evidence',
    repoPath: '/repo', planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', base);
  const task = Object.keys(fields).length ? store.update(inserted.id, fields as Partial<Task>) : inserted;
  return { store, task };
}

function record(taskId: string, event: HookRecord['event'], fields: {
  hookId?: string; delivery?: HookRecord['delivery']; state?: HookRecord['state']; refusal?: string;
  error?: string; instruction?: HookRecord['instruction']; mode?: HookRecord['mode'];
}): HookRecord {
  const eventId = randomUUID();
  const refusal = fields.refusal ?? 'handoff does not reference a roadmap task';
  return hookRecordSchema.parse({
    id: randomUUID(), taskId, hookId: fields.hookId ?? 'admission', event, eventId,
    occurrence: 1, mode: fields.mode ?? 'read_only', delivery: fields.delivery ?? 'required', state: fields.state ?? 'blocked',
    manifest: { path: '.paseo/queue.json', commit: base, digest: `sha256:${'a'.repeat(64)}` },
    program: { kind: 'repository', executable: { path: '.paseo/hooks/policy', commit: base, digest: `sha256:${'c'.repeat(64)}` }, argv: [] },
    instruction: fields.instruction ?? null, baseBranch: 'main', baseCommit: base, attempt: 1,
    timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: [], commitSubject: null,
    eventDigest: 'd'.repeat(64), eventPayload: null, workspace: null, processId: null,
    result: { schema: 'paseo.queue.hook-result.v1', eventId, outcome: 'blocked', summary: refusal, metadata: {},
      changedPaths: [], commitSubjectSuffix: null },
    commit: null, remote: null, summary: refusal, error: fields.error ?? refusal,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), reconciledAt: null,
  });
}

test('a pre-workspace disposition settles only when the cancellation repeats the admission refusal', () => {
  const { store, task } = storeWithTask();
  try {
    const repeated = 'handoff does not reference a roadmap task';
    store.putHookEvent(record(task.id, 'task.pre_dispatch', { refusal: repeated }));
    assert.equal(settlesPreWorkspaceDispositionHook(store, task, [record(task.id, 'task.cancelled', {
      hookId: 'closeout', mode: 'integration_write', refusal: repeated,
      error: 'Integration write requires a clean synchronized base',
    })]), true, 'the same refusal line on the cancellation occurrence is the evidence');
    assert.equal(settlesPreWorkspaceDispositionHook(store, task, [record(task.id, 'task.cancelled', {
      hookId: 'closeout', refusal: 'a different refusal entirely',
    })]), false, 'an unrelated refusal never settles the admission');
    assert.equal(settlesPreWorkspaceDispositionHook(store, task, [{ event: 'task.cancelled' }]), false,
      'a value that is not a hook record is not evidence');
    assert.equal(settlesPreWorkspaceDispositionHook(store, task, []), false);
  } finally { store.close(); }
});

test('a task with any recorded delivery is never pre-workspace, whatever the hook said', () => {
  const { store, task } = storeWithTask();
  try {
    const refusal = 'handoff does not reference a roadmap task';
    store.putHookEvent(record(task.id, 'task.pre_dispatch', { refusal }));
    const delivered = store.update(task.id, { workspaceId: 'ws-1' });
    assert.equal(settlesPreWorkspaceDispositionHook(store, delivered, [record(task.id, 'task.cancelled', { refusal })]), false,
      'a recorded workspace means delivery began');
  } finally { store.close(); }
});

test('a legacy instructionless disposition settles only for the same hook, mode and required refusal', () => {
  const { store, task } = storeWithTask();
  try {
    const refusal = 'event carries no committed instruction artifact';
    const withCompletion = store.update(task.id, { completion: { eventId: 'worker-blocked', taskId: task.id,
      runId: 'run-1', status: 'blocked', summary: 'Legacy blocker' },
      disposition: { kind: 'cancel', status: 'preserving', requestedAt: new Date().toISOString(), requestedBy: 'operator',
        reason: 'Replacement landed', workDisposition: 'preserve', hookEmitted: false } as Task['disposition'] });
    const blocked = record(withCompletion.id, 'task.blocked', { hookId: 'lifecycle-state', mode: 'integration_write', refusal });
    store.putHookEvent(blocked);
    assert.equal(settlesLegacyInstructionlessDispositionHook(store, store.task(withCompletion.id), [
      record(withCompletion.id, 'task.cancelled', { hookId: 'lifecycle-state', mode: 'integration_write', refusal })]), true);
    assert.equal(settlesLegacyInstructionlessDispositionHook(store, store.task(withCompletion.id), [
      record(withCompletion.id, 'task.cancelled', { hookId: 'another-hook', mode: 'integration_write', refusal })]), false,
    'a different hook is not the same refusal');
    assert.equal(settlesLegacyInstructionlessDispositionHook(store, store.task(withCompletion.id), [
      record(withCompletion.id, 'task.cancelled', { hookId: 'lifecycle-state', mode: 'read_only', refusal })]), false,
    'a different mode is not the same refusal');
    assert.equal(settlesLegacyInstructionlessDispositionHook(store, store.task(withCompletion.id), [
      record(withCompletion.id, 'task.cancelled', { hookId: 'lifecycle-state', mode: 'integration_write', delivery: 'advisory', refusal })]), false,
    'an advisory cancellation never holds the transition it claims to settle');
    const withInstruction = store.update(withCompletion.id, { instruction: { path: 'handoff.md', commit: base,
      digest: `sha256:${'e'.repeat(64)}`, mediaType: 'text/markdown' } as Task['instruction'] });
    assert.equal(settlesLegacyInstructionlessDispositionHook(store, withInstruction, [
      record(withCompletion.id, 'task.cancelled', { hookId: 'lifecycle-state', mode: 'integration_write', refusal })]), false,
    'a task that carries its instruction artifact is not legacy-instructionless');
  } finally { store.close(); }
});
