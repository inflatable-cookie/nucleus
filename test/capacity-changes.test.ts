import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAPACITY_CHANGE_LOG_LIMIT,
  DEFAULT_GLOBAL_LIMIT, DEFAULT_HOLD_ESCALATION_MINUTES, DEFAULT_HOLD_REMINDER_MINUTES,
  DEFAULT_LANE_DRAIN_ESCALATION_MINUTES, DEFAULT_LANE_DRAIN_MINUTES, DEFAULT_PAPERCUT_PROJECT_LIMIT,
  DEFAULT_PASEO_CALL_LIMIT, DEFAULT_PROJECT_LIMIT, DEFAULT_STALL_THRESHOLD_MINUTES, DEFAULT_HOST_OUTAGE_NOTICE_MINUTES,
  capacityChangeSchema, capacitySchema,
} from '../shared/contracts';
import {
  CAPACITY_AUTHORITY_KEYS, CAPACITY_CHANGE_LOG_META_KEY, CapacityChangeJournal, capacityAuthorityEffective,
} from '../core/dispatch/capacity-changes';
import { Store } from '../core/store/store';

/**
 * Settings-only capacity writes (service-boundary contract). These are the store
 * proofs for the applied-change record: what one write commits, what a no-op
 * leaves alone, what a fault rolls back and how the record stays bounded and
 * parsable. The refusal of every other surface belongs to the dispatch point and
 * is proven over the real socket in `test/service.cases.ts`.
 */
const AT = '2026-10-25T09:00:00.000Z';
const DEFAULTS = {
  globalLimit: DEFAULT_GLOBAL_LIMIT, projectLimit: DEFAULT_PROJECT_LIMIT,
  papercutProjectLimit: DEFAULT_PAPERCUT_PROJECT_LIMIT, paseoCallLimit: DEFAULT_PASEO_CALL_LIMIT,
  stallThresholdMinutes: DEFAULT_STALL_THRESHOLD_MINUTES, holdReminderMinutes: DEFAULT_HOLD_REMINDER_MINUTES,
  holdEscalationMinutes: DEFAULT_HOLD_ESCALATION_MINUTES, laneDrainMinutes: DEFAULT_LANE_DRAIN_MINUTES,
  laneDrainEscalationMinutes: DEFAULT_LANE_DRAIN_ESCALATION_MINUTES,
  hostOutageNoticeMinutes: DEFAULT_HOST_OUTAGE_NOTICE_MINUTES,
};

function storeFixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'nsq-capacity-changes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'queue.sqlite'));
  t.after(() => store.close());
  return { dir, store, journal: new CapacityChangeJournal(store, { clock: () => AT }) };
}

test('a Settings write commits the whole state in force and records the full before and after', t => {
  const { store, journal } = storeFixture(t);
  assert.deepEqual(capacityAuthorityEffective(store), DEFAULTS, 'a store that never set a limit starts from the live defaults');
  assert.deepEqual(journal.state(), { effective: DEFAULTS, changes: [] }, 'nothing is recorded before the first change');

  // An omitted field is not a reset: the caller writes the limit it knows about.
  const result = journal.apply({ globalLimit: 21, projectLimit: 4 });
  assert.deepEqual({ ...result }, { changed: true, version: 1, fields: ['globalLimit', 'projectLimit'] });
  for (const key of CAPACITY_AUTHORITY_KEYS) assert.equal(store.getMeta(key), key === 'globalLimit' ? 21 : key === 'projectLimit' ? 4 : DEFAULTS[key], key);

  const state = journal.state();
  assert.deepEqual(state.effective, { ...DEFAULTS, globalLimit: 21, projectLimit: 4 });
  assert.equal(state.changes.length, 1);
  const change = state.changes[0]!;
  assert.equal(change.version, 1);
  assert.equal(change.at, AT, 'the record carries the time the change was applied');
  assert.equal(change.surface, 'paseo', 'the transport surface is recorded, never a field from the body');
  assert.deepEqual(change.before, DEFAULTS, 'the before state is the whole state the change replaced');
  assert.deepEqual(change.after, state.effective, 'the after state is the whole state it put in force');
  assert.equal(capacityChangeSchema.safeParse(change).success, true);

  // The board revision moves with the change, so every projection re-reads it.
  const revision = store.telemetryRevision();
  journal.apply({ globalLimit: 22 });
  assert.ok(store.telemetryRevision() > revision);
  assert.equal(journal.state().changes[1]!.version, 2, 'versions count changes, not writes');
});

test('saving the values already in force is a no-op: no record, no version and no revision', t => {
  const { store, journal } = storeFixture(t);
  journal.apply({ globalLimit: 21, projectLimit: 4 });
  const revision = store.telemetryRevision();
  // The exact state again, and a subset of it, are both no-ops.
  assert.deepEqual({ ...journal.apply({ globalLimit: 21, projectLimit: 4 }) }, { changed: false, version: null, fields: [] });
  assert.deepEqual({ ...journal.apply({ globalLimit: 21 }) }, { changed: false, version: null, fields: [] });
  assert.equal(journal.state().changes.length, 1, 'a no-op records nothing');
  assert.equal(store.telemetryRevision(), revision, 'a no-op advances no revision');
});

test('the limits and their record commit together: a fault rolls both back', t => {
  const { store, journal } = storeFixture(t);
  journal.apply({ globalLimit: 21 });
  const before = journal.state();
  const revision = store.telemetryRevision();
  // Fail the last capacity key of the write: the earlier keys are already written
  // in that transaction, so only the transaction can take them back.
  const original = store.setMeta.bind(store);
  store.setMeta = (key: string, value: unknown) => {
    if (key === 'laneDrainEscalationMinutes') throw new Error('injected store fault');
    return original(key, value);
  };
  assert.throws(() => journal.apply({ globalLimit: 30, laneDrainEscalationMinutes: 60 }), /injected store fault/);
  store.setMeta = original;
  assert.deepEqual(journal.state(), before, 'neither the limits nor the record changed');
  assert.equal(store.telemetryRevision(), revision);
  // The same write succeeds once the fault is gone, so the rollback left nothing behind.
  assert.equal(journal.apply({ globalLimit: 30, laneDrainEscalationMinutes: 60 }).changed, true);
  assert.equal(journal.state().changes.length, 2);
});

test('the record is bounded and versions keep counting past the bound', t => {
  const { journal } = storeFixture(t);
  for (let index = 1; index <= CAPACITY_CHANGE_LOG_LIMIT + 3; index++) journal.apply({ globalLimit: 20 + index });
  const { changes } = journal.state();
  assert.equal(changes.length, CAPACITY_CHANGE_LOG_LIMIT, 'the record keeps a bounded window');
  assert.equal(changes.at(-1)!.version, CAPACITY_CHANGE_LOG_LIMIT + 3, 'the version keeps counting from the last change');
  assert.equal(changes[0]!.version, 4, 'the oldest entries drop off the front');
  for (const change of changes) assert.equal(capacityChangeSchema.safeParse(change).success, true);
});

test('a damaged record entry is dropped instead of breaking the read or the next write', t => {
  const { store, journal } = storeFixture(t);
  journal.apply({ globalLimit: 21 });
  store.setMeta(CAPACITY_CHANGE_LOG_META_KEY, [{ nonsense: true }, ...journal.state().changes]);
  assert.equal(journal.state().changes.length, 1, 'the parsable entry still reads');
  assert.equal(journal.apply({ globalLimit: 22 }).version, 2, 'the next write versions from the readable record');
  store.setMeta(CAPACITY_CHANGE_LOG_META_KEY, 'not a list');
  assert.deepEqual(journal.state().changes, []);
});

test('the capacity body refuses a surface or an actor field: provenance never comes from the caller', t => {
  for (const forged of [
    { globalLimit: 21, surface: 'paseo' },
    { globalLimit: 21, via: 'paseo' },
    { globalLimit: 21, authority: 'operator' },
    { globalLimit: 21, caller: 'operator (board)' },
    { globalLimit: 21, relayed: true, approver: 'operator' },
  ]) assert.equal(capacitySchema.safeParse(forged).success, false, JSON.stringify(forged));
  // A limit outside the schema's bounds is refused before the journal sees it.
  const { journal } = storeFixture(t);
  assert.throws(() => journal.apply({ globalLimit: 0 }), /too_small/);
  assert.throws(() => journal.apply({ stallThresholdMinutes: 241 }), /too_big/);
  assert.deepEqual(journal.state().changes, [], 'a refused input records nothing');
});
