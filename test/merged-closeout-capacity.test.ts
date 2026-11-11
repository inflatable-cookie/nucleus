import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { submissionSchema, type Task, type Run } from '../shared/contracts';
import type { Adapter } from '../core/host';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'queue-closeout-capacity-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  store.setMeta('globalLimit', 1);
  const engine = new Engine(store, {} as Adapter, 0, () => true);
  const insert = () => store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Task',
    repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'owner' }), 'host', 'handoff', 'a'.repeat(40));
  const first = insert(), second = insert();
  const parked = store.update(first.id, { phase: 'verifying', reason: 'Waiting for repository integration turn',
    resolution: { ...first.resolution, integrationTurn: { sequence: 1, acceptedAt: first.createdAt } } });
  const landed = store.update(second.id, { phase: 'merging',
    resolution: { ...second.resolution, externalMerge: true, mergedCommit: 'b'.repeat(40),
      integrationTurn: { sequence: 2, acceptedAt: second.createdAt } } });
  return { store, engine, parked, landed, insert,
    async close() { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('a landed closeout passes a turn-parked verification while unmerged FIFO stays intact', async () => {
  // Spec 058 (task 629): the landed closeout holds no slot once its agent is
  // gone, so nothing is capacity-blocked; the parked verification waits for
  // the integration turn, and the merge order still lets the landed closeout
  // pass it while unmerged FIFO stays intact.
  const f = fixture();
  try {
    assert.equal(f.engine.resolution.slotAdmissionReason(f.parked), '');
    assert.equal(f.engine.resolution.slotAdmissionReason(f.landed), '');
    assert.equal(f.engine.resolution.holdsIntegrationTurn(f.landed), true);
    const unmerged = f.store.update(f.landed.id, { resolution: { ...f.landed.resolution, mergedCommit: null } });
    assert.equal(f.engine.resolution.holdsIntegrationTurn(unmerged), false);
    assert.equal(f.store.task(f.parked.id).phase, 'verifying');
    assert.equal(f.store.runs(f.parked.id).length, 0);
  } finally { await f.close(); }
});

test('live or uncertain verification, recovery and merge ownership cannot be bypassed', async () => {
  const f = fixture();
  try {
    const variants: Partial<Task>[] = [
      { reason: 'Repository prospective merge gate running' },
      { resolution: { ...f.parked.resolution, currentRunId: 'live' } },
      { resolution: { ...f.parked.resolution, recoveryActive: true } },
      { resolution: { ...f.parked.resolution, mergeIntent: true } },
      { resolution: { ...f.parked.resolution, mergedCommit: 'c'.repeat(40) } },
      { resolution: { ...f.parked.resolution, projectValidation: { argv: ['validate'], digest: 'd'.repeat(64), exitCode: null, durationMs: 0,
        outputTail: '', base: 'b'.repeat(40), head: 'c'.repeat(40), state: 'running', queueBuild: '', settingsRevision: 0,
        pid: null, capacityWait: null, capacityUnavailable: false } } },
    ];
    for (const patch of variants) {
      f.store.update(f.parked.id, { reason: f.parked.reason,
        resolution: f.parked.resolution, ...patch });
      assert.equal(f.engine.resolution.holdsIntegrationTurn(f.landed), false, JSON.stringify(patch));
    }
    f.store.update(f.parked.id, { resolution: f.parked.resolution });
    f.store.putRun({ id: 'uncertain', taskId: f.parked.id, role: 'closeout', generation: 1,
      head: 'a'.repeat(40), base: 'a'.repeat(40), agentId: null, workspaceId: '', profile: null,
      status: 'uncertain', createdAt: new Date().toISOString(), lastObservedAt: null, active: null,
      idleSince: null, completion: null, released: false } as Run);
    assert.equal(f.engine.resolution.holdsIntegrationTurn(f.landed), true, 'a stranded closeout delivery yields; no merge could have been sent');
  } finally { await f.close(); }
});

test('verification rewrites a stale wait reason before any awaited gate', async () => {
  // Spec 058 (task 629): with the slot freed, capacity admits; the idle
  // turn-waiter is bypassed, so the landed closeout still passes it. The
  // verification pass still reclaims ownership synchronously by rewriting the
  // stale wait reason before taking the turn or awaiting any hook.
  const f = fixture();
  try {
    f.store.setMeta('globalLimit', 2);
    assert.equal(f.engine.resolution.slotAdmissionReason(f.parked), '');
    assert.equal(f.engine.resolution.holdsIntegrationTurn(f.landed), true);
    let observedReason = '';
    f.engine.resolution.claimIntegrationTurn = task => {
      observedReason = f.store.task(task.id).reason;
      return false;
    };
    const verification = f.engine.resolution as unknown as { verification(task: Task): Promise<void> };
    await verification.verification(f.parked);
    assert.equal(observedReason, 'Reacquiring repository integration turn after capacity admission');
  } finally { await f.close(); }
});

test('a landed task still waits for an earlier landed closeout', async () => {
  const f = fixture();
  try {
    f.store.update(f.parked.id, { phase: 'syncing', resolution: { ...f.parked.resolution, mergedCommit: 'c'.repeat(40) } });
    assert.equal(f.engine.resolution.holdsIntegrationTurn(f.landed), false);
  } finally { await f.close(); }
});

test('restored capacity cannot join a landed sync; the durable reservation expires only after closeout', async () => {
  const f = fixture();
  try {
    assert.equal(f.engine.resolution.claimIntegrationTurn(f.landed), true);
    const syncing = f.store.update(f.landed.id, { phase: 'syncing' });
    f.store.setMeta('globalLimit', 2);
    assert.equal(f.engine.resolution.holdsIntegrationTurn(f.parked), false);
    assert.equal(f.engine.resolution.claimIntegrationTurn(f.parked), false);
    assert.equal(f.engine.resolution.holdsIntegrationTurn(syncing), true);
    // The reservation also survives constructing another resolution owner.
    const restarted = new Engine(f.store, {} as Adapter, 0, () => true);
    assert.equal(restarted.resolution.holdsIntegrationTurn(syncing), true);
    assert.equal(restarted.resolution.holdsIntegrationTurn(f.parked), false);
    await restarted.stop();
    f.store.update(f.landed.id, { phase: 'closing' });
    assert.equal(f.engine.resolution.holdsIntegrationTurn(f.parked), false);
    f.store.update(f.landed.id, { phase: 'done' });
    assert.equal(f.engine.resolution.holdsIntegrationTurn(f.parked), true);
  } finally { await f.close(); }
});

test('a landed closeout breaks mixed slot and idle integration waits without bypassing active verification', async () => {
  const f = fixture();
  try {
    const other = f.insert();
    const waiting = f.store.update(other.id, { phase: 'verifying', reason: 'Waiting for repository integration turn',
      resolution: { ...other.resolution, integrationTurn: { sequence: 2, acceptedAt: other.createdAt } } });
    const landed = f.store.update(f.landed.id, { resolution: { ...f.landed.resolution,
      integrationTurn: { sequence: 3, acceptedAt: f.landed.createdAt } } });
    assert.equal(f.engine.resolution.claimIntegrationTurn(landed), true);
    const reservation = f.store.getMeta<{ bypassedTaskIds: string[] }>(`closeoutTurn:${landed.repoPath}`)!;
    assert.deepEqual(new Set(reservation.bypassedTaskIds), new Set([f.parked.id, waiting.id]));
    f.store.setMeta('globalLimit', 3);
    assert.equal(f.engine.resolution.claimIntegrationTurn(waiting), false);
    assert.equal(f.engine.resolution.holdsIntegrationTurn(landed), true);
    f.store.deleteMeta(`closeoutTurn:${landed.repoPath}`);
    f.store.update(waiting.id, { reason: 'Reacquiring repository integration turn after capacity admission' });
    assert.equal(f.engine.resolution.claimIntegrationTurn(landed), false);
  } finally { await f.close(); }
});


test('integration waiters cannot reserve the slots needed by their first verification', async () => {
  const f = fixture();
  try {
    f.store.update(f.landed.id, { phase: 'done' });
    f.store.setMeta('globalLimit', 20);
    f.store.setMeta('projectLimit', 1);
    const later = f.store.update(f.parked.id, { reason: 'Waiting for repository integration turn',
      resolution: { ...f.parked.resolution, integrationTurn: { sequence: 2, acceptedAt: f.parked.createdAt } } });
    const created = f.insert();
    const first = f.store.update(created.id, { phase: 'verifying',
      reason: 'Waiting for a project slot… waiting behind 1 in-flight',
      resolution: { ...created.resolution, integrationTurn: { sequence: 1, acceptedAt: created.createdAt } } });
    assert.equal(f.engine.resolution.holdsIntegrationTurn(first), true);
    assert.equal(f.engine.resolution.holdsIntegrationTurn(later), false);
    assert.equal(f.engine.resolution.slotAdmissionReason(first), '');
    const reader = f.engine.resolution.slotAdmissionReader(f.store.admissionCandidates(), f.store.runs());
    assert.equal(reader(first), '');
    assert.equal(f.engine.resolution.claimIntegrationTurn(first), true);
    assert.equal(f.engine.resolution.claimIntegrationTurn(later), false);
    f.store.update(first.id, { phase: 'done' });
    assert.equal(f.engine.resolution.holdsIntegrationTurn(later), true);
    assert.equal(f.engine.resolution.slotAdmissionReason(later), '');
  } finally { await f.close(); }
});


test('legacy merged verifying rows do not recurse through capacity admission', async () => {
  const f = fixture();
  try {
    f.store.setMeta('globalLimit', 5);
    const merged = f.store.update(f.landed.id, { phase: 'verifying' });
    assert.equal(f.engine.resolution.slotAdmissionReason(f.parked), '');
    assert.equal(f.engine.resolution.slotAdmissionReason(merged), '');
    const reader = f.engine.resolution.slotAdmissionReader(f.store.admissionCandidates(), f.store.runs());
    assert.equal(reader(f.parked), '');
    assert.equal(reader(merged), '');
  } finally { await f.close(); }
});


test('board admission caches ownership only within one synchronous reader', async () => {
  const f = fixture();
  try {
    f.store.update(f.landed.id, { phase: 'done' });
    f.store.setMeta('globalLimit', 20);
    const original = f.engine.resolution.holdsIntegrationTurn.bind(f.engine.resolution);
    let reads = 0;
    f.engine.resolution.holdsIntegrationTurn = task => { reads++; return original(task); };
    const reader = f.engine.resolution.slotAdmissionReader(f.store.admissionCandidates(), f.store.runs());
    assert.equal(reader(f.parked), '');
    assert.equal(reader(f.parked), '');
    assert.equal(reads, 1);
    // Turn sequences are positive, so the parked turn moves to 2 to leave room for an earlier one.
    f.store.update(f.parked.id, { resolution: { ...f.parked.resolution, integrationTurn: { sequence: 2, acceptedAt: f.parked.createdAt } } });
    const parked = f.store.task(f.parked.id);
    const created = f.insert();
    f.store.update(created.id, { phase: 'verifying', resolution: { ...created.resolution,
      integrationTurn: { sequence: 1, acceptedAt: created.createdAt } } });
    const fresh = f.engine.resolution.slotAdmissionReader(f.store.admissionCandidates(), f.store.runs());
    fresh(parked);
    assert.equal(reads, 3);
    assert.equal(f.engine.resolution.holdsIntegrationTurn(parked), false);
  } finally { await f.close(); }
});
