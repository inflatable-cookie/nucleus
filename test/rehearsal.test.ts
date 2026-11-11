import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, existsSync, rmSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {submissionSchema, runSchema} from '../shared/contracts';
import type { Run } from '../shared/contracts';
import { QueueService } from '../service/transport/server';
import { ServiceClient } from '../shared/service/client';
import { readServiceInfo } from '../service/transport/identity';
import { encodeFrame } from '../shared/service/protocol';
import { timingTest, performanceAssert } from './support/timing';
import { assertCompleted, cleanupDiagnostic, observeOutcome, type BackgroundOutcome } from './support/background-outcome';

/**
 * Live-size copied-store rehearsal (Spec 013 acceptance oracle, work item 8).
 * A production-size store (260 retained identities with realistic handoff and
 * completion payloads) is served by the standalone service with fake external
 * adapters: the initial board transfer, the unchanged refresh bound, task-detail
 * isolation, board read latency during delayed external work and a bounded
 * detail payload are all proven against the copied store. Live rollout stays
 * with the Chatterbox after accepted merge; this fixture never opens the real
 * Queue state.
 */

const BOARD_TARGET = 260;

function makeRun(taskId: string, index: number): Run {
  return runSchema.parse({
    id: `run-${taskId}`, taskId, role: 'revision', generation: 1, head: 'a'.repeat(40), base: 'b'.repeat(40),
    agentId: null, workspaceId: `ws-${taskId}`, profile: null, status: 'finished',
    createdAt: new Date().toISOString(), lastObservedAt: new Date().toISOString(), active: false,
    idleSince: new Date().toISOString(), completion: null, released: true,
  });
}

async function startRehearsal() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nsq')));
  // Keep the service socket below macOS's local path bound while TMPDIR points
  // at the Queue-owned scratch root.
  const dataDir = join(dir, 'q');
  const storePath = join(dataDir, 'queue.sqlite');
  // Build the production-size store directly with the real Store implementation.
  const { Store } = await import('../core/store/store');
  const store = new Store(storePath);
  for (let i = 0; i < BOARD_TARGET; i++) {
      const id = `rehearsal-${String(i).padStart(3, '0')}`;
      const terminal = i % 4 === 3;
      const submission = submissionSchema.parse({
        submissionId: id, title: `Rehearsal task ${i}`, repoPath: `/fixture/repo-${i % 20}`,
        planningCommit: 'a'.repeat(40), handoffPath: `docs/handoffs/${id}.md`, originAgentId: 'origin-worker',
        coordinatorAgentId: 'origin-coordinator', scope: 'general',
      });
      const retired = i === 5 ? [{ agentId: 'agent-1', runId: `run-${id}`, profile: { id: 'p', name: 'P', provider: 'fixture', model: 'm', notes: '', available: true, problem: '', supportedThinking: [] }, reason: 'Rehearsal retired worker' }] : [];
      const task = store.insert(submission, 'fixture-host', 'Handoff body with planning authority, gates and callbacks. '.repeat(120), 'b'.repeat(40),
        { ...(terminal ? {} : { phase: 'working', agentId: 'agent-1', workspaceId: `ws-${id}`, agentIntent: true, lastAgentStatus: 'running', agentActive: true, lastObservedAt: new Date().toISOString() }), retiredWorkers: retired });
      if (!terminal) store.putRun(makeRun(task.id, i));
    for (let e = 0; e < 6; e++) store.event(task.id, 'rehearsal_event', `Rehearsal event detail ${e} with bounded evidence text. `);
  }
  store.close();
  // A copy must never inherit the recorded owner lease.
  const reopened = new Store(storePath);
  reopened.deleteMeta('processOwner');
  reopened.setMeta('paused', false);
  reopened.close();

  const service = new QueueService({ owner: { dataDir, timers: false }, fixture: 'stall', fixtureState: {}, debug: true });
  await service.start();
  const info = readServiceInfo(dataDir)!;
  const client = new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
  await client.connect();
  await service.debug({ target: 'runtime', method: 'ensureBootstrap', args: [] }); // the detached bootstrap (audit wake included) must be done
  return { service, client, dir, dataDir, setStall: async (value: boolean) => { await service.debug({ target: 'fixture', action: 'set-stall', value }); } };
}

timingTest('live-size copied store: board transfer, unchanged refresh, detail isolation and responsiveness', async () => {
  const { service, client, dir, dataDir, setStall } = await startRehearsal();
  let wake: Promise<BackgroundOutcome> | undefined;
  let failed = false;
  try {
    const startedAt = Date.now();
    const full = await client.request('queue.ui-snapshot', {}) as Record<string, unknown>;
    const initialMs = Date.now() - startedAt;
    assert.ok(Array.isArray(full.tasks));
    assert.equal(typeof full.revision, 'number');
    const boardBytes = encodeFrame(full).length - 4;
    const fieldBytes = new Map<string, number>();
    for (const task of full.tasks as Record<string, unknown>[]) for (const [key, value] of Object.entries(task)) {
      fieldBytes.set(key, (fieldBytes.get(key) ?? 0) + Buffer.byteLength(JSON.stringify(value)) + 3);
    }
    const largestFields = [...fieldBytes].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([key, bytes]) => `${key}=${bytes}`).join(', ');
    process.stdout.write(`[rehearsal] initial board ${boardBytes} bytes; largest task fields: ${largestFields}\n`);
    assert.ok(boardBytes < 128 * 1024, `initial board transfer must stay below 128 KiB at production task volume (was ${boardBytes}; largest task fields: ${largestFields})`);
    // The first read builds the in-memory projection (cold); warm reads stay fast below.

    // Unchanged refresh: counters only, below 2 KiB.
    const ackStart = Date.now();
    const ack = await client.request('queue.ui-snapshot', { revision: full.revision }) as Record<string, unknown>;
    const ackMs = Date.now() - ackStart;
    assert.equal(ack.unchanged, true);
    assert.ok(encodeFrame(ack).length - 4 < 2048, `unchanged refresh must stay below 2 KiB (was ${encodeFrame(ack).length - 4})`);
    performanceAssert(ackMs < 100, `an unchanged refresh must be fast (took ${ackMs} ms)`);

    // Board p95 during delayed external work: a slow adapter observation must
    // never stall unrelated board reads.
    const tasks = full.tasks as { id: string }[];
    const target = (tasks[1] as { id: string }).id;
    const detail = await client.request('queue.detail', { taskId: target }) as Record<string, unknown>;
    assert.equal((detail.task as { id: string }).id, target);
    for (const key of ['events', 'runs', 'notices', 'hooks', 'operations'] as const) {
      for (const row of detail[key] as { taskId?: string; run?: { taskId?: string } }[]) {
        const rowTaskId = row.taskId ?? row.run?.taskId;
        if (rowTaskId) assert.equal(rowTaskId, target, `task detail must not carry evidence of another task (saw ${rowTaskId})`);
      }
    }
    const detailBytes = encodeFrame(detail).length - 4;
    assert.ok(detailBytes < 128 * 1024, `one task detail must stay bounded (was ${detailBytes})`);

    // Delayed external work (5 s observe) while warm board reads keep answering.
    await setStall(true);
    // Observed at creation: the requested drain must complete before teardown (#609 rejects a stopped one).
    wake = observeOutcome(service.debug({ target: 'engine', method: 'wake', args: [] }));
    const latencies: number[] = [];
    for (let i = 0; i < 6; i++) {
      const start = Date.now();
      await client.request('queue.ui-snapshot', { revision: full.revision });
      latencies.push(Date.now() - start);
    }
    latencies.sort((a, b) => a - b);
    await setStall(false);
    performanceAssert(latencies[Math.floor(latencies.length * 0.95)] < 100, `warm board reads must stay below 100 ms p95 during external work (p95 ${latencies.at(-1)} ms)`);
    await assertCompleted(wake!, 'the requested background wake');
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // After an earlier failure the stall may still hold the drain; the original error stays primary.
    if (failed) await setStall(false).catch(error => { process.stderr.write(`[rehearsal] cleanup could not clear the stall: ${String(error)}\n`); });
    await client.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
    const note = failed ? await cleanupDiagnostic(wake, 'the requested background wake') : null;
    if (note) process.stderr.write(`[rehearsal] secondary: ${note}\n`);
  }
  assert.ok(existsSync(dataDir) === false, 'the rehearsal copy is temporary');
});
