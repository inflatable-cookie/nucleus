import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaseoApi } from '@getpaseo/client';
import { Admission, admitAdapter } from '../core/host/admission';
import { PaseoAdapter } from '../service/paseo-composition';
import { timedDaemonRequests } from '../hosts/paseo/adapter/paseo-call-timing';

/** Production adapter and SDK pagination, with only the daemon request faked. */
function fixture(pageMs: number, pages = 4) {
  const clock = { now: 0 };
  const admission = new Admission({ now: () => clock.now, startIntervalMs: 0 });
  const requests: unknown[] = [];
  const target = { id: 'wanted', workspaceId: 'workspace', status: 'idle', activeTurn: null,
    pendingPermissions: [], labels: { 'nucleus.plugin': 'nucleus' }, archivedAt: null };
  let fail = false;
  const daemon = {
    fetchAgents: async (options: { page: { cursor?: string } }) => {
      requests.push(options);
      clock.now += pageMs;
      if (fail) throw Error('Transport not connected');
      const page = Number(options.page.cursor ?? 0);
      return { entries: page === pages - 1 ? [{ agent: target }] : [],
        pageInfo: { hasMore: page < pages - 1, nextCursor: page < pages - 1 ? String(page + 1) : null } };
    },
  };
  const raw = new PaseoAdapter('ws://127.0.0.1:1', '/unused/callback.sock', '/unused/report.mjs');
  (raw as unknown as { api: unknown }).api = createPaseoApi(timedDaemonRequests(daemon) as never);
  return { clock, admission, requests, raw, adapter: admitAdapter(raw, admission),
    fail: () => { fail = true; } };
}

test('a complete inventory samples SDK pages, not their aggregate duration; parent trips', async () => {
  const f = fixture(4_000);
  for (let pass = 0; pass < 3; pass++) {
    const result = await f.adapter.observationInventory!(['wanted']);
    assert.equal(result?.get('wanted')?.workspaceId, 'workspace');
  }
  assert.equal(f.requests.length, 12, 'four pages per walk, one label generation');
  assert.equal(f.admission.snapshot().inventory.completed, 3, 'whole walks keep their admission gate');
  assert.equal(f.admission.snapshot().latency.inventory.samples, 12);
  assert.equal(f.admission.snapshot().latency.inventory.maxMs, 4_000);
  assert.equal(f.admission.snapshot().backpressure.degraded, false);
  assert.equal(f.admission.workspaceAdmission(0).admitted, true);

  // Old wrapper: each complete 12-second walk was one critical latency sample.
  const parent = fixture(3_000);
  for (let pass = 0; pass < 3; pass++)
    await parent.admission.run('inventory', () => parent.raw.observationInventory(['wanted']));
  assert.equal(parent.admission.snapshot().latency.inventory.samples, 3);
  assert.equal(parent.admission.snapshot().latency.inventory.maxMs, 12_000);
  assert.equal(parent.admission.snapshot().backpressure.degraded, true);
  assert.equal(parent.admission.workspaceAdmission(0).admitted, false);
});

test('genuinely slow inventory page requests still trip workspace admission', async () => {
  const f = fixture(10_000, 3);
  await f.adapter.observationInventory!(['wanted']);
  assert.equal(f.admission.snapshot().latency.inventory.samples, 3);
  assert.match(f.admission.snapshot().backpressure.reason, /3 slow critical Paseo calls/);
  assert.equal(f.admission.workspaceAdmission(0).admitted, false);
});

test('healthy pages recover the breaker after cooldown, transport failure still trips', async () => {
  const f = fixture(100);
  for (let i = 0; i < 3; i++) await f.admission.run('inventory', async () => { f.clock.now += 10_000; });
  assert.equal(f.admission.workspaceAdmission(0).admitted, false);
  f.clock.now += 30_000;
  await f.adapter.observationInventory!(['wanted']);
  assert.equal(f.admission.snapshot().backpressure.degraded, false);
  assert.equal(f.admission.workspaceAdmission(0).admitted, true);
  f.fail();
  await assert.rejects(f.adapter.observationInventory!(['wanted']), /Transport not connected/);
  assert.equal(f.admission.snapshot().backpressure.degraded, true);
  assert.equal(f.admission.workspaceAdmission(0).admitted, false);
});
