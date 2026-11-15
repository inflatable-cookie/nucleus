import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StoreMaintenance } from '../service/store-maintenance';
import { Store } from '../core/store/store';
import { StoreCompactor } from '../core/store/store-compaction';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

test('backup.now refuses while draining; backupIfDue is a no-op while closing', async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || '', 'store-maintenance-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  const owner = { closing: true, store, dataDir: dir, backupDir: join(dir, 'backups'), compaction: new StoreCompactor(store, { snapshot: async () => ({ name: 'x', bytes: 1 }), freeBytes: () => 1_000_000 }) };
  const maintenance = new StoreMaintenance(owner);
  try {
    assert.throws(() => maintenance.backupNow(), /draining/);
    maintenance.backupIfDue();
    assert.equal(maintenance.running, null);
    const list = await maintenance.backupList();
    assert.deepEqual(list.snapshots, []);
  } finally { store.close(); }
});
