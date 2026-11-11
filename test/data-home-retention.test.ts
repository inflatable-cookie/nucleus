import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneLiveDataHomeBackupCopies, staleBackupCopies } from '../core/store/data-home-retention';

test('backup copy planner prunes only snapshots no newer than a verified external snapshot', () => {
  const old = { path: 'old.sqlite.gz', at: '2026-10-26T00:00:00.000Z', bytes: 100 };
  const newCopy = { path: 'new.sqlite.gz', at: '2026-11-10T00:00:00.000Z', bytes: 200 };
  assert.deepEqual(staleBackupCopies([old, newCopy], '2026-11-01T00:00:00.000Z'), [{ path: old.path, bytes: old.bytes }]);
  assert.deepEqual(staleBackupCopies([old, newCopy], null), [], 'no external snapshot means no deletion');
});

test('backup retention never prunes a fixture data home', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'nucleus-data-home-fixture-'));
  try {
    const file = join(dataDir, 'backups', '2026-10-26T00-00-00-000Z-old.hourly.sqlite.gz');
    mkdirSync(join(dataDir, 'backups'));
    writeFileSync(file, 'fixture copy');
    assert.deepEqual(pruneLiveDataHomeBackupCopies(dataDir), []);
    assert.equal(existsSync(file), true);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
