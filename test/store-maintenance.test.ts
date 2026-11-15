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
  const owner = {
    closing: true, store, dataDir: dir, backupDir: join(dir, 'backups'),
    compaction: new StoreCompactor(store, { snapshot: async () => ({ name: 'x', bytes: 1 }), freeBytes: () => 1_000_000 }),
    backupNow: async () => ({ snapshots: [], workRoot: dir, localError: null }),
  };
  const maintenance = new StoreMaintenance(owner);
  try {
    assert.throws(() => maintenance.backupNow(), /draining/);
    maintenance.backupIfDue();
    assert.equal(maintenance.running, null);
    const list = await maintenance.backupList();
    assert.deepEqual(list.snapshots, []);
  } finally { store.close(); }
});

test('backupIfDue takes a due snapshot through the owner so QueueRuntime.prototype.backupNow still binds', async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || '', 'store-maintenance-due-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  let called = 0;
  const owner = {
    closing: false, store, dataDir: dir, backupDir: join(dir, 'backups'),
    compaction: new StoreCompactor(store, { snapshot: async () => ({ name: 'x', bytes: 1 }), freeBytes: () => 1_000_000 }),
    backupNow: async () => { called++; return { snapshots: [], workRoot: dir, localError: null }; },
  };
  const maintenance = new StoreMaintenance(owner);
  try {
    maintenance.backupIfDue();
    await Promise.resolve();
    assert.equal(called, 1);
  } finally { store.close(); }
});

test('verifiedSnapshot takes the snapshot through the owner so QueueRuntime.prototype.backupNow still binds', async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || '', 'store-maintenance-verified-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  let called = 0;
  const owner = {
    closing: false, store, dataDir: dir, backupDir: join(dir, 'backups'),
    compaction: new StoreCompactor(store, { snapshot: async () => ({ name: 'x', bytes: 1 }), freeBytes: () => 1_000_000 }),
    backupNow: async () => {
      called++;
      return { snapshots: [{ name: 'snap', kind: 'hourly' as const, at: '2026-01-01T00:00:00.000Z', size: 12, verified: true as const }], workRoot: dir, localError: null };
    },
  };
  const maintenance = new StoreMaintenance(owner);
  try {
    const result = await maintenance.verifiedSnapshot();
    assert.equal(called, 1);
    assert.equal(result.name, 'snap');
    assert.equal(result.bytes, 12);
  } finally { store.close(); }
});
