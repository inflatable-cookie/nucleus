import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Admission, type AdmissionOptions } from '../core/host/admission';
import { HostCallAbandonedError, HostUnknownDeliveryError } from '../core/host/errors';

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
  const { admission, lines } = admissionWith({ callDeadlineMs: 80, heldSlotWarnMs: 20 });
  let attempts = 0;
  const abandoned = admission.run('inventory', () => { attempts++; return never(); }, 'catalog:fixture', { holder: 'catalog fixture' })
    .then(() => assert.fail('the call must not answer'), error => error);

  await sleep(35);
  const held = admission.snapshot();
  assert.equal(held.heldSlots.length, 1, 'the held slot is named while it holds');
  assert.deepEqual(
    { cls: held.heldSlots[0]!.cls, holder: held.heldSlots[0]!.holder, deadlineMs: held.heldSlots[0]!.deadlineMs },
    { cls: 'inventory', holder: 'catalog fixture', deadlineMs: 80 },
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
  assert.equal(settled.abandoned.last?.ageMs >= 80, true, `the abandonment records the age it reached (${settled.abandoned.last?.ageMs} ms)`);
  assert.equal(attempts, 1, 'the abandoned call was never resent');
  assert.ok(lines.some(line => line.includes('catalog fixture') && line.includes('abandoned as unknown')), `the service log names the abandonment: ${lines.join(' | ')}`);

  // The freed slot is genuinely reusable: the next call of the class runs.
  const answer = await admission.run('inventory', async () => 'fresh', 'catalog:after');
  assert.equal(answer, 'fresh');
  assert.equal(admission.snapshot().inventory.running, 0);
});

test('an effect that legitimately runs for minutes keeps its slot and is never abandoned', async () => {
  const { admission } = admissionWith({ callDeadlineMs: 30, heldSlotWarnMs: 10 });
  let release: (value: string) => void = () => {};
  const archive = admission.run('cleanup', () => new Promise<string>(resolve => { release = resolve; }), 'archiveWorkspace:fixture', { breakerExempt: true });
  await sleep(60);
  const held = admission.snapshot();
  assert.equal(held.heldSlots.length, 1);
  assert.equal(held.heldSlots[0]!.cls, 'cleanup');
  assert.equal(held.heldSlots[0]!.deadlineMs, null, 'an archive reports that it has no deadline');
  assert.equal(held.abandoned.count, 0, 'an archive is not abandoned');
  release('done');
  assert.equal(await archive, 'done');
  assert.equal(admission.snapshot().cleanup.running, 0);
});

test('a queued call logs who holds the slot and for how long', async () => {
  const { admission, lines } = admissionWith({ callDeadlineMs: 200, heldSlotWarnMs: 20 });
  const holder = admission.run('inventory', never, 'catalog:holder', { holder: 'catalog holder' }).catch(() => undefined);
  await sleep(40);
  const queued = await admission.run('inventory', async () => 'queued', 'catalog:queued').catch(error => error);
  assert.equal(queued, 'queued', 'the queued call runs once the holder is abandoned');
  await holder;
  const waitLine = lines.find(line => line.includes('waited'));
  assert.ok(waitLine, `a wait past the threshold is logged: ${lines.join(' | ')}`);
  assert.match(waitLine!, /catalog:queued/);
  assert.match(waitLine!, /oldest held slot: inventory catalog holder for \d+ ms/);
  assert.match(waitLine!, /deadline 200 ms/);
});
