import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestKeyConflictError, REQUEST_LEDGER_LIMIT, REQUEST_LEDGER_META_KEY, REQUEST_LEDGER_RESULT_LIMIT_BYTES, RequestLedger } from '../core/runtime/request-ledger';
import { Store } from '../core/store/store';

/**
 * Request ledger (service-boundary contract, "Rolls: calls wait out the
 * replacement"). These are the store proofs: what one keyed mutation journals,
 * what a settled key replays, how a key reuse refuses, and how the journal
 * stays bounded and parsable. The transport recovery that reads it is proven
 * over the real socket in `test/roll-call-recovery.test.ts` and across a real
 * two-build roll in `test/service-roll.test.ts`.
 */
const AT = '2026-11-09T13:47:00.000Z';

function ledgerFixture(t: { after(fn: () => void): void }, path?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'nsq-request-ledger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(path ?? join(dir, 'queue.sqlite'));
  t.after(() => store.close());
  return { dir, store, ledger: new RequestLedger(store, { clock: () => AT }) };
}

const MUTATING = { name: 'papercut.add', mutating: true } as const;
const READING = { name: 'papercut.list', mutating: false } as const;

test('a keyed mutation journals received before the handler and its settled outcome after', t => {
  const { store, ledger } = ledgerFixture(t);
  assert.equal(ledger.watches(MUTATING.name), true, 'mutating catalogue calls are journaled');
  assert.equal(ledger.watches(READING.name), false, 'reads are never journaled');
  assert.deepEqual(ledger.outcome('k1'), { status: 'not_received' }, 'nothing is recorded before the first keyed request');

  const opened = ledger.open('k1', MUTATING.name, { title: 'Fixture' });
  assert.deepEqual(opened, { fresh: true });
  assert.deepEqual(ledger.outcome('k1'), { status: 'pending' }, 'the received record is visible before the handler settles');

  ledger.settle('k1', { id: 'pc1', title: 'Fixture' });
  assert.deepEqual(ledger.outcome('k1'), { status: 'applied', result: { id: 'pc1', title: 'Fixture' } });

  const refused = ledgerFixture(t).ledger;
  refused.open('k2', MUTATING.name, { title: 'Fixture' });
  refused.settleRefused('k2', 'refused', 'Task changed; refresh before retrying');
  assert.deepEqual(refused.outcome('k2'), { status: 'refused', code: 'refused', message: 'Task changed; refresh before retrying' });
  assert.equal(store.getMeta<Array<unknown>>(REQUEST_LEDGER_META_KEY)?.length, 1, 'each fixture keeps its own journal');
});

test('a settled key replays its recorded outcome and never runs the handler again', t => {
  const { ledger } = ledgerFixture(t);
  const input = { title: 'Fixture', happened: 'today', impact: 'test' };
  assert.deepEqual(ledger.open('k1', MUTATING.name, input), { fresh: true });
  ledger.settle('k1', { id: 'pc1' });
  // The replay is the recorded answer, not a fresh execution: the client can
  // resend the same exact request and the effect stays exactly-once.
  const again = ledger.open('k1', MUTATING.name, input);
  assert.deepEqual('replay' in again ? again.replay : again, { status: 'applied', result: { id: 'pc1' } });
});

test('a key reused with a different method or input refuses', t => {
  const { ledger } = ledgerFixture(t);
  ledger.open('k1', MUTATING.name, { title: 'Fixture' });
  ledger.settle('k1', { id: 'pc1' });
  assert.throws(() => ledger.open('k1', READING.name, { title: 'Fixture' }), (error: unknown) =>
    error instanceof RequestKeyConflictError && error.code === 'refused' && /already used for papercut\.add/.test(error.message));
  assert.throws(() => ledger.open('k1', MUTATING.name, { title: 'Different' }), (error: unknown) =>
    error instanceof RequestKeyConflictError && error.code === 'refused' && /different input/.test(error.message));
});

test('a key still being served refuses with busy until its outcome lands', t => {
  const { ledger } = ledgerFixture(t);
  ledger.open('k1', MUTATING.name, { title: 'Fixture' });
  assert.throws(() => ledger.open('k1', MUTATING.name, { title: 'Fixture' }), (error: unknown) =>
    error instanceof RequestKeyConflictError && error.code === 'busy' && /still being served/.test(error.message));
  ledger.settle('k1', { id: 'pc1' });
  assert.doesNotThrow(() => ledger.open('k1', MUTATING.name, { title: 'Fixture' }));
});

test('a result too large to carry across the roll records applied without a replayable result', t => {
  const { ledger } = ledgerFixture(t);
  ledger.open('k1', MUTATING.name, {});
  const large = { blob: 'x'.repeat(REQUEST_LEDGER_RESULT_LIMIT_BYTES + 1) };
  ledger.settle('k1', large);
  assert.deepEqual(ledger.outcome('k1'), { status: 'applied', truncated: true });
});

test('a refusal message is bounded, and a damaged journal entry is dropped rather than fatal', t => {
  const { ledger } = ledgerFixture(t);
  ledger.open('k1', MUTATING.name, {});
  ledger.settleRefused('k1', 'internal', 'x'.repeat(5_000));
  const outcome = ledger.outcome('k1');
  assert.equal(outcome.status, 'refused');
  if (outcome.status === 'refused') assert.ok(outcome.message.length <= 2_000, 'the recorded message stays bounded');

  const { store } = ledgerFixture(t);
  store.setMeta(REQUEST_LEDGER_META_KEY, [{ key: 'good', method: MUTATING.name, inputHash: 'h', at: AT, state: 'applied', result: 1 }, 'junk', null, 42, { broken: true }]);
  const damaged = new RequestLedger(store);
  assert.deepEqual(damaged.outcome('good'), { status: 'applied', result: 1 }, 'a parsable entry survives its damaged neighbours');
  assert.deepEqual(damaged.outcome('junk'), { status: 'not_received' });
});

test('the journal stays bounded and the oldest entries fall off', t => {
  const { ledger } = ledgerFixture(t);
  for (let i = 0; i < REQUEST_LEDGER_LIMIT + 5; i++) {
    ledger.open(`k${i}`, MUTATING.name, { i });
    ledger.settle(`k${i}`, { i });
  }
  assert.equal(ledger.outcome('k0').status, 'not_received', 'the oldest entry was pruned');
  assert.equal(ledger.outcome(`k${REQUEST_LEDGER_LIMIT + 4}`).status, 'applied', 'the newest entry survives');
});

test('the journal survives a service replacement on the same store', t => {
  const dir = mkdtempSync(join(tmpdir(), 'nsq-request-ledger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'queue.sqlite');
  const first = ledgerFixture(t, path);
  first.ledger.open('k1', MUTATING.name, { title: 'Fixture' });
  first.ledger.settle('k1', { id: 'pc1' });
  // The replacement opens the same store while the old owner still holds it:
  // the recorded outcome answers across the roll, which is the whole point.
  const replacement = new Store(path);
  t.after(() => replacement.close());
  const outcome = new RequestLedger(replacement).outcome('k1');
  assert.deepEqual(outcome, { status: 'applied', result: { id: 'pc1' } });
});
