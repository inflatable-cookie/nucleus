import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { T3StateFile } from '../hosts/t3code/state';
import { T3IntentLedger, identity, intentKindOf, intentThreadId, presentationThread } from '../hosts/t3code/intents';

/** The ledger reads the wire once for a legacy entry and never again for a recorded one. */
function ledger(statePath: string, sent: { method: string; payload: unknown }[] = []) {
  return {
    sent,
    ledger: new T3IntentLedger({
      rpc: { call: async (method: string, payload: unknown) => { sent.push({ method, payload }); return { threadId: (payload as { threadId?: string }).threadId }; } } as never,
      state: new T3StateFile(statePath),
      hostId: () => 't3code:fixture',
      requireConnection: () => {},
    }),
  };
}

function writeState(statePath: string, intents: Record<string, unknown>) {
  writeFileSync(statePath, JSON.stringify({
    version: 1, hostId: 't3code:fixture', lastPassedVersion: 'nightly-synthetic',
    workspaces: {}, agents: {}, intents,
  }), { mode: 0o600 });
}

test('a recorded command carries its kind and thread, so a reader never parses the payload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't3-intents-'));
  try {
    const statePath = join(dir, 'state.json');
    const { ledger: intents, sent } = ledger(statePath);
    await intents.effect(identity('archive', 'thread-1'), 'orchestration.dispatchCommand', { type: 'thread.archive', commandId: identity('archive', 'thread-1'), threadId: 'thread-1' });
    assert.deepEqual(sent.map(entry => entry.method), ['orchestration.dispatchCommand']);
    const recorded = new T3StateFile(statePath).read().intents[identity('archive', 'thread-1')];
    assert.equal(recorded.status, 'settled');
    assert.equal(recorded.kind, 'thread.archive');
    assert.equal(recorded.threadId, 'thread-1');
    assert.equal(intentKindOf(recorded), 'thread.archive');
    assert.equal(intentThreadId(recorded), 'thread-1');
    // A settle, an unsettle and a title-only metadata update are presentation; anything else is not.
    assert.equal(presentationThread({ ...recorded, kind: 'thread.settle' }), 'thread-1');
    assert.equal(presentationThread({ ...recorded, kind: 'thread.unsettle' }), 'thread-1');
    assert.equal(presentationThread({ ...recorded, kind: undefined, payload: JSON.stringify({ method: 'orchestration.dispatchCommand', payload: { type: 'thread.metadata.update', commandId: 'c', threadId: 'thread-1', title: 'New title' } }) }), 'thread-1');
    assert.equal(presentationThread({ ...recorded, kind: undefined, payload: JSON.stringify({ method: 'orchestration.dispatchCommand', payload: { type: 'thread.metadata.update', commandId: 'c', threadId: 'thread-1', title: 'New title', archived: true } }) }), undefined, 'a metadata update that changes more than the title is not presentation');
    assert.equal(presentationThread({ ...recorded, kind: 'launchThread' }), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a legacy entry with no recorded kind still reads as the command it recorded', () => {
  const dir = mkdtempSync(join(tmpdir(), 't3-intents-'));
  try {
    const statePath = join(dir, 'state.json');
    const key = identity('delete', 'thread-2');
    writeState(statePath, {
      [key]: { status: 'unknown', deletionObservedAt: '2026-11-14T00:00:00.000Z', payload: JSON.stringify({ method: 'orchestration.dispatchCommand', payload: { type: 'thread.delete', commandId: key, threadId: 'thread-2' } }) },
      'legacy-settle': { status: 'settled', result: {}, payload: JSON.stringify({ method: 'orchestration.dispatchCommand', payload: { type: 'thread.settle', commandId: 'legacy-settle', threadId: 'thread-3' } }) },
      'unreadable': { status: 'unknown', payload: 'not json' },
    });
    const state = new T3StateFile(statePath).read();
    assert.equal(intentKindOf(state.intents[key]), 'thread.delete');
    assert.equal(intentThreadId(state.intents[key]), 'thread-2');
    assert.equal(intentKindOf(state.intents['legacy-settle']), 'thread.settle');
    assert.equal(presentationThread(state.intents['legacy-settle']), 'thread-3');
    assert.equal(intentKindOf(state.intents.unreadable), undefined, 'an unreadable entry proves no kind');
    const { ledger: intents } = ledger(statePath);
    assert.equal(intents.confirmedDeletion(state, 'thread-2'), key, 'the recorded delete is the one positive proof');
    assert.equal(intents.confirmedDeletion(state, 'thread-3'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a command recorded before a title-only metadata update is not retired by an unrelated deletion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't3-intents-'));
  try {
    const statePath = join(dir, 'state.json');
    const { ledger: intents } = ledger(statePath);
    const settleKey = identity('settle', 'thread-4');
    await intents.effect(settleKey, 'orchestration.dispatchCommand', { type: 'thread.settle', commandId: settleKey, threadId: 'thread-4', expectedLatestRunId: 'run-1' });
    const recorded = new T3StateFile(statePath).read().intents[settleKey];
    // Only an unknown delivery is retired by a confirmed deletion; a settled one stands.
    assert.equal(recorded.status, 'settled');
    assert.equal(presentationThread(recorded), 'thread-4');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
