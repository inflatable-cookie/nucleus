import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { runSchema, submissionSchema } from '../shared/contracts';
import { QueueService } from '../service/transport/server';
import { ServiceClient } from '../shared/service/client';
import { readServiceInfo, SERVICE_SOCKET_FILE } from '../service/transport/identity';
import { assertSocketPathFits, socketFixtureDirectory } from './support/socket-fixture';

test('availability removal over RPC preserves active settings and history, is idempotent and survives restart', async () => {
  const dataDir = socketFixtureDirectory(SERVICE_SOCKET_FILE);
  const root = dataDir;
  // The service derives its own socket inside the data directory, so the fixture
  // states that exact path against the transport's bound before it starts.
  assertSocketPathFits(join(dataDir, SERVICE_SOCKET_FILE));
  let service = new QueueService({ owner: { dataDir }, fixture: 'fake', debug: true });
  let client: ServiceClient | undefined;
  const connect = async () => {
    await service.start();
    const info = readServiceInfo(dataDir)!;
    client = new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
    await client.connect();
  };
  const availability = async () => (await client!.request('queue.snapshot', {}) as { availability: unknown[] }).availability;
  try {
    await connect();
    const active = { group: 'active', unavailable: true, reason: 'Exhausted', retryAt: null };
    const obsolete = { group: 'obsolete', unavailable: true, reason: 'Old quota', retryAt: null };
    await client!.request('queue.availability', active);
    await client!.request('queue.availability', obsolete);
    // RPC compatibility: an ordinary set payload keeps ignoring unrelated extra
    // fields, exactly as it did when zod stripped unknown keys.
    await client!.request('queue.availability', { ...active, legacyField: 'ignored' });
    assert.deepEqual(await availability(), [active, obsolete], 'unknown keys on a set payload are still accepted and stripped');
    await client!.request('queue.availability', { ...active, unavailable: false, reason: 'Recovered', retryAt: null, legacyField: 'ignored' });
    assert.deepEqual(await availability(), [{ ...active, unavailable: false, reason: 'Recovered' }, obsolete], 'unknown keys on a reset payload are still accepted and stripped');
    await client!.request('queue.availability', active);
    assert.deepEqual(await availability(), [active, obsolete], 'the reset restored the active record without the extra field');
    await assert.rejects(client!.request('queue.availability', { ...active, action: 'bogus' }), /./,
      'an action key on an otherwise ordinary payload is ambiguous and refused');
    assert.deepEqual(await availability(), [active, obsolete]);
    const pool = [{ profileId: 'fixture', group: 'active', enabled: false, roles: ['worker'], scopes: ['general'], weight: 1 }];
    await service.debug({ target: 'store', method: 'setMeta', args: ['pool', pool] });
    await client!.request('queue.control', { paused: true });
    const before = await availability();
    await assert.rejects(client!.request('queue.availability', { action: 'remove', group: 'active' }), /still in the profile pool/);
    await assert.rejects(client!.request('queue.availability', { action: 'remove', ...obsolete }), /./,
      'an ambiguous remove-and-reset payload must be refused');
    assert.deepEqual(await availability(), before, 'refusals preserve both records, including the exhausted disabled group');

    const task = await service.debug({ target: 'store', method: 'insert', args: [submissionSchema.parse({
      submissionId: 'availability', title: 'Availability fixture', repoPath: '/fixture', planningCommit: 'a'.repeat(40),
      handoffPath: 'docs/handoffs/fixture.md', originAgentId: 'origin',
    }), 'fixture-host', 'Fixture', 'b'.repeat(40)] }) as { id: string };
    await service.debug({ target: 'store', method: 'update', args: [task.id, { profileGroup: 'obsolete' }] });
    await assert.rejects(client!.request('queue.availability', { action: 'remove', group: 'obsolete' }), /unfinished task/,
      'the initial worker lives on its task row rather than in runs');
    assert.deepEqual(await availability(), before);
    await service.debug({ target: 'store', method: 'update', args: [task.id, { profileGroup: null }] });
    const run = runSchema.parse({ id: 'retained-run', taskId: task.id, role: 'reviewer', generation: 1,
      head: 'a'.repeat(40), base: 'b'.repeat(40), agentId: 'reviewer', workspaceId: 'workspace',
      profile: null, profileGroup: 'obsolete', status: 'running', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: false, idleSince: null, completion: null, released: false });
    await service.debug({ target: 'store', method: 'putRun', args: [run] });
    await assert.rejects(client!.request('queue.availability', { action: 'remove', group: 'obsolete' }), /unreleased run \(retained-run\)/);
    assert.deepEqual(await availability(), before, 'a retained run protects its quota even after its pool entry is removed');
    await service.debug({ target: 'store', method: 'putRun', args: [{ ...run, released: true }] });
    const historicalRun = await service.debug({ target: 'store', method: 'run', args: [run.id] });

    assert.deepEqual(await client!.request('queue.availability', { action: 'remove', group: 'obsolete' }), { ok: true });
    assert.deepEqual(await availability(), [active]);
    const revision = await service.debug({ target: 'store', method: 'telemetryRevision', args: [] });
    assert.deepEqual(await client!.request('queue.availability', { action: 'remove', group: 'obsolete' }), { ok: true });
    assert.equal(await service.debug({ target: 'store', method: 'telemetryRevision', args: [] }), revision, 'absent removal writes nothing');
    assert.deepEqual(await service.debug({ target: 'store', method: 'pool', args: [] }), pool);
    assert.equal(await service.debug({ target: 'store', method: 'getMeta', args: ['paused'] }), true);
    assert.deepEqual(await service.debug({ target: 'store', method: 'run', args: [run.id] }), historicalRun);

    await client!.close();
    await service.stop();
    service = new QueueService({ owner: { dataDir }, fixture: 'fake', debug: true });
    await connect();
    assert.deepEqual(await availability(), [active], 'obsolete record stays removed after restart');
    assert.deepEqual(await service.debug({ target: 'store', method: 'pool', args: [] }), pool);
    assert.equal(await service.debug({ target: 'store', method: 'getMeta', args: ['paused'] }), true);
    assert.deepEqual(await service.debug({ target: 'store', method: 'run', args: [run.id] }), historicalRun);
  } finally {
    await client?.close();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
