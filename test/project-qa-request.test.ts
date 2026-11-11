import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { ProjectQaRunner } from './project-qa-runner-fixture';
import { projectQaRequestStatus, projectQaRunInputSchema } from '../shared/contracts';

const head = '1'.repeat(40);
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'queue-qa-request-'));
  const store = new Store(join(root, 'queue.sqlite'));
  const runner = new ProjectQaRunner(store, { dataDir: root, hostRunStateDir: join(root, 'host') });
  t.after(() => { runner.hostRuns.stop(); store.close(); return rm(root, { recursive: true, force: true }); });
  // Isolate delivery/admission from git and actual commands. Admission is real;
  // the scheduler boundary only captures the durable row and never launches.
  const internal = runner as any;
  internal.resolveRepository = async () => ({ key: 'fixture', origin: 'owner/repo', path: root, checkoutPath: root });
  internal.reconcile = async () => {};
  internal.integrationHead = async () => head;
  let submits = 0;
  internal.submitToHostScheduler = () => { submits++; };
  internal.attachQueued = () => { submits++; };
  return { root, store, runner, internal, submits: () => submits };
}

test('request is durable before the first await; pending duplicate cannot fetch or launch', async t => {
  const f = await fixture(t);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let lookups = 0;
  f.internal.resolveRepository = async () => { lookups++; await pending; return { key: 'fixture', origin: 'owner/repo', path: f.root, checkoutPath: f.root }; };
  const input = { repository: f.root, requestId: 'pending', expectedHead: head };
  const delivery = f.runner.run(input);
  const preparing = f.runner.requestStatus({ requestId: 'pending' });
  assert.equal(preparing.requests[0].state, 'preparing');
  assert.equal(preparing.requests[0].ownerPid, process.pid);
  assert.equal(preparing.runs.length, 0);
  await assert.rejects(f.runner.run(input), /preparing/);
  assert.equal(lookups, 1);
  release();
  const admitted = await delivery;
  assert.equal(f.runner.requestStatus({ requestId: 'pending' }).requests[0].runId, admitted.id);
  assert.equal(f.submits(), 1);
});

test('lost admission response is recovered by the same ID, including reordered input, without scheduling again', async t => {
  const f = await fixture(t);
  const run = await f.runner.run({ repository: f.root, requestId: 'repeat', expectedHead: head });
  f.store.putQaRun({ ...run, state: 'passed', exitCode: 0, finishedAt: new Date().toISOString() });
  const recovered = await f.runner.run({ expectedHead: head, requestId: 'repeat', repository: f.root });
  assert.equal(recovered.id, run.id);
  assert.equal(recovered.state, 'passed');
  assert.equal(f.submits(), 1);
  await assert.rejects(f.runner.run({ repository: 'other/repo', requestId: 'repeat' }), /different input/);
  const status = f.runner.requestStatus({ requestId: 'repeat' });
  assert.equal(status.runs[0].id, run.id);
  projectQaRequestStatus.output.parse(status);
});

test('pre-admission refusal is durable and the same ID never starts a replacement', async t => {
  const f = await fixture(t);
  f.internal.integrationHead = async () => { throw new Error('fetch failed'); };
  await assert.rejects(f.runner.run({ repository: f.root, requestId: 'refused' }), /fetch failed/);
  f.internal.integrationHead = async () => head;
  await assert.rejects(f.runner.run({ repository: f.root, requestId: 'refused' }), /refused/);
  assert.equal(f.runner.requestStatus({ requestId: 'refused' }).requests[0].diagnostic, 'fetch failed');
  assert.equal(f.submits(), 0);
});

test('expected head refuses fetched mismatch and an existing milestone at a different head', async t => {
  const f = await fixture(t);
  await assert.rejects(f.runner.run({ repository: f.root, requestId: 'wrong-fetch', expectedHead: '2'.repeat(40) }), /integration head differs/);
  const first = await f.runner.run({ repository: f.root, requestId: 'first', expectedHead: head });
  f.internal.integrationHead = async () => '2'.repeat(40);
  await assert.rejects(f.runner.run({ repository: f.root, requestId: 'wrong-active', expectedHead: '2'.repeat(40) }), /Existing QA run/);
  assert.equal(f.store.latestQaRun('fixture')?.id, first.id);
  assert.equal(f.submits(), 1);
});

test('admission and request link commit atomically; scheduler error cannot relabel admission', async t => {
  const f = await fixture(t);
  const setMeta = f.store.setMeta.bind(f.store);
  f.store.setMeta = (key, value) => {
    if (key === 'projectQaRequest:rollback' && (value as any).state === 'admitted') throw new Error('link write failed');
    return setMeta(key, value);
  };
  await assert.rejects(f.runner.run({ repository: f.root, requestId: 'rollback' }), /link write failed/);
  assert.equal(f.store.latestQaRun('fixture'), null);
  assert.equal(f.runner.requestStatus({ requestId: 'rollback' }).requests[0].state, 'refused');
  f.store.setMeta = setMeta;
  f.internal.submitToHostScheduler = () => { throw new Error('scheduler response lost'); };
  await assert.rejects(f.runner.run({ repository: f.root, requestId: 'admitted' }), /scheduler response lost/);
  assert.equal(f.runner.requestStatus({ requestId: 'admitted' }).requests[0].state, 'admitted');
  const recovered = await f.runner.run({ repository: f.root, requestId: 'admitted' });
  assert.equal(recovered.id, f.store.latestQaRun('fixture')?.id);
});

test('read-only status retains interrupted owner identity and all exact-head history, not just latest', async t => {
  const f = await fixture(t);
  const run = await f.runner.run({ repository: f.root, requestId: 'history' });
  f.store.putQaRun({ ...run, state: 'passed', exitCode: 0, finishedAt: new Date().toISOString() });
  f.internal.integrationHead = async () => '2'.repeat(40);
  await f.runner.run({ repository: f.root, requestId: 'new-head' });
  const originalOwner = randomUUID();
  f.store.setMeta('projectQaRequest:interrupted', { id: 'interrupted', input: projectQaRunInputSchema.parse({ repository: f.root, requestId: 'interrupted' }),
    ownerInstance: originalOwner, ownerPid: 12345, receivedAt: new Date().toISOString(), state: 'preparing', runId: null, diagnostic: '' });
  const revision = f.store.getMeta('revision');
  const status = f.runner.requestStatus({ repository: f.root, since: '2020-01-01T00:00:00.000Z', expectedHead: head });
  assert.deepEqual(status.runs.map(row => row.id), [run.id]);
  assert.equal(status.requests.find(row => row.id === 'interrupted')?.ownerInstance, originalOwner);
  assert.equal(f.store.getMeta('revision'), revision);
  await assert.rejects(f.runner.run({ repository: f.root, requestId: 'interrupted' }), /preparing/);
  assert.equal(f.submits(), 2);
  assert.equal(f.runner.requestStatus({ requestId: 'unknown' }).requests.length, 0);
});

test('scheduled admission guard runs after awaited Git proof and before atomic claim', async t => {
  const f = await fixture(t);
  let allow = true, release!: () => void;
  f.internal.integrationHead = async () => { await new Promise<void>(r => { release = r; }); return head; };
  const pending = f.runner.run({ repository: f.root, requestId: 'scheduled-guard' }, () => {
    if (!allow) throw Error('schedule disabled');
  });
  while (!release) await new Promise(r => setImmediate(r));
  allow = false; release();
  await assert.rejects(pending, /schedule disabled/);
  assert.equal(f.submits(), 0);
  assert.equal(f.runner.requestStatus({ requestId: 'scheduled-guard' }).requests[0].state, 'refused');
  assert.equal(f.store.latestQaRuns().length, 0);
});


test('QA records new placement and admits an older recorded checkout independently', async t => {
  const f = await fixture(t);
  const newer = join(f.root, 'Stash', 'queue'), older = join(f.root, 'Builds', 'queue');
  let available = newer;
  f.internal.options.testPlacement = { dataDir: newer, retainedDataDirs: [older], admit: (path: string) => {
    if (!path.startsWith(`${available}/`)) throw Error('volume unavailable');
  } };
  const run = await f.runner.run({ repository: f.root, requestId: 'placement', expectedHead: head });
  assert.ok(run.checkoutPath?.startsWith(`${newer}/project-qa/`));
  const key = createHash('sha256').update(run.submittedKey ?? run.key).digest('hex').slice(0, 24);
  const retained = { ...run, checkoutPath: join(older, 'project-qa', key, run.id) };
  assert.throws(() => f.internal.admitCheckout(retained), /volume unavailable/);
  available = older;
  assert.doesNotThrow(() => f.internal.admitCheckout(retained));
  assert.throws(() => f.internal.admitCheckout(run), /volume unavailable/);
  assert.equal(f.internal.checkoutForRun(retained), retained.checkoutPath);
});

for (const state of ['passed', 'failed', 'cancelled', 'hold', 'timed_out', 'lost'] as const) {
  test(`wait returns the same admitted run after ${state}, with exit code and failure evidence`, async t => {
    const f = await fixture(t);
    const run = await f.runner.run({ repository: f.root, requestId: 'wait' });
    f.runner.get = async ({ id }: any) => f.store.qaRun(id);
    const failuresLog = state === 'failed' ? 'not ok 1 - fixture failed\n  error: expected green\n' : '';
    const failureIndexes = state === 'failed' ? [{ stage: 'qa', tests: 1, failed: 1, cancelled: 0, skipped: 0,
      identities: [{ id: 1, title: 'fixture failed', location: null, status: 'failed' as const }],
      omittedIdentities: 0, truncated: false, diagnosticsTruncated: false }] : [];
    let returned = false;
    const waiting = f.runner.run({ repository: f.root, requestId: 'wait', wait: true }).then(result => { returned = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(returned, false, 'queued is not settled');
    f.store.putQaRun({ ...run, state: 'running' });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(returned, false, 'running is not settled');
    f.store.putQaRun({ ...run, state, exitCode: state === 'passed' ? 0 : 1, finishedAt: new Date().toISOString(), failuresLog, failureIndexes });
    const result = await waiting;
    assert.equal(result.id, run.id);
    assert.equal(result.state, state);
    assert.equal(result.exitCode, state === 'passed' ? 0 : 1);
    assert.deepEqual(result.failureIndexes, failureIndexes);
    if (failuresLog) {
      assert.equal(await readFile(result.failuresLogPath!, 'utf8'), failuresLog);
      assert.equal((await stat(result.failuresLogPath!)).mode & 0o777, 0o600);
    } else assert.equal(result.failuresLogPath, null);
    assert.equal(f.submits(), 1, 'changing wait never changes admission identity or submits a replacement');
  });
}

test('wait is optional and strict; it is a response preference, not persisted request input', async t => {
  const f = await fixture(t);
  const run = await f.runner.run({ repository: f.root, requestId: 'no-wait', wait: false });
  assert.equal(run.state, 'queued');
  assert.equal('wait' in f.runner.requestStatus({ requestId: 'no-wait' }).requests[0].input, false);
  assert.equal(projectQaRunInputSchema.safeParse({ repository: f.root, wait: 'yes' }).success, false);
});
