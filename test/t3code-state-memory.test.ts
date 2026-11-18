import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProvenPreSendRefusalError } from '../core/host';
import { T3CodeHost } from '../hosts/t3code/adapter';
import { T3IntentLedger, identity } from '../hosts/t3code/intents';
import { RETAINED_INTENT_BODIES, T3StateFile, canonical, payloadDigest } from '../hosts/t3code/state';
import type { Task } from '../shared/contracts';
import { STAMP, t3Fake } from './support/t3code-fake';

/**
 * Multi-host efficiency (nucleus#1327): the service is the T3 state file's single
 * owner. It holds the parsed record in memory, writes through on change, and the
 * board snapshot's host status reads memory, never the file. The file keeps a
 * bounded history: a settled command past the newest window keeps its delivery
 * receipt and loses the message or launch body that made the file heavy.
 *
 * The fixture here is a stored shape (one owner-only JSON record, synthetic ids),
 * not a live T3: nothing in this file talks to a real host.
 */

const THREADS = 39;
/** The message text a real dispatch carries; large enough that the file's weight shows. */
const body = (seed: string, size = 4_096) => `${seed}:${'x'.repeat(size)}`;

interface StoredIntentOptions {
  status?: 'settled' | 'unknown' | 'refused';
  kind?: string;
  threadId?: string;
  result?: unknown;
  payload?: string;
}

/**
 * One record as the service writes it: the stored shape, with synthetic ids and as
 * many commands as the file held on 2026-11-18 (686 of them, 12 MB).
 */
function storedState(intents: Record<string, StoredIntentOptions>): string {
  return JSON.stringify({
    version: 1, hostId: '', lastPassedVersion: '',
    workspaces: Object.fromEntries(Array.from({ length: 4 }, (_, index) => [
      `nucleus-worktree-${String(index).padStart(40, '0')}`,
      { id: `nucleus-worktree-${String(index).padStart(40, '0')}`, directory: `/synthetic/worktree-${index}`,
        projectId: 'synthetic-project', title: `Synthetic worktree ${index}` },
    ])),
    agents: Object.fromEntries(Array.from({ length: THREADS }, (_, index) => [
      `thread-${index}`, { id: `thread-${index}`, workspaceId: `nucleus-worktree-${String(index % 4).padStart(40, '0')}`,
        labels: { 'nucleus.task': `synthetic-task-${index % 5}`, 'nucleus.role': index % 5 === 0 ? 'worker' : 'reviewer' } },
    ])),
    intents: Object.fromEntries(Object.entries(intents).map(([key, entry]) => [key, {
      status: entry.status ?? 'settled',
      payload: entry.payload ?? canonical({ method: 'orchestration.dispatchCommand',
        payload: { type: 'message.dispatch', commandId: key, threadId: entry.threadId ?? 'thread-0', text: body(key) } }),
      ...(entry.result === undefined ? {} : { result: entry.result }),
      ...(entry.kind === undefined ? {} : { kind: entry.kind }),
      ...(entry.threadId === undefined ? {} : { threadId: entry.threadId }),
    }])),
    settledThreads: { 'thread-0': identity('settle', 'thread-0') },
    nesting: { state: 'fallback', reason: 'synthetic provider absent', at: STAMP },
  });
}

/** A fixture directory and the state path inside it. */
function fixture(t: TestContext): { root: string; statePath: string } {
  const root = mkdtempSync(join(tmpdir(), 't3code-state-memory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, statePath: join(root, 'state.json') };
}

/**
 * One settled launch, and commands after it so it falls outside the retained window.
 * The launch's answer is the projection the service stored; only its thread is read again.
 */
function manyCommands(count: number): Record<string, StoredIntentOptions> {
  const intents: Record<string, StoredIntentOptions> = {};
  for (let index = 0; index < count; index++) {
    const key = identity('message', `synthetic-message-${index}`);
    intents[key] = { kind: 'message.dispatch', threadId: `thread-${index % THREADS}`,
      result: { messageId: `message:${index}`, deliveredAt: STAMP }, payload: canonical({ method: 'orchestration.dispatchCommand',
        payload: { type: 'message.dispatch', commandId: key, threadId: `thread-${index % THREADS}`, text: body(key) } }) };
  }
  return intents;
}

test('the snapshot path reads host state from memory: no file read after the one load', async (t: TestContext) => {
  const { root } = fixture(t), statePath = join(root, 'state.json');
  const directory = await realpath(root);
  const server = await t3Fake(t, directory);
  // The stored shape the service would have written before this process started.
  const stored = manyCommands(400);
  const oldestKey = Object.keys(stored)[0];
  writeFileSync(statePath, storedState({ ...stored, 'synthetic-settle': { kind: 'thread.settle', threadId: 'thread-1',
    payload: canonical({ method: 'orchestration.dispatchCommand', payload: { type: 'thread.settle', commandId: 'synthetic-settle', threadId: 'thread-1' } }) } }),
  { mode: 0o600 });
  const host = new T3CodeHost({ endpoint: server.endpoint, bearer: 'synthetic-bearer', statePath, timeoutMs: 2_000, probeThreadId: 'synthetic-probe' });
  t.after(() => host.close());
  await host.connect();
  const status = host.supportThreadStatus, parenting = host.nativeParentingStatus;
  assert.match(status, /^support threads visible/);
  assert.match(parenting, /^native parenting/);
  // The connect write bounded the history this process owns, with no separate pass.
  const written = JSON.parse(readFileSync(statePath, 'utf8')) as { intents: Record<string, { payloadDigest?: string }> };
  assert.equal(written.intents[oldestKey].payloadDigest, payloadDigest(stored[oldestKey].payload!), 'the oldest command keeps its receipt only');

  // The service is the file's single owner; removing it cannot change an answer,
  // because nothing on this path reads it again.
  unlinkSync(statePath);
  assert.equal(host.supportThreadStatus, status, 'the support-thread status line is the memory record');
  assert.equal(host.nativeParentingStatus, parenting);
  assert.equal(Object.keys(host.state.read().agents).length, THREADS);
  const task = { directory: '/synthetic/worktree-1' } as Task;
  assert.equal((await host.findWorkspaces(task)).length, 1, 'a repeated adapter read answers from memory');
  for (let pass = 0; pass < 200; pass++) {
    host.supportThreadStatus; host.nativeParentingStatus; host.state.read();
    assert.equal((await host.findWorkspaces(task)).length, 1);
  }
  // A fresh reader of the same path sees the file, which is now absent: the loaded
  // record above is memory, not a second parse of the file.
  assert.deepEqual(new T3StateFile(statePath).read().agents, {}, 'a second owner-path load sees the absent file');
});

test('a change written through survives a restart, and a corrupted or unsafe file still refuses', (t: TestContext) => {
  const { statePath } = fixture(t);
  writeFileSync(statePath, storedState(manyCommands(8)), { mode: 0o600 });
  const state = new T3StateFile(statePath);
  state.update(next => { next.supportThreads = 'hidden'; next.rowTitles = { 'thread-2': 'Doing: synthetic' }; });
  // A restart: a fresh owner-path reader loads exactly what the write recorded.
  const restarted = new T3StateFile(statePath).read();
  assert.equal(restarted.supportThreads, 'hidden');
  assert.equal(restarted.rowTitles?.['thread-2'], 'Doing: synthetic');
  assert.equal(statSync(statePath).mode & 0o777, 0o600, 'the file stays owner-only');

  // A corrupted record is unreadable, exactly as before.
  writeFileSync(statePath, 'not json', { mode: 0o600 });
  assert.throws(() => new T3StateFile(statePath).read(), /T3Code durable state is unreadable/);
  // A world-readable record is unsafe, exactly as before.
  writeFileSync(statePath, storedState(manyCommands(1)), { mode: 0o600 });
  chmodSync(statePath, 0o644);
  assert.throws(() => new T3StateFile(statePath).read(), /T3Code durable state is unreadable/);
});

/** The ledger over one state file, and the commands it sends. */
function ledgerFor(statePath: string) {
  const sent: Array<{ method: string; payload: unknown }> = [];
  // One state file, as the service has one: the ledger and the test read the same
  // in-memory record.
  const state = new T3StateFile(statePath);
  return {
    sent,
    state,
    intents: new T3IntentLedger({
      rpc: { call: async (method: string, payload: unknown) => { sent.push({ method, payload }); return { threadId: (payload as { threadId?: string }).threadId }; } } as never,
      state,
      hostId: () => 't3code:fixture',
      requireConnection: () => {},
    }),
  };
}

test('bounded history keeps every delivery receipt and drops only the bodies it no longer reads', async (t: TestContext) => {
  const { statePath } = fixture(t);
  const commands = manyCommands(400);
  const keys = Object.keys(commands);
  const oldest = keys[0], newest = keys.at(-1)!;
  const launchKey = 'synthetic-launch';
  const launchPayload = canonical({ method: 'orchestration.launchThread', payload: { commandId: launchKey, threadId: 'thread-launch',
    initialMessage: { messageId: identity('message', launchKey), text: body(launchKey, 8_192) } } });
  const deleteId = 'thread-deleted';
  const deleteKey = identity('delete', deleteId);
  const deletePayload = canonical({ method: 'orchestration.dispatchCommand',
    payload: { type: 'thread.delete', commandId: deleteKey, threadId: deleteId } });
  const settleKey = identity('settle', 'thread-settled');
  const settlePayload = canonical({ method: 'orchestration.dispatchCommand',
    payload: { type: 'thread.settle', commandId: settleKey, threadId: 'thread-settled', expectedLatestRunId: 'run-1' } });
  const unresolvedKey = 'synthetic-unresolved';
  const unresolvedPayload = canonical({ method: 'orchestration.dispatchCommand',
    payload: { type: 'message.dispatch', commandId: unresolvedKey, threadId: 'thread-0', text: body(unresolvedKey) } });
  writeFileSync(statePath, storedState({
    // Built oldest first: the first entries are the ones that leave the window.
    [`${launchKey}`]: { kind: 'launchThread', threadId: 'thread-launch', payload: launchPayload,
      result: { threadId: 'thread-launch', projection: body('launch-projection', 16_384) } },
    [deleteKey]: { kind: 'thread.delete', threadId: deleteId, payload: deletePayload, result: { deleted: true } },
    [unresolvedKey]: { kind: 'message.dispatch', threadId: 'thread-0', payload: unresolvedPayload, status: 'unknown' },
    [settleKey]: { kind: 'thread.settle', threadId: 'thread-settled', payload: settlePayload, result: { settled: true } },
    ...commands,
  }), { mode: 0o600 });
  const before = statSync(statePath).size;

  const { intents, state, sent } = ledgerFor(statePath);
  // The ordinary write path bounds the history: no separate pass, no timer.
  state.update(next => { next.supportThreads = 'setting_off'; });

  const saved = JSON.parse(readFileSync(statePath, 'utf8')) as { intents: Record<string, { payload: string; status: string; payloadDigest?: string; result?: unknown }> };
  assert.ok(statSync(statePath).size < before / 4, `the file stays small (${statSync(statePath).size} of ${before})`);
  // An unresolved delivery is never compacted: it is exactly the record a later
  // exact lookup or settle reads before deciding anything.
  assert.equal(saved.intents[unresolvedKey].payload, unresolvedPayload);
  assert.equal(saved.intents[unresolvedKey].status, 'unknown');
  assert.equal(saved.intents[unresolvedKey].payloadDigest, undefined);
  // A deletion receipt keeps its wire: `confirmedDeletion` reads its command id.
  assert.equal(saved.intents[deleteKey].payload, deletePayload);
  assert.equal(intents.confirmedDeletion(state.read(), deleteId), deleteKey, 'the exact deletion lookup still answers');
  // The newest commands keep their whole body and answer, so a retry replays them.
  assert.equal(saved.intents[newest].payload, commands[newest].payload);
  assert.deepEqual(saved.intents[newest].result, commands[newest].result);
  // An older command keeps its receipt: identity, status, digest, and the identity a
  // launch replay decodes.
  assert.equal(saved.intents[oldest].payload, '');
  assert.equal(saved.intents[oldest].status, 'settled');
  assert.equal(saved.intents[oldest].payloadDigest, payloadDigest(commands[oldest].payload!));
  assert.deepEqual(saved.intents[launchKey].result, { threadId: 'thread-launch' }, 'a launch replay reads the thread it created');
  assert.equal(saved.intents[settleKey].status, 'settled', 'a settle receipt survives, so its command id stays taken');

  // A repeat of a compacted command replays its recorded outcome and sends nothing.
  const replay = await intents.effect(oldest, 'orchestration.dispatchCommand',
    JSON.parse(commands[oldest].payload!).payload);
  assert.equal(replay, undefined);
  assert.deepEqual(sent, [], 'a settled command is never sent again');
  const launchReplay = await intents.effect(launchKey, 'orchestration.launchThread', JSON.parse(launchPayload).payload);
  assert.deepEqual(launchReplay, { threadId: 'thread-launch' });
  assert.deepEqual(sent, [], 'a settled launch is never sent again');

  // A changed payload under the same identity is still refused, from the digest.
  await assert.rejects(intents.effect(oldest, 'orchestration.dispatchCommand',
    { type: 'message.dispatch', commandId: oldest, threadId: 'thread-0', text: 'changed' }), ProvenPreSendRefusalError);
  assert.deepEqual(sent, []);

  // No command identity is dropped, and nothing re-expands on the next write.
  const compacted = state.read().intents[oldest];
  state.update(next => { next.supportThreads = 'hidden'; });
  assert.deepEqual(state.read().intents[oldest], compacted);
  assert.equal(Object.keys(state.read().intents).length, Object.keys(commands).length + 4, 'every recorded command identity stays');
});
