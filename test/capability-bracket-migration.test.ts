import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store/store';
import { CAPABILITY_BRACKET_MIGRATION_KEY } from '../core/store/store-migration';
import type { CapabilityBracketMigration } from '../core/store/capability-bracket-migration';
import { poolSchema, profileCapabilitySchema } from '../shared/contracts';
import { submission } from './support/fakes';

/**
 * nucleus#1385 (Tom, 2026-11-19): profile capability moves from five points to
 * four brackets. The live pool's ratings, with synthesised IDs, as stored
 * before the move: two `low`, three `medium`, one `high`, two `very_high` and
 * one `frontier`, plus one value no table knows.
 */
const legacyPool = [
  { profileId: 'synthetic-luna', capability: 'low' },
  { profileId: 'synthetic-muse', capability: 'low' },
  { profileId: 'synthetic-haiku', capability: 'medium' },
  { profileId: 'synthetic-grok', capability: 'medium' },
  { profileId: 'synthetic-deepseek', capability: 'medium' },
  { profileId: 'synthetic-terra', capability: 'high' },
  { profileId: 'synthetic-sol', capability: 'very_high' },
  { profileId: 'synthetic-sonnet', capability: 'very_high' },
  { profileId: 'synthetic-opus', capability: 'frontier' },
  { profileId: 'synthetic-unrated' },
  { profileId: 'synthetic-odd', capability: 'ultra' },
].map(entry => ({ enabled: true, group: entry.profileId, weight: 1, cost: 'medium', ...entry }));

const EXPECTED: Record<string, string | undefined> = {
  'synthetic-luna': 'mechanical', 'synthetic-muse': 'mechanical',
  'synthetic-haiku': 'worker', 'synthetic-grok': 'worker', 'synthetic-deepseek': 'worker', 'synthetic-terra': 'worker',
  'synthetic-sol': 'heavyweight', 'synthetic-sonnet': 'heavyweight',
  'synthetic-opus': 'frontier', 'synthetic-unrated': undefined, 'synthetic-odd': 'ultra',
};

test('1385: stored ratings, climbs and role offsets move to brackets once, and a second open changes nothing', () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ns-bracket-migration-'));
  try {
    const path = join(dir, 'queue.sqlite');
    const seed = new Store(path);
    const task = seed.insert(submission({ repoPath: dir }), 'host', 'handoff', 'a'.repeat(40));
    seed.close();
    // What an older build left behind, written underneath the current schema.
    const legacy = new Store(path);
    legacy.setMeta('pool', legacyPool);
    legacy.setMeta('demandRoleOffsets', { worker: 1, reviewer: -1, coordinator: -2 });
    legacy.db.prepare("UPDATE tasks SET data=json_set(data,'$.resolution.workerClimb',json(?)) WHERE id=?")
      .run(JSON.stringify({ reviewRunId: 'review-1', from: 'medium', to: 'very_high', profileId: 'synthetic-sol', at: '2026-11-18T00:00:00.000Z' }), task.id);
    legacy.deleteMeta(CAPABILITY_BRACKET_MIGRATION_KEY);
    legacy.close();

    const opened = new Store(path);
    let record: CapabilityBracketMigration;
    let poolAfter: unknown;
    let taskAfter: string;
    try {
      const stored = opened.getMeta<Array<{ profileId: string; capability?: string }>>('pool')!;
      for (const entry of stored) assert.equal(entry.capability, EXPECTED[entry.profileId], entry.profileId);
      assert.equal(opened.getMeta('demandRoleOffsets'), undefined, 'the retired offsets are dropped');
      const climb = opened.task(task.id).resolution.workerClimb!;
      assert.deepEqual([climb.from, climb.to], ['worker', 'heavyweight']);
      record = opened.getMeta<CapabilityBracketMigration>(CAPABILITY_BRACKET_MIGRATION_KEY)!;
      assert.deepEqual(record.droppedDemandRoleOffsets, { worker: 1, reviewer: -1, coordinator: -2 }, 'the dropped offsets are noted');
      assert.deepEqual(record.unknown, [{ id: 'synthetic-odd', field: 'capability', value: 'ultra' }], 'an unrecognised value is listed and left as stored');
      assert.equal(record.changes.length, 8 + 2, 'eight ratings and both climb fields moved');
      assert.ok(record.changes.some(change => change.id === task.id && change.field === 'resolution.workerClimb.to' && change.to === 'heavyweight'));
      poolAfter = opened.getMeta('pool');
      taskAfter = opened.db.prepare('SELECT data FROM tasks WHERE id=?').get(task.id)!.data as string;
    } finally { opened.close(); }

    const again = new Store(path);
    try {
      assert.deepEqual(again.getMeta('pool'), poolAfter, 'a second run leaves the pool as it was');
      assert.equal(again.db.prepare('SELECT data FROM tasks WHERE id=?').get(task.id)!.data, taskAfter, 'and the task row');
      assert.deepEqual(again.getMeta(CAPABILITY_BRACKET_MIGRATION_KEY), record, 'and writes no new record');
    } finally { again.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('1385: an unknown value written after the first run is listed on the next open, and the same set is not rewritten', () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ns-bracket-unknown-'));
  try {
    const path = join(dir, 'queue.sqlite');
    const first = new Store(path);
    const clean = first.getMeta<CapabilityBracketMigration>(CAPABILITY_BRACKET_MIGRATION_KEY)!;
    assert.deepEqual(clean.unknown, [], 'a fresh store records an empty first run');
    first.setMeta('pool', [{ profileId: 'synthetic-odd', enabled: true, group: 'g', weight: 1, scopes: ['general'], capability: 'ultra' }]);
    first.close();
    const second = new Store(path);
    let record: CapabilityBracketMigration;
    try {
      record = second.getMeta<CapabilityBracketMigration>(CAPABILITY_BRACKET_MIGRATION_KEY)!;
      assert.deepEqual(record.unknown, [{ id: 'synthetic-odd', field: 'capability', value: 'ultra' }]);
      assert.equal(second.getMeta<Array<{ capability: string }>>('pool')![0]!.capability, 'ultra', 'left as stored');
    } finally { second.close(); }
    const third = new Store(path);
    try {
      assert.deepEqual(third.getMeta(CAPABILITY_BRACKET_MIGRATION_KEY), record, 'the same unknowns rewrite nothing');
    } finally { third.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('1385: a later scan keeps the dropped offsets and earlier conversions in the record', () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ns-bracket-later-'));
  try {
    const path = join(dir, 'queue.sqlite');
    const seed = new Store(path);
    seed.deleteMeta(CAPABILITY_BRACKET_MIGRATION_KEY);
    seed.setMeta('demandRoleOffsets', { worker: 0, reviewer: 0, coordinator: -2 });
    seed.setMeta('pool', [{ profileId: 'synthetic-haiku', enabled: true, group: 'g', weight: 1, scopes: ['general'], capability: 'medium' }]);
    seed.close();
    const first = new Store(path);
    first.close();
    // A stale writer adds an unknown value, then another five-point rating.
    const stale = new Store(path);
    stale.setMeta('pool', [...stale.getMeta<unknown[]>('pool')!, { profileId: 'synthetic-odd', enabled: true, group: 'g', weight: 1, scopes: ['general'], capability: 'ultra' }]);
    stale.close();
    const second = new Store(path);
    second.setMeta('pool', [...second.getMeta<unknown[]>('pool')!, { profileId: 'synthetic-sol', enabled: true, group: 'g', weight: 1, scopes: ['general'], capability: 'very_high' }]);
    second.close();
    const third = new Store(path);
    try {
      const record = third.getMeta<CapabilityBracketMigration>(CAPABILITY_BRACKET_MIGRATION_KEY)!;
      assert.deepEqual(record.droppedDemandRoleOffsets, { worker: 0, reviewer: 0, coordinator: -2 }, 'the dropped offsets survive later scans');
      assert.deepEqual(record.changes.map(change => change.id), ['synthetic-haiku', 'synthetic-sol'], 'earlier conversions stay listed');
      assert.deepEqual(record.unknown, [{ id: 'synthetic-odd', field: 'capability', value: 'ultra' }]);
    } finally { third.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('1385: a stale writer\'s five-point rating reads as its bracket at the wire boundary', () => {
  for (const [from, to] of [['very_low', 'mechanical'], ['low', 'mechanical'], ['medium', 'worker'], ['high', 'worker'], ['very_high', 'heavyweight'], ['frontier', 'frontier']])
    assert.equal(profileCapabilitySchema.parse(from), to, from);
  const entry = poolSchema.parse({ profileId: 'p', enabled: true, group: 'g', weight: 1, scopes: ['general'], capability: 'high' });
  assert.equal(entry.capability, 'worker');
});
