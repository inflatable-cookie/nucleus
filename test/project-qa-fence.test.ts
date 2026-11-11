import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { boardSource } from './support/board-source';
import { Store } from '../core/store/store';
import { ProjectQaRunner } from './project-qa-runner-fixture';
import { ProjectQaSchedules, qaScheduleStateKey } from '../core/qa/project-qa-schedule';
import { qaFenceStatus, writeQaFence } from '../core/qa/qa-fence';
import { qaFenceText } from '../shared/qa-fence';
import {
  projectQaFence, projectQaFenceInputSchema, projectQaRunSchema, QA_FENCE_REFUSAL_PREFIX, submissionSchema,
  type ProjectQaFenceInput,
} from '../shared/contracts';

/**
 * QA admission fence (papercut 26636095; Tom, 2026-10-22: "Build as designed
 * (Recommended)", "Operator + relay (Recommended)", "10 min default, 2 h cap
 * (Recommended)"). A host-wide expiring fence on NEW project QA admissions: the
 * operator or an explicit relay writes it under an optimistic revision, the
 * claim refuses only a new run with a durable refused request, accepted replays
 * and joins pass, the scheduler mints no identity while fenced, and the
 * inventory is complete across all rows.
 */

const head = '1'.repeat(40), minute = 60_000;

async function runnerFixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'queue-qa-fence-'));
  const store = new Store(join(root, 'queue.sqlite'));
  const runner = new ProjectQaRunner(store, { dataDir: root, hostRunStateDir: join(root, 'host') });
  t.after(() => { runner.hostRuns.stop(); store.close(); return rm(root, { recursive: true, force: true }); });
  const internal = runner as any;
  internal.resolveRepository = async () => ({ key: 'fixture', origin: 'owner/repo', path: root, checkoutPath: root });
  internal.reconcile = async () => {};
  internal.integrationHead = async () => head;
  let submits = 0, joins = 0;
  internal.submitToHostScheduler = () => { submits++; };
  internal.attachQueued = () => { joins++; };
  return { root, store, runner, internal, submits: () => submits, joins: () => joins };
}

const set = (store: Store, extra: Partial<ProjectQaFenceInput> = {}, at?: number) =>
  writeQaFence(store, projectQaFenceInputSchema.parse({ action: 'set', expectedRevision: store.qaFenceRecord().revision,
    reason: 'Swapping the Effigy binary', caller: 'operator (board)', ...extra }), at);
const clear = (store: Store, extra: Partial<ProjectQaFenceInput> = {}, at?: number) =>
  writeQaFence(store, projectQaFenceInputSchema.parse({ action: 'clear', expectedRevision: store.qaFenceRecord().revision,
    caller: 'operator (board)', ...extra }), at);

test('only the operator or an explicit relay with its note writes the fence; a refusal writes nothing', async t => {
  const f = await runnerFixture(t);
  const parse = (input: Record<string, unknown>) => projectQaFenceInputSchema.safeParse({ action: 'set', expectedRevision: 0, reason: 'r', caller: 'operator', ...input });
  assert.equal(parse({}).success, true);
  assert.equal(parse({ reason: undefined }).success, false, 'a set needs a reason');
  assert.equal(parse({ minutes: 121 }).success, false, 'the cap is two hours');
  assert.equal(parse({ minutes: 120 }).success, true);
  assert.equal(parse({ relayed: true }).success, false, 'a relay needs the operator note');
  assert.equal(parse({ note: 'Tom said so' }).success, false, 'a note belongs to a relay');
  assert.equal(parse({ action: 'clear', reason: undefined, minutes: 5 }).success, false);
  assert.equal(projectQaFence.input.safeParse({ action: 'set', expectedRevision: 0, reason: 'r', caller: 'x', extra: 1 }).success, false);

  assert.throws(() => set(f.store, { caller: 'project-owner-thread' }), /Only the operator writes the QA admission fence.*project-owner-thread has neither/);
  assert.throws(() => set(f.store, { caller: 'the operator' }), /has neither/, 'an owner-sounding string is not the operator');
  assert.throws(() => set(f.store, { caller: 'operator (board)', relayed: true, note: 'Tom: fence it' }), /names the relaying agent/);
  assert.equal(f.store.qaFenceRecord().revision, 0, 'nothing was written');
  assert.equal(f.store.qaFenceInForce(), null);

  const relayed = set(f.store, { caller: 'install-owner', relayed: true, note: "Tom's ruling 2026-10-22: fence QA for the swap" });
  assert.deepEqual(relayed.view.fence?.setBy, { caller: 'install-owner', kind: 'relayed_note', note: "Tom's ruling 2026-10-22: fence QA for the swap" });
  const operator = set(f.store, { caller: 'operator' });
  assert.deepEqual(operator.view.fence?.setBy, { caller: 'operator', kind: 'operator', note: null });
});

test('the expiry is absolute: default ten minutes, a stale or retried write never renews, replaces or clears, and expiry writes nothing', async t => {
  const f = await runnerFixture(t);
  const at = Date.now();
  const first = set(f.store, {}, at);
  assert.equal(first.view.revision, 1);
  assert.equal(Date.parse(first.view.fence!.until), at + 10 * minute);
  // A lost reply retried with the same revision is refused; the expiry is unchanged.
  assert.throws(() => writeQaFence(f.store, projectQaFenceInputSchema.parse({ action: 'set', expectedRevision: 0, reason: 'retry', caller: 'operator' }), at + 5 * minute),
    /at revision 1, not 0.*never renews, replaces or clears a newer fence/);
  assert.equal(f.store.qaFenceRecord().fence?.until, first.view.fence!.until);
  // A stale client cannot clear a newer fence.
  const replaced = set(f.store, { minutes: 30, reason: 'Longer swap' }, at + minute);
  assert.equal(replaced.view.revision, 2);
  assert.throws(() => writeQaFence(f.store, projectQaFenceInputSchema.parse({ action: 'clear', expectedRevision: 1, caller: 'operator' }), at + 2 * minute), /at revision 2, not 1/);
  assert.equal(f.store.qaFenceInForce(at + 2 * minute)?.reason, 'Longer swap');
  // Expiry is read lazily and writes nothing.
  const expiredAt = at + 32 * minute;
  assert.equal(f.store.qaFenceInForce(expiredAt), null);
  assert.equal(f.store.qaFenceView(expiredAt).expired?.reason, 'Longer swap');
  assert.equal(f.store.qaFenceRecord().revision, 2);
  assert.throws(() => clear(f.store, {}, expiredAt), /No QA admission fence is in force/);
  // Clearing a fence in force records who cleared it; history keeps every write.
  set(f.store, {}, expiredAt);
  const cleared = clear(f.store, { caller: 'relay-agent', relayed: true, note: 'Tom: swap done, clear it' }, expiredAt + minute);
  assert.equal(cleared.view.fence, null);
  assert.equal(cleared.view.expired, null);
  const record = f.store.qaFenceRecord();
  assert.deepEqual(record.clearedBy, { caller: 'relay-agent', kind: 'relayed_note', note: 'Tom: swap done, clear it' });
  assert.deepEqual(record.history.map(entry => [entry.action, entry.revision]), [['set', 1], ['set', 2], ['set', 3], ['clear', 4]]);
});

test('a new admission is refused at the claim with a durable refused request and no run; replays and joins pass', async t => {
  const f = await runnerFixture(t);
  // Accepted before the fence: the same request replays its run while fenced.
  const accepted = await f.runner.run({ repository: f.root, requestId: 'accepted' });
  assert.equal(f.submits(), 1);
  set(f.store);
  const replayed = await f.runner.run({ repository: f.root, requestId: 'accepted' });
  assert.equal(replayed.id, accepted.id);
  // The run is still queued, so a new request joins it rather than creating work.
  const joined = await f.runner.run({ repository: f.root, requestId: 'joiner' });
  assert.equal(joined.id, accepted.id);
  assert.equal(f.runner.requestStatus({ requestId: 'joiner' }).requests[0].state, 'admitted');
  assert.equal(f.joins(), 1);
  // Once it settles, a new run would be new work: refused, durably, with nothing queued.
  f.store.putQaRun({ ...accepted, state: 'passed', exitCode: 0, finishedAt: new Date().toISOString() });
  await assert.rejects(f.runner.run({ repository: f.root, requestId: 'fenced' }), new RegExp(`^Error: ${QA_FENCE_REFUSAL_PREFIX} until .*Swapping the Effigy binary.*no QA run was created`));
  const refused = f.runner.requestStatus({ requestId: 'fenced' }).requests[0];
  assert.equal(refused.state, 'refused');
  assert.ok(refused.diagnostic.startsWith(QA_FENCE_REFUSAL_PREFIX));
  assert.equal(refused.runId, null);
  assert.equal(f.store.latestQaRun('fixture')?.id, accepted.id, 'no QA run was written');
  assert.equal(f.submits(), 1, 'no host reservation was submitted');
  // The refused identity stays refused; a fresh request admits once the fence is cleared.
  clear(f.store);
  await assert.rejects(f.runner.run({ repository: f.root, requestId: 'fenced' }), /refused/);
  const fresh = await f.runner.run({ repository: f.root, requestId: 'after-clear' });
  assert.notEqual(fresh.id, accepted.id);
  assert.equal(f.submits(), 2);
});

test('a request already preparing when the fence lands is refused at its claim, never admitted', async t => {
  const f = await runnerFixture(t);
  let release!: () => void;
  const fetched = new Promise<void>(resolve => { release = resolve; });
  f.internal.integrationHead = async () => { await fetched; return head; };
  const delivery = f.runner.run({ repository: f.root, requestId: 'in-flight' });
  assert.equal(f.runner.requestStatus({ requestId: 'in-flight' }).requests[0].state, 'preparing');
  const status = set(f.store);
  assert.deepEqual(status.inventory.map(item => [item.kind, item.id, item.state]), [['qa_request', 'in-flight', 'preparing']],
    'the in-flight request is in the inventory returned with the fence');
  release();
  await assert.rejects(delivery, new RegExp(QA_FENCE_REFUSAL_PREFIX));
  assert.equal(f.runner.requestStatus({ requestId: 'in-flight' }).requests[0].state, 'refused');
  assert.equal(f.submits(), 0);
  assert.deepEqual(qaFenceStatus(f.store).inventory, []);
});

test('the inventory is complete across all rows: unfinished runs behind a newer latest, preparing requests and milestone capacity custody', async t => {
  const f = await runnerFixture(t);
  const at = new Date().toISOString();
  const run = (id: string, key: string, state: 'queued' | 'running' | 'passed', finishedAt: string | null) => f.store.putQaRun(projectQaRunSchema.parse({ id, key,
    repository: { origin: key, path: f.root }, state, baseBranch: 'main', base: head, argv: ['effigy', 'qa'], digest: 'b'.repeat(64), capacityWait: null,
    capacityUnavailable: false, exitCode: state === 'passed' ? 0 : null, durationMs: 0, outputTail: '', startedAt: at, submittedAt: at, finishedAt, pid: null }));
  run('older-queued', 'repo-a', 'queued', null);
  run('newer-passed', 'repo-a', 'passed', at);
  run('running-b', 'repo-b', 'running', null);
  run('done-c', 'repo-c', 'passed', at);
  assert.equal(f.store.latestQaRun('repo-a')?.id, 'newer-passed', 'the latest index hides the older queued run');
  f.store.setMeta('projectQaRequest:stale-preparing', { id: 'stale-preparing', input: { repository: 'repo-d', baseBranch: 'main' },
    ownerInstance: '00000000-0000-4000-8000-000000000000', ownerPid: 1, receivedAt: '2026-01-01T00:00:00.000Z', state: 'preparing', runId: null, diagnostic: '' });
  f.store.setMeta('projectQaRequest:refused', { id: 'refused', input: { repository: 'repo-d', baseBranch: 'main' },
    ownerInstance: '00000000-0000-4000-8000-000000000000', ownerPid: 1, receivedAt: at, state: 'refused', runId: null, diagnostic: 'x' });
  const host = (id: string, state: string, priority: string, capacityReleasedAt: string | null) =>
    f.store.db.prepare('INSERT INTO host_run_records(id, repository, state, data) VALUES (?, ?, ?, ?)').run(id, 'repo-e', state, JSON.stringify({ id, priority, state, capacityReleasedAt }));
  host('milestone-queued', 'queued', 'milestone', null);
  host('milestone-holding', 'settled', 'milestone', null);
  host('milestone-released', 'settled', 'milestone', at);
  host('validation-running', 'running', 'validation', null);
  f.store.db.prepare('INSERT INTO project_qa_runs(id, repository, data) VALUES (?, ?, ?)').run('broken', 'repo-f', JSON.stringify({ state: 'queued' }));
  // A teardown retry settled these rows while descendants escaped (Sol #606 P1): custody until proven dead.
  const escaped = [{ pid: 4242, startIdentity: 'escaped-start' }];
  f.store.putQaRun({ ...f.store.qaRun('done-c')!, id: 'held-escaped', state: 'hold', escapedDescendants: escaped });
  f.store.putQaRun({ ...f.store.qaRun('done-c')!, id: 'proven-dead', state: 'hold', escapedDescendants: escaped });
  const proof = (id: string) => f.store.db.prepare('INSERT INTO host_run_records(id, repository, state, data) VALUES (?, ?, ?, ?)').run(id, 'repo-c', 'settled',
    JSON.stringify({ id, priority: 'milestone', state: 'settled', capacityReleasedAt: at, escapedDescendantsProvenDeadAt: at, settlement: { result: { escapedDescendants: escaped } } }));
  proof('proven-dead');
  // An older proof does not cover a later teardown retry's new escapee (Sol #606 second P1).
  f.store.putQaRun({ ...f.store.qaRun('done-c')!, id: 'retry-escaped', state: 'hold', escapedDescendants: [...escaped, { pid: 4343, startIdentity: 'retry-start' }] });
  proof('retry-escaped');
  // A malformed proof proves nothing and never breaks the read (Sol #606 P2).
  for (const [id, shape] of [['proof-object', {}], ['proof-null-entry', [null]], ['proof-bad-entry', [{ pid: 'x' }]]] as const) {
    f.store.putQaRun({ ...f.store.qaRun('done-c')!, id, state: 'hold', escapedDescendants: escaped });
    f.store.db.prepare('INSERT INTO host_run_records(id, repository, state, data) VALUES (?, ?, ?, ?)').run(id, 'repo-c', 'settled',
      JSON.stringify({ id, priority: 'milestone', state: 'settled', capacityReleasedAt: at, escapedDescendantsProvenDeadAt: at, settlement: { result: { escapedDescendants: shape } } }));
  }
  const inventory = set(f.store).inventory;
  assert.deepEqual(inventory.map(item => [item.kind, item.id, item.state]), [
    ['qa_run', 'older-queued', 'queued'], ['qa_run', 'running-b', 'running'], ['qa_run', 'broken', 'unreadable'], ['qa_run', 'held-escaped', 'hold'], ['qa_run', 'retry-escaped', 'hold'],
    ['qa_run', 'proof-object', 'hold'], ['qa_run', 'proof-null-entry', 'hold'], ['qa_run', 'proof-bad-entry', 'hold'],
    ['qa_request', 'stale-preparing', 'preparing'],
    ['host_run', 'milestone-queued', 'queued'], ['host_run', 'milestone-holding', 'settled'],
  ]);
  assert.match(inventory.find(item => item.id === 'stale-preparing')!.detail, /delivery is unresolved/, 'an old preparing request is not aged out');
  assert.match(inventory.find(item => item.id === 'milestone-holding')!.detail, /still holding host capacity/);
  assert.match(inventory.find(item => item.id === 'held-escaped')!.detail, /Finished with 1 escaped descendant and no durable proof they exited/);
  assert.deepEqual(qaFenceStatus(f.store).inventory, inventory, 'the read returns the same complete inventory');
});

async function scheduleFixture(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'qa-fence-schedule-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const runner = new ProjectQaRunner(store, { dataDir: dir, hostRunStateDir: join(dir, 'hosts') });
  const key = 'owner/repo';
  let launched = 0, serial = 0;
  store.patchRepository({ origin: key, path: dir }, { qa: { argv: ['effigy', 'qa'], timeoutMs: 1000, schedule: { afterMerges: 1, maxIntervalHours: 24 } } });
  const project = store.projectFor(dir, key)!;
  store.setProjectPlanner({ key: project.key, agentId: 'planner', setBy: 'test' });
  const internal = runner as any;
  internal.resolveRepository = async () => ({ key, origin: key, path: dir, checkoutPath: dir });
  internal.reconcile = async () => {};
  internal.integrationHead = async () => head;
  internal.submitToHostScheduler = () => { launched++; };
  internal.attachQueued = () => {};
  const schedules = new ProjectQaSchedules(store, runner, { includes: async () => true });
  const merge = () => {
    const task = store.insert(submissionSchema.parse({ submissionId: `merge-${++serial}`, title: `merge ${serial}`, repoPath: dir,
      planningCommit: head, handoffPath: 'h.md', originAgentId: 'author' }), 'host', 'brief', head, {}, undefined, key);
    store.update(task.id, { phase: 'done', resolution: { ...task.resolution, mergedCommit: serial.toString(16).padStart(40, '0') } }, 'fixture');
  };
  t.after(async () => { runner.hostRuns.stop(); store.close(); await rm(dir, { recursive: true, force: true }); });
  return { store, runner, internal, schedules, merge, key, state: () => store.getMeta<any>(qaScheduleStateKey(key)), launched: () => launched };
}

test('the scheduler mints no request identity while fenced and admits the whole batch once after clear', async t => {
  const f = await scheduleFixture(t);
  set(f.store);
  f.merge();
  await f.schedules.tick();
  await f.schedules.tick();
  assert.equal(f.launched(), 0);
  assert.equal(f.state()?.pending ?? null, null, 'no identity was minted while fenced');
  assert.equal(f.state()?.lastSignature ?? null, null, 'the batch is not marked refused');
  clear(f.store);
  await f.schedules.tick();
  assert.equal(f.launched(), 1);
  assert.equal(f.runner.requestStatus({ requestId: f.state().pending.id }).requests[0].state, 'admitted');
});

test('a fence landing during scheduled admission refuses once as a lifecycle refusal; the batch admits after clear without hot-spinning', async t => {
  const f = await scheduleFixture(t);
  f.merge();
  f.internal.integrationHead = async () => { set(f.store); return head; };
  await f.schedules.tick();
  assert.equal(f.launched(), 0);
  const first = f.state().pending.id as string;
  assert.ok(f.runner.requestStatus({ requestId: first }).requests[0].diagnostic.startsWith(QA_FENCE_REFUSAL_PREFIX));
  f.internal.integrationHead = async () => head;
  // Reconciled as lifecycle: the signature stays open and the next identity is a new generation, but none is minted while fenced.
  await f.schedules.tick();
  await f.schedules.tick();
  assert.equal(f.state().pending, null);
  assert.equal(f.state().lastSignature, null);
  assert.equal(f.state().diagnostic, '');
  assert.equal(f.state().requestGeneration, 1);
  assert.equal(f.launched(), 0);
  clear(f.store);
  await f.schedules.tick();
  assert.equal(f.launched(), 1);
  assert.notEqual(f.state().pending.id, first);
  assert.ok(f.state().pending.id.endsWith(':1'));
});

test('the board shows the fence with its reason, setter and countdown, the operator Clear on the current revision, and fenced Run QA buttons', async () => {
  const now = Date.parse('2026-10-22T20:00:00Z');
  const fence = { id: 'f', until: '2026-10-22T20:07:30Z', reason: 'Swapping the Effigy binary', setAt: '2026-10-22T19:57:30Z',
    setBy: { caller: 'install-owner', kind: 'relayed_note' as const, note: 'Tom: fence it' } };
  assert.match(qaFenceText(fence, now), /^New QA admissions are fenced until .* \(8 min left\): Swapping the Effigy binary · set by install-owner, relaying the operator$/);
  assert.match(qaFenceText({ ...fence, setBy: { caller: 'operator (board)', kind: 'operator', note: null } }, now), /set by the operator$/);
  const read = (file: string) => readFileSync(new URL(`../client/${file}`, import.meta.url), 'utf8');
  const board = boardSource();
  // Cutover 7 (PR 850) reformatted the board; the fence notice and its clear
  // call keep their shape across line breaks.
  assert.match(board, /<QaFenceNotice\s+fence=\{qaFence\}[\s\S]*?writeQaFence\(\{\s*action: "clear",\s*expectedRevision: state\.qaFence\.revision,\s*caller: "operator \(board\)",?\s*\}\)/);
  assert.match(read('qa-runs-tab.tsx'), /text=\{fence \? "QA fenced" : "Run QA"\} label="Run QA" disabled=\{busy \|\| !launchProjects\.length \|\| Boolean\(fence\)\}/);
  assert.match(read('qa-runs-tab.tsx'), /<QaFenceNotice fence=\{fence\} inventory=\{fenceInventory\}/);
  // #869 moved QA launch out of Planning; the fenced launch is only in QA runs.
  assert.doesNotMatch(read('planning-panel.tsx'), /Run full QA|Run QA/);
  assert.match(read('qa-fence-notice.tsx'), /The fence covers project QA only, not task validation or Effigy client runs\./);
});

test('undecodable stored rows never break the inventory or the fence: rows list as unreadable and an unreadable fence record fails closed', async t => {
  const f = await runnerFixture(t);
  f.store.db.prepare('INSERT INTO project_qa_runs(id, repository, data) VALUES (?, ?, ?)').run('bad-run', 'repo-a', '{');
  f.store.db.prepare("INSERT INTO meta(key, value) VALUES ('projectQaRequest:bad-request', '{')").run();
  // Decodable but ill-typed fields are formatted defensively (Sol #606 P2).
  f.store.setMeta('projectQaRequest:odd-fields', { id: { toString: null }, state: 'preparing', input: { repository: 7 }, ownerPid: { toString: null }, ownerInstance: [], receivedAt: null });
  f.store.db.prepare('INSERT INTO host_run_records(id, repository, state, data) VALUES (?, ?, ?, ?)').run('bad-host', 'repo-b', 'running', '{');
  f.store.putQaRun(projectQaRunSchema.parse({ id: 'escaped', key: 'repo-c', repository: { origin: 'repo-c', path: f.root }, state: 'hold', baseBranch: 'main', base: head,
    argv: ['effigy', 'qa'], digest: 'b'.repeat(64), capacityWait: null, capacityUnavailable: false, exitCode: 1, durationMs: 0, outputTail: '',
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), pid: null, escapedDescendants: [{ pid: 7, startIdentity: 's' }] }));
  f.store.db.prepare('INSERT INTO host_run_records(id, repository, state, data) VALUES (?, ?, ?, ?)').run('escaped', 'repo-c', 'settled', '{');
  const inventory = set(f.store).inventory;
  assert.deepEqual(inventory.map(item => [item.kind, item.id, item.state]), [
    ['qa_run', 'bad-run', 'unreadable'], ['qa_run', 'escaped', 'hold'],
    ['qa_request', 'bad-request', 'unreadable'], ['qa_request', 'odd-fields', 'preparing'],
    ['host_run', 'bad-host', 'unreadable'], ['host_run', 'escaped', 'unreadable'],
  ]);
  // An unreadable fence record is not "no fence": admission stays fenced, the board says why, and the operator writes over it at revision 0.
  f.store.db.prepare("UPDATE meta SET value='{' WHERE key='qaAdmissionFence'").run();
  const view = f.store.qaFenceView();
  assert.equal(view.revision, 0);
  assert.equal(view.fence?.setBy.kind, 'unreadable_record');
  assert.match(qaFenceText(view.fence!, Date.now()), /^New QA admissions are fenced: The stored QA fence record is unreadable/);
  f.store.db.prepare('DELETE FROM project_qa_runs').run();
  await assert.rejects(f.runner.run({ repository: f.root, requestId: 'while-unreadable' }), new RegExp(QA_FENCE_REFUSAL_PREFIX));
  assert.equal(f.submits(), 0);
  assert.throws(() => set(f.store, { caller: 'someone-else' }), /has neither/, 'authority still applies to the repair');
  const cleared = clear(f.store);
  assert.equal(cleared.view.fence, null);
  assert.equal(cleared.view.revision, 1);
  assert.equal((await f.runner.run({ repository: f.root, requestId: 'after-repair' })).state, 'queued');
});
