import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Admission, admitAdapter, type AdmissionOptions } from '../core/host/admission';
import { paseoCall } from '../shared/host-call-timing';
import { HostCallAbandonedError, HostUnknownDeliveryError } from '../core/host/errors';
import type { Adapter } from '../core/host/adapter';

/**
 * Every held host-call slot has a deadline and an owner (nucleus#1179).
 *
 * A Paseo call that never returns used to hold its admission slot for the
 * lifetime of the process: the class bound never moved, the breaker never
 * recovered, and nothing named the call. Now the call is abandoned as unknown at
 * its deadline, its slot is freed, and health names the holder and its age both
 * while it waits and after it is abandoned. The call is never resent.
 */

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const never = () => new Promise<never>(() => {});

function admissionWith(options: AdmissionOptions = {}) {
  const lines: string[] = [];
  const admission = new Admission({ startIntervalMs: 0, log: line => lines.push(line), ...options });
  return { admission, lines };
}

test('a host call past its deadline is abandoned as unknown and its slot is freed', async () => {
  const { admission, lines } = admissionWith({ callDeadlineMs: 400, heldSlotWarnMs: 20 });
  let attempts = 0;
  const abandoned = admission.run('inventory', () => { attempts++; return never(); }, 'catalog:fixture', { holder: 'catalog fixture' })
    .then(() => assert.fail('the call must not answer'), error => error);

  await sleep(60);
  const held = admission.snapshot();
  assert.equal(held.heldSlots.length, 1, 'the held slot is named while it holds');
  assert.deepEqual(
    { cls: held.heldSlots[0]!.cls, holder: held.heldSlots[0]!.holder, deadlineMs: held.heldSlots[0]!.deadlineMs },
    { cls: 'inventory', holder: 'catalog fixture', deadlineMs: 400 },
  );
  assert.ok(held.heldSlots[0]!.ageMs >= 20, `the held slot reports its age (${held.heldSlots[0]!.ageMs} ms)`);
  assert.equal(held.inventory.running, 1, 'it holds its class slot while it waits');

  const error = await abandoned;
  assert.ok(error instanceof HostCallAbandonedError, `the caller hears the abandonment, not a plain failure (${error})`);
  assert.ok(error instanceof HostUnknownDeliveryError, 'an abandoned call is an unknown-delivery outcome, never a retry hint');
  assert.match(error.message, /not resent/);
  assert.match(error.message, /unknown/);

  const settled = admission.snapshot();
  assert.deepEqual(settled.heldSlots, [], 'the slot is no longer named as held');
  assert.equal(settled.inventory.running, 0, 'the abandoned call freed its class slot');
  assert.equal(settled.abandoned.count, 1);
  assert.equal(settled.abandoned.last?.holder, 'catalog fixture');
  assert.equal(settled.abandoned.last?.ageMs >= 400, true, `the abandonment records the age it reached (${settled.abandoned.last?.ageMs} ms)`);
  assert.equal(attempts, 1, 'the abandoned call was never resent');
  assert.ok(lines.some(line => line.includes('catalog fixture') && line.includes('abandoned as unknown')), `the service log names the abandonment: ${lines.join(' | ')}`);

  // The freed slot is genuinely reusable: the next call of the class runs.
  const answer = await admission.run('inventory', async () => 'fresh', 'catalog:after');
  assert.equal(answer, 'fresh');
  assert.equal(admission.snapshot().inventory.running, 0);
});

test('an effect that legitimately runs for minutes keeps its slot under the long bound', async () => {
  const { admission, lines } = admissionWith({ callDeadlineMs: 30, longCallDeadlineMs: 4_000, heldSlotWarnMs: 10 });
  let release: (value: string) => void = () => {};
  const archive = admission.run('cleanup', () => new Promise<string>(resolve => { release = resolve; }), 'archiveWorkspace:fixture', { breakerExempt: true, longRunning: true });
  await sleep(80);
  const held = admission.snapshot();
  assert.equal(held.heldSlots.length, 1);
  assert.equal(held.heldSlots[0]!.cls, 'cleanup');
  assert.equal(held.heldSlots[0]!.deadlineMs, 4_000, 'a long effect reports its own deadline, never no deadline');
  assert.equal(held.abandoned.count, 0, 'a long effect past the ordinary bound is not abandoned at it');
  release('done');
  assert.equal(await archive, 'done');
  assert.equal(admission.snapshot().cleanup.running, 0);
  assert.equal(lines.filter(line => line.includes('abandoned as unknown')).length, 0);
});

test('a long effect is still abandoned at its own bound and frees its slot', async () => {
  const { admission } = admissionWith({ callDeadlineMs: 5_000, longCallDeadlineMs: 120, heldSlotWarnMs: 10 });
  const abandoned = admission.run('cleanup', never, 'archiveWorkspace:fixture', { breakerExempt: true, longRunning: true })
    .then(() => assert.fail('the long call must not answer'), error => error);
  await sleep(40);
  assert.equal(admission.snapshot().heldSlots[0]!.deadlineMs, 120, 'the long bound is named while it holds');
  const error = await abandoned;
  assert.ok(error instanceof HostCallAbandonedError);
  const settled = admission.snapshot();
  assert.equal(settled.cleanup.running, 0, 'the abandoned long call freed its cleanup slot');
  assert.equal(settled.abandoned.count, 1);
  assert.equal(settled.abandoned.last?.deadlineMs, 120);
});

test('a queued call logs who holds the slot and for how long', async () => {
  const { admission, lines } = admissionWith({ callDeadlineMs: 500, heldSlotWarnMs: 20 });
  const holder = admission.run('inventory', never, 'catalog:holder', { holder: 'catalog holder' }).catch(() => undefined);
  await sleep(40);
  const queued = await admission.run('inventory', async () => 'queued', 'catalog:queued').catch(error => error);
  assert.equal(queued, 'queued', 'the queued call runs once the holder is abandoned');
  await holder;
  const waitLine = lines.find(line => line.includes('waited'));
  assert.ok(waitLine, `a wait past the threshold is logged: ${lines.join(' | ')}`);
  assert.match(waitLine!, /catalog:queued/);
  assert.match(waitLine!, /oldest held slot: inventory catalog holder for \d+ ms/);
  assert.match(waitLine!, /deadline 500 ms/);
});

/**
 * The bound is per effect, never per class (review 5889669364).
 *
 * `archiveAgent` and `reconcileSettledThreads` share the cleanup class with the
 * minutes-long workspace archive; `recoverTaskWorkspace` and
 * `createCloseoutWorkspace` share the workspace class with creation. Only the
 * effects that legitimately run for minutes get the long bound; every other
 * effect in those classes is abandoned at the ordinary one, so a class can never
 * hold its slots without a deadline.
 */
function hangingAdapter(hang: ReadonlySet<string>): Adapter {
  const method = (name: string) => async (..._args: unknown[]) => {
    if (hang.has(name)) return new Promise<never>(() => {});
    return name.startsWith('archive') ? [] : { id: 'ws', directory: '/fixture/ws' };
  };
  const adapter = {
    archiveAgent: method('archiveAgent'),
    reconcileSettledThreads: method('reconcileSettledThreads'),
    recoverTaskWorkspace: method('recoverTaskWorkspace'),
    createCloseoutWorkspace: method('createCloseoutWorkspace'),
    createWorkspace: method('createWorkspace'),
    archiveTaskWorkspace: method('archiveTaskWorkspace'),
  };
  return adapter as unknown as Adapter;
}

test('cleanup-class callers that are not archives are abandoned at the ordinary bound', async () => {
  const { admission } = admissionWith({ callDeadlineMs: 80, longCallDeadlineMs: 5_000, heldSlotWarnMs: 10 });
  const wrapped = admitAdapter(hangingAdapter(new Set(['archiveAgent', 'reconcileSettledThreads'])), admission);
  const outcome = (call: Promise<unknown>) => call.then(() => assert.fail('the hung call must not answer'), error => error);
  // The cleanup class admits four; the fifth waits behind them.
  const held = [0, 1, 2, 3].map(index => outcome(wrapped.archiveAgent!(`agent-${index}`)));
  await sleep(20);
  const queued = outcome(wrapped.reconcileSettledThreads!());
  const results = await Promise.all([...held, queued]);
  for (const [index, error] of results.entries()) {
    assert.ok(error instanceof HostCallAbandonedError, `cleanup call ${index} hears the abandonment (${error})`);
    assert.equal((error as HostCallAbandonedError).deadlineMs, 80, 'every non-archive cleanup call keeps the ordinary bound');
  }
  const settled = admission.snapshot();
  assert.equal(settled.cleanup.running, 0, 'the cleanup slots are free again');
  assert.equal(settled.cleanup.waiting, 0, 'the queued fifth call was admitted and settled');
  assert.equal(settled.abandoned.count, 5);
});

test('workspace-class creation and recovery are abandoned at the long bound, and only archives get it', async () => {
  const { admission } = admissionWith({ callDeadlineMs: 80, longCallDeadlineMs: 300, heldSlotWarnMs: 10 });
  const wrapped = admitAdapter(hangingAdapter(new Set(['recoverTaskWorkspace', 'createCloseoutWorkspace', 'archiveTaskWorkspace'])), admission) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const outcome = (call: Promise<unknown>) => call.then(() => assert.fail('the hung call must not answer'), error => error);
  const task = { id: 'task-fixture', repoPath: '/fixture', branch: 'ns-branch' } as never;

  const recovery = outcome(wrapped.recoverTaskWorkspace!(task));
  await sleep(20);
  const closeout = outcome(wrapped.createCloseoutWorkspace!(task));
  await sleep(140);
  assert.equal(admission.snapshot().abandoned.count, 0, 'the long bound is not the ordinary bound');
  assert.equal(admission.snapshot().heldSlots[0]?.deadlineMs, 300, 'a workspace creation call reports the long deadline');

  const [recoveryError, closeoutError] = await Promise.all([recovery, closeout]);
  for (const error of [recoveryError, closeoutError]) {
    assert.ok(error instanceof HostCallAbandonedError, `the workspace call hears its abandonment (${error})`);
    assert.equal((error as HostCallAbandonedError).deadlineMs, 300);
  }
  const settled = admission.snapshot();
  assert.equal(settled.workspace.running, 0, 'the workspace slot is free again');
  assert.equal(settled.abandoned.count, 2);

  // A fresh effect of the same class runs in the freed slot.
  const free = admitAdapter(hangingAdapter(new Set()), admission);
  assert.deepEqual(await free.recoverTaskWorkspace!(task), { id: 'ws', directory: '/fixture/ws' });

  // The archive itself is the one effect allowed the long bound, and being
  // inner-timed it is still the named holder of its slot.
  const archive = outcome(wrapped.archiveTaskWorkspace!(task, 'ws-1', '/fixture/ws', 'a'.repeat(40), () => true, false));
  await sleep(20);
  assert.equal(admission.snapshot().heldSlots.find(slot => slot.holder.includes('archiveWorkspace'))?.deadlineMs, 300);
  assert.ok(await archive instanceof HostCallAbandonedError);
});

test('an abandoned inner-timed effect never issues another request outside admission', async () => {
  const { admission } = admissionWith({ callDeadlineMs: 80, longCallDeadlineMs: 80, heldSlotWarnMs: 10 });
  let sent = 0;
  let late: unknown;
  let finished = false;
  const work = async () => {
    // The first request is the one the effect's deadline outlives.
    await paseoCall(() => { sent++; return new Promise<never>(() => {}); }).catch(() => undefined);
    // The effect has been abandoned by now; a request it starts from here must be
    // refused, not sent after its slot is gone.
    await sleep(40);
    await paseoCall(() => { sent++; return Promise.resolve('sent'); }).catch(error => { late = error; });
    finished = true;
  };
  const effect = admission.run('cleanup', work, 'archiveWorkspace:fixture', { innerTiming: true, breakerExempt: true, longRunning: true, holder: 'archiveWorkspace fixture' })
    .then(() => assert.fail('the effect must be abandoned'), error => error);
  const error = await effect;
  assert.ok(error instanceof HostCallAbandonedError, `the effect is abandoned (${error})`);
  // The effect's own work keeps running after the abandonment; let it reach its
  // late request so the refusal is observed rather than asserted too early.
  for (let wait = 0; wait < 50 && !finished; wait++) await sleep(10);
  assert.equal(finished, true, "the effect's work reached its late request");
  assert.equal(sent, 1, 'only the request issued while the effect held its slot reached the host');
  assert.ok(late instanceof HostCallAbandonedError, `the later request is refused (${late})`);
  const settled = admission.snapshot();
  assert.equal(settled.cleanup.running, 0);
  assert.deepEqual(settled.heldSlots, []);
  assert.equal(settled.cleanup.completed, 1, 'the refused request was never admitted');
});

test('the observation pass gets the long bound while each page keeps the ordinary one', async () => {
  const { admission } = admissionWith({ callDeadlineMs: 50, longCallDeadlineMs: 400, heldSlotWarnMs: 10 });
  const pages: number[] = [];
  const work = async () => {
    // Three pages of 20 ms: the pass is past the ordinary bound and inside the long one.
    for (let page = 0; page < 3; page++) await paseoCall(async () => { pages.push(page); await sleep(20); return page; });
    // Then one page that never returns is abandoned at the ordinary bound.
    await paseoCall(() => new Promise<never>(() => {}));
  };
  const pass = admission.run('inventory', work, 'observationInventory', { innerTiming: true, longRunning: true, ordinaryInnerDeadlines: true, holder: 'observationInventory' })
    .then(() => assert.fail('the stuck page must abandon the pass'), error => error);
  await sleep(75);
  assert.equal(admission.snapshot().abandoned.count, 0, 'a pass past the ordinary bound is not abandoned at it');
  assert.equal(admission.snapshot().heldSlots[0]?.deadlineMs, 400, 'the pass reports the long bound');
  assert.equal(pages.length, 3, 'the accumulated pages ran');
  const error = await pass;
  assert.ok(error instanceof HostCallAbandonedError);
  assert.equal((error as HostCallAbandonedError).deadlineMs, 50, 'the stuck page kept the ordinary bound');
  const settled = admission.snapshot();
  assert.equal(settled.abandoned.count, 1);
  assert.equal(settled.inventory.running, 0, 'the abandoned pass freed its slot');
});
