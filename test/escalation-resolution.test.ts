import { observeIdle } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { boardSource } from './support/board-source';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { completionSchema, dispositionSchema, submissionSchema, taskControlInputSchema, type Task } from '../shared/contracts';
import type { Adapter } from '../core/host';

/**
 * Spec 016 rule 6: an escalated recovery and incident whose question has been
 * answered are closed by one operator-only control that carries a required
 * reason, keeps the escalation event intact as evidence, settles pending
 * attention notices and clears attention. It refuses a non-operator caller, a
 * task with any unreleased run and an escalation still backed by live work, and
 * no automatic or coordinator path can reach the mutation.
 */

const base = 'b'.repeat(40);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-escalation-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const inserted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Answered escalation', repoPath: '/repo',
    planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', base);
  const adapter = {
    profiles: async () => [],
    observe: observeIdle(null),
    archiveAgent: async () => {},
    createRun: async () => { throw new Error('No automatic run is expected'); },
    sendRun: async () => {},
    notify: async () => {},
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  return { dir, store, engine, adapter, taskId: inserted.id, close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** Drive one real escalation through the recovery path, as an incident fixture cannot be invented safely. */
function escalated(f: ReturnType<typeof fixture>, summary: string, phase: Task['phase'] = 'cancelled') {
  const timestamp = new Date().toISOString();
  f.store.update(f.taskId, {
    phase, reason: 'Escalated closeout fault',
    ...(phase === 'cancelled' ? { disposition: dispositionSchema.parse({
      kind: 'cancel', status: 'complete', requestedAt: timestamp, requestedBy: 'operator control',
      reason: 'Operator disposed the answered escalation', workDisposition: 'preserve', effects: [], completedAt: timestamp,
    }) } : {}),
    resolution: { ...f.store.task(f.taskId).resolution, attention: true },
  });
  f.engine.resolution.recovery.escalate(f.store.task(f.taskId), summary);
  return f.store.task(f.taskId);
}

const resolveControl = (taskId: string, version: number, reason: string) =>
  taskControlInputSchema.parse({ taskId, version, action: 'restart', reason });

const escalatedEvents = (f: ReturnType<typeof fixture>) => f.store.eventsAll(f.taskId).filter(event => event.kind === 'recovery_escalated');

test('an answered escalation on a terminal task resolves with the operator reason while the escalation event survives', async () => {
  const f = fixture();
  try {
    const summary = 'Operator disposition required before closeout can continue';
    escalated(f, summary);
    f.store.putNotice({ id: 'attention', taskId: f.taskId, agentId: 'origin', recipientAgentId: 'origin', workspaceId: null, sources: [], originEntry: true, kind: 'attention', status: 'pending', error: '', text: 'Needs attention' });
    f.store.putNotice({ id: 'attention-intent', taskId: f.taskId, agentId: 'origin', recipientAgentId: 'origin', workspaceId: null, sources: [], originEntry: true, kind: 'attention', status: 'intent', error: '', text: 'Delivery outcome unknown' });
    f.store.putNotice({ id: 'completion', taskId: f.taskId, agentId: 'origin', recipientAgentId: 'origin', workspaceId: null, sources: [], originEntry: true, kind: 'completion', status: 'pending', error: '', text: 'Completion' });
    const before = f.store.task(f.taskId);
    assert.equal(escalatedEvents(f).length, 1);
    assert.equal(before.resolution.attention, true);

    const resolved = await f.engine.performTaskControl(resolveControl(f.taskId, before.version, 'The landed review-skip refusal already answered this escalation'));

    assert.equal(resolved.phase, 'cancelled', 'resolving the escalation never decides the task');
    assert.equal(resolved.resolution.attention, false);
    assert.equal(resolved.resolution.recovery?.status, 'resolved');
    assert.equal(resolved.resolution.incident?.status, 'resolved');
    assert.match(resolved.resolution.incident?.detail ?? '', /answered by the operator/i);
    assert.match(resolved.resolution.incident?.detail ?? '', /review-skip refusal/);
    // The escalation event and its summary stay untouched evidence.
    assert.equal(resolved.resolution.recovery?.summary, summary);
    assert.deepEqual(escalatedEvents(f).map(event => event.detail), [summary]);
    // Pending attention notices settle; a delivered or uncertain outcome is not rewritten.
    const notices = f.store.notices(f.taskId);
    assert.equal(notices.find(notice => notice.id === 'attention')?.status, 'superseded');
    assert.equal(notices.find(notice => notice.id === 'attention-intent')?.status, 'intent');
    assert.equal(notices.find(notice => notice.id === 'completion')?.status, 'pending');
    assert.ok(f.store.eventsAll(f.taskId).some(event => event.kind === 'attention_episode_resolved'));
    assert.ok(f.store.eventsAll(f.taskId).some(event => event.kind === 'operator_control' && event.detail === 'restart'));
  } finally { await f.close(); }
});

test('a caller that is not the operator cannot resolve an escalation', async () => {
  const f = fixture();
  try {
    escalated(f, 'Operator disposition required');
    const before = f.store.task(f.taskId);
    assert.throws(() => f.engine.resolution.resolveEscalation(before, 'A coordinator cannot close its own case'), /operator-only/);
    const after = f.store.task(f.taskId);
    assert.equal(after.resolution.recovery?.status, 'escalated');
    assert.equal(after.resolution.incident?.status, 'escalated');
    assert.equal(after.resolution.attention, true);
    assert.equal(after.version, before.version);
  } finally { await f.close(); }
});

test('a task with any unreleased run refuses escalation resolution without mutation', async () => {
  const f = fixture();
  try {
    const task = escalated(f, 'Operator disposition required');
    f.store.putRun({
      id: 'reviewer-run', taskId: f.taskId, role: 'reviewer', generation: task.coordinatorGeneration,
      head: 'a'.repeat(40), base, agentId: 'reviewer', workspaceId: 'workspace', profile: null, status: 'running',
      createdAt: new Date().toISOString(), lastObservedAt: null, active: true, idleSince: null, completion: null, released: false,
    });
    const before = f.store.task(f.taskId);
    await assert.rejects(() => f.engine.performTaskControl(resolveControl(f.taskId, before.version, 'The question was answered')), /unreleased reviewer run/);
    const after = f.store.task(f.taskId);
    assert.equal(after.resolution.recovery?.status, 'escalated');
    assert.equal(after.resolution.incident?.status, 'escalated');
    assert.equal(after.resolution.attention, true);
    assert.equal(after.version, before.version);
  } finally { await f.close(); }
});

// Round 4 (Tom, 2026-10-19): restart answers an escalation only when nothing
// else applies. An escalation the task's own fault still backs is not answered:
// the restart re-runs the parked step, which settles the episode itself.
test('an escalation still backed by the task fault is not answered: restart re-runs the parked step', async () => {
  const f = fixture();
  try {
    escalated(f, 'Revision budget exhausted; coordinator judgment required', 'needs_attention');
    const before = f.store.task(f.taskId);
    await f.engine.performTaskControl(resolveControl(f.taskId, before.version, 'Answered by the operator'));
    assert.ok(!f.store.eventsAll(f.taskId).some(event => event.kind === 'escalation_resolved'), 'the restart is not an answer');
    assert.notEqual(f.store.task(f.taskId).resolution.recovery?.status, 'escalated');
  } finally { await f.close(); }
});

test('a working lane is not answered even when the escalated incident has been superseded', async () => {
  const f = fixture();
  try {
    escalated(f, 'The closeout thread stopped without a callback', 'changes_requested');
    f.store.update(f.taskId, { phase: 'changes_requested', reason: 'Second fault' });
    f.engine.resolution.ensureIncident(f.store.task(f.taskId), null, 'PR head changed after review');
    const before = f.store.task(f.taskId);
    assert.notEqual(before.resolution.recovery?.incidentId, before.resolution.incident?.id);
    // Round 4: a working lane's restart acts on its work or refuses for it; it never answers the escalation.
    await f.engine.performTaskControl(resolveControl(f.taskId, before.version, 'The first escalation was answered')).catch(() => undefined);
    assert.ok(!f.store.eventsAll(f.taskId).some(event => event.kind === 'escalation_resolved'));
  } finally { await f.close(); }
});

test('a superseded escalated incident on a non-terminal park settles with the restart that re-runs the park (round 4)', async () => {
  const f = fixture();
  try {
    escalated(f, 'The closeout thread stopped without a callback', 'needs_attention');
    // A later fault of a different normalized cause gives the task a new
    // incident identity; the escalated one is superseded evidence rather than
    // the live episode.
    f.store.update(f.taskId, { phase: 'needs_attention', reason: 'Second fault' });
    f.engine.resolution.ensureIncident(f.store.task(f.taskId), null, 'PR head changed after review');
    const recovery = f.store.task(f.taskId).resolution.recovery!;
    const currentIncident = f.store.task(f.taskId).resolution.incident!;
    assert.notEqual(recovery.incidentId, currentIncident.id);

    const before = f.store.task(f.taskId);
    const resolved = await f.engine.performTaskControl(resolveControl(f.taskId, before.version, 'The first escalation was answered'));

    assert.notEqual(resolved.resolution.recovery?.status, 'escalated', 'the escalated episode settles with the restart');
    assert.equal(resolved.resolution.attention, false);
    assert.ok(currentIncident.id);
  } finally { await f.close(); }
});

test('no automatic or coordinator path can resolve an escalation', async () => {
  const f = fixture();
  try {
    escalated(f, 'Operator decision required', 'needs_attention');
    Object.assign(f.adapter as unknown as Record<string, unknown>, { supportsCoordinatorRecovery: true });

    const routed = await f.engine.resolution.recovery.route(f.store.task(f.taskId));
    assert.equal(routed, 'Operator decision required');
    await f.engine.resolution.recovery.pass();

    const after = f.store.task(f.taskId);
    assert.equal(after.resolution.recovery?.status, 'escalated', 'the coordinator path leaves the escalation for the operator');
    assert.equal(after.resolution.incident?.status, 'escalated');
    assert.equal(f.store.eventsAll(f.taskId).some(event => event.kind === 'escalation_resolved'), false);
    // A coordinator callback has no recovery action that resolves an escalation.
    assert.equal(completionSchema.safeParse({ eventId: 'e', taskId: f.taskId, runId: 'r', status: 'recovered', summary: 'done', recoveryAction: 'resolve_escalation' }).success, false);
  } finally { await f.close(); }
});

test('the retired escalation action is refused, and unrelated actions still refuse a reason (round 4)', () => {
  const schema = taskControlInputSchema;
  assert.equal(schema.safeParse({ taskId: 'task', version: 1, action: 'resolve_escalation', reason: 'Answered by the operator' }).success, false, 'resolve_escalation is retired; restart answers');
  assert.equal(schema.safeParse({ taskId: 'task', version: 1, action: 'coordinator', coordinatorAgentId: 'agent' }).success, false, 'coordinator is retired; route role=coordinator assigns');
  assert.equal(schema.safeParse({ taskId: 'task', version: 1, action: 'restart', reason: 'Answered by the operator' }).success, true);

  const unrelated: Record<string, unknown>[] = [
    { action: 'release' },
    { action: 'promote' },
    { action: 'set_dependencies', dependsOn: [] },
  ];
  for (const input of unrelated) {
    const base = { taskId: 'task', version: 1, ...input };
    assert.equal(schema.safeParse(base).success, true, `${input.action} must accept its own input without a reason`);
    assert.equal(schema.safeParse({ ...base, reason: 'An unrelated reason' }).success, false, `${input.action} must still refuse a reason`);
  }
  // Cancellation and supersession keep their pre-existing reason field.
  assert.equal(schema.safeParse({ taskId: 'task', version: 1, action: 'cancel', reason: 'Why this work ends' }).success, true);
  assert.equal(schema.safeParse({ taskId: 'task', version: 1, action: 'supersede', reason: 'Why this work ends', replacementTaskId: 'later-task' }).success, true);
  assert.equal(schema.safeParse({ taskId: 'task', version: 1, action: 'restart', reason: 'Answered', workDisposition: 'preserve' }).success, false);
});

test('the control is discoverable from the native surface and the skill help without reading the schema', () => {
  const client = boardSource();
  const skill = readFileSync(new URL('../skills/nucleus/SKILL.md', import.meta.url), 'utf8');
  assert.match(client, /title="Answered escalation"/);
  assert.match(client, /Answer with restart/);
  assert.doesNotMatch(client, /action:"resolve_escalation"/);
  assert.match(skill, /an owner `restart` with the answer as its `reason` closes it/);
  assert.match(skill, /a coordinator's restart never answers one/);
  // The new section introduces no literal color, so it inherits the dark theme
  // from the same surface colors every other control field uses.
  const start = client.indexOf('title="Answered escalation"');
  const section = client.slice(start, client.indexOf('</DetailSection>', start));
  assert.ok(section.length > 200, 'the answered-escalation section must be present');
  assert.doesNotMatch(section, /#[0-9a-fA-F]{3,8}\b/, 'the control must use theme colors rather than a literal color');
});
