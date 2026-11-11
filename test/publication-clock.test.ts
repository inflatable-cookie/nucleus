import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store, CURRENT_SCHEMA } from '../core/store/store';
import { createUiSnapshotFactsCache } from '../core/telemetry/ui-snapshot';

for (const schema of [55, 56]) test(`schema ${schema} publication counters migrate to one row without rewinding either revision`, () => {
  const path = join(mkdtempSync(join(tmpdir(), 'publication-clock-')), 'queue.sqlite');
  const initial = new Store(path); initial.close();
  const db = new DatabaseSync(path);
  db.exec("DELETE FROM projection_clock WHERE name='publication'; ALTER TABLE projection_clock DROP COLUMN board_version");
  db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run('boardRevision', '37');
  db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run('telemetryRevision', '41');
  db.prepare('UPDATE meta SET value=? WHERE key=?').run(String(schema), 'schema');
  db.close();
  const store = new Store(path);
  try {
    assert.equal(store.getMeta('schema'), CURRENT_SCHEMA);
    assert.equal(store.boardRevision(), 37); assert.equal(store.telemetryRevision(), 41);
    assert.equal(store.getMeta('boardRevision'), undefined); assert.equal(store.getMeta('telemetryRevision'), undefined);
    store.event('fixture', 'history', 'record');
    assert.equal(store.boardRevision(), 37); assert.equal(store.telemetryRevision(), 42);
    store.advanceRevision();
    assert.equal(store.boardRevision(), 38); assert.equal(store.telemetryRevision(), 43);
    assert.throws(() => store.transaction(() => { store.advanceRevision(); throw new Error('refused'); }), /refused/);
    assert.equal(store.boardRevision(), 38); assert.equal(store.telemetryRevision(), 43);
  } finally { store.close(); }
});


test('a display-only revision cannot mask the next durable write', () => {
  const store = new Store(':memory:');
  let display = '';
  const read = createUiSnapshotFactsCache(store, undefined, undefined, undefined, undefined, () => display);
  try {
    const first = read();
    display = 'changed';
    const second = read();
    assert.ok(second.revision > first.revision);
    store.advanceRevision();
    const third = read();
    assert.notStrictEqual(third, second);
    assert.ok(third.revision > second.revision);
    assert.strictEqual(read(), third);
  } finally { store.close(); }
});
