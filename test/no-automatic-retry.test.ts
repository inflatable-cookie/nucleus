import { observeIdle } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import type { ResolutionAdapter } from '../core/resolution';
import {
  automaticRetryForbidden,
  noAutomaticRetryRule,
  nonDeliveryFor,
} from '../core/recovery/non-delivery';
import {
  collectOwnerVerbFacts,
  ownerTaskNext,
} from '../core/verbs/owner-verbs';
import {
  runSchema,
  submissionSchema,
  taskControlInputSchema,
  taskNextSchema,
  type Completion,
  type Profile,
  type Run,
  type Task,
} from '../shared/contracts';
import type { Adapter } from '../core/host';
import { fixture as responsibleFixture, head } from './support/responsible-lifecycle-fixture';

/**
 * Task 645: an owner's no-automatic-retry instruction stays in force after its
 * run starts. The owner control records it durably with provenance, the launch
 * clearing the pending instruction never lifts it, only a later owner control
 * lifts it, `next` shows it, and every automatic relaunch is suppressed in
 * favour of the planner ladder.
 */

const lightHead = 'a'.repeat(40), lightBase = 'b'.repeat(40);
const CALLER = 'owner-thread';

const workerProfile = (id: string, model: string): Profile =>
  ({ id, name: id, provider: 'test', model, notes: '', available: true, problem: '', supportedThinking: [] });
const lightWorker = workerProfile('worker', 'test/worker');
const lightReviewer = workerProfile('reviewer', 'test/reviewer');

function lightFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-no-retry-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  // Frozen while owner controls are chained: a trailing advance would dispatch
  // on the instruction and race the next control's version guard. Owner verbs
  // apply while paused; only dispatch waits.
  store.setMeta('paused', true);
  const inserted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'No retry stays in force', repoPath: '/repo', planningCommit: lightBase,
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', lightBase);
  store.setMeta('pool', [
    { profileId: lightWorker.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] },
    { profileId: lightReviewer.id, enabled: true, group: 'review', roles: ['reviewer'], weight: 1, scopes: ['general'] },
  ]);
  const adapter = {
    profiles: async () => [lightWorker, lightReviewer],
    observe: observeIdle(null),
    agentTimelinePage: async () => ({ entries: [] }),
    findAgents: async () => [], findRunAgents: async () => [], verifyWorkspace: async () => {},
    findWorkspaces: async () => [],
    verifyPr: async () => ({ url: 'https://github.com/example/repo/pull/7', head: lightHead }),
    notify: async () => {}, archiveAgent: async () => {},
    createRun: async () => { throw new Error('no dispatch is expected in these fixtures'); }, sendRun: async () => {},
    stopAgentTurn: async () => {},
  } as unknown as Adapter & ResolutionAdapter;
  const engine = new Engine(store, adapter, 0, () => true);
  engine.profiles = [lightWorker, lightReviewer];
  const task = () => store.task(inserted.id);
  const next = () => taskNextSchema.parse(ownerTaskNext(collectOwnerVerbFacts(store, task())));
  const events = (kind: string) => store.eventsAll(inserted.id).filter(event => event.kind === kind);
  return {
    dir, store, engine, taskId: inserted.id, task, next, events,
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function dispatched(f: ReturnType<typeof lightFixture>) {
  f.store.update(f.taskId, {
    phase: 'reviewing', planningBase: lightBase, workspaceIntent: true, agentIntent: true, workspaceId: 'workspace',
    directory: '/worktree', agentId: 'worker-agent', runId: 'worker-run', profile: lightWorker,
    workerModel: lightWorker.model, prHead: lightHead, prUrl: 'https://github.com/example/repo/pull/7',
    completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'worker-ready', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
  });
  return f.task();
}

test('text parsing reads the forbid phrases and the lift phrases, forbid winning mixed wording', () => {
  assert.equal(noAutomaticRetryRule(null), null);
  assert.equal(noAutomaticRetryRule('Continue the approved scope'), null);
  assert.equal(noAutomaticRetryRule('noAutomaticRetry: true'), 'forbid');
  assert.equal(noAutomaticRetryRule('No automatic retry or relaunch on failure'), 'forbid');
  assert.equal(noAutomaticRetryRule('Automatic retries are forbidden here'), 'forbid');
  assert.equal(noAutomaticRetryRule('noAutomaticRetry: false'), 'lift');
  assert.equal(noAutomaticRetryRule('Allow automatic retry from here'), 'lift');
  assert.equal(noAutomaticRetryRule('Automatic retry is permitted for the next round'), 'lift');
  // A mixed instruction keeps the prohibition rather than guessing.
  assert.equal(noAutomaticRetryRule('No automatic retry. Automatic retry is permitted.'), 'forbid');
});

test('the gate reads the durable flag, the pending instruction and the latest owner-instructed run', () => {
  const task = { resolution: { noAutomaticRetry: false, pendingWorkerInstruction: null }, briefVersions: [], brief: null, handoffText: null } as unknown as Task;
  assert.equal(automaticRetryForbidden(task), false);
  assert.equal(automaticRetryForbidden({ ...task, resolution: { ...task.resolution, noAutomaticRetry: true } } as Task), true);
  assert.equal(automaticRetryForbidden({ ...task, resolution: { ...task.resolution, pendingWorkerInstruction: 'No automatic retry on this one' } } as Task), true);
  const runWith = (instruction: string | null) => ({ id: 'r1', instruction }) as unknown as Run;
  // An older row whose launch already cleared the pending instruction still forbids.
  assert.equal(automaticRetryForbidden(task, [runWith('plain continuation'), runWith('No automatic retry or relaunch')]), true);
  // The latest owner-instructed run decides: a permitting follow-up lifts the read.
  assert.equal(automaticRetryForbidden(task, [runWith('No automatic retry'), runWith('Allow automatic retry from here')]), false);
  assert.equal(automaticRetryForbidden(task, [runWith('plain continuation')]), false);
  // A run carrying the prohibition suppresses its own non-delivery detection.
  const dir = mkdtempSync(join(tmpdir(), 'ns-no-retry-run-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  try {
    const inserted = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Task', repoPath: dir,
      planningCommit: lightBase, handoffPath: '', originAgentId: 'origin' }), 'host', 'brief', lightBase);
    const current = store.update(inserted.id, { responsible: true, directory: dir, runId: 'worker-run' }) as Task;
    const completion = { taskId: current.id, runId: 'worker-run', eventId: 'blocked', status: 'blocked', summary: 'No external blocker and no change' } as Completion;
    const run = { id: 'worker-run', role: 'worker', head: lightBase, instruction: 'No automatic retry or relaunch' } as unknown as Run;
    assert.equal(nonDeliveryFor(current, run, completion, []), null);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a move instruction with no-retry records the durable rule, survives the launch clearing, and an owner control lifts it', async () => {
  const f = lightFixture();
  try {
    dispatched(f);
    const moved = await f.engine.performTaskControl(taskControlInputSchema.parse({
      action: 'move', to: 'work', taskId: f.taskId, version: f.task().version,
      reason: 'One-shot native run only',
      instruction: 'Run one read-only preflight. noAutomaticRetry: true. No automatic retry or relaunch (worker/reviewer/recovery/provider/proof) on failure OR completion.',
      caller: CALLER,
    }));
    assert.equal(moved.resolution.noAutomaticRetry, true);
    assert.match(moved.resolution.noAutomaticRetryProvenance ?? '', /move to=work/);
    assert.match(moved.resolution.noAutomaticRetryProvenance ?? '', /owner_control event \d+/);
    // `next` shows the rule with its provenance.
    const shown = f.next();
    assert.equal(shown.noAutomaticRetry, true);
    assert.equal(shown.noAutomaticRetryProvenance, moved.resolution.noAutomaticRetryProvenance);
    // The launch clears the pending instruction; the rule stays in force.
    f.store.update(f.taskId, { resolution: { ...f.task().resolution, pendingWorkerInstruction: null } });
    assert.equal(f.task().resolution.noAutomaticRetry, true);
    assert.equal(automaticRetryForbidden(f.task(), f.store.runs(f.taskId)), true);
    // An unrelated later move without retry wording leaves the rule alone.
    const plain = await f.engine.performTaskControl(taskControlInputSchema.parse({
      action: 'move', to: 'work', taskId: f.taskId, version: f.task().version,
      reason: 'Continue', instruction: 'Keep going on the same branch', caller: CALLER,
    }));
    assert.equal(plain.resolution.noAutomaticRetry, true, 'silence never lifts the rule');
    // A permitting instruction from the owner lifts it.
    const lifted = await f.engine.performTaskControl(taskControlInputSchema.parse({
      action: 'move', to: 'work', taskId: f.taskId, version: f.task().version,
      reason: 'Resume automatic handling',
      instruction: 'The preflight is done; allow automatic retry from here.', caller: CALLER,
    }));
    assert.equal(lifted.resolution.noAutomaticRetry, false);
    assert.equal(lifted.resolution.noAutomaticRetryDecided, true, 'the lift is an explicit owner decision');
    assert.match(lifted.resolution.noAutomaticRetryProvenance ?? '', /move to=work/);
    assert.equal(f.next().noAutomaticRetry, undefined, 'next hides the lifted rule');
    // A structured false lifts it too, after it is set again by a structured true.
    const reset = await f.engine.performTaskControl(taskControlInputSchema.parse({
      action: 'route', role: 'worker', profileId: 'worker', taskId: f.taskId, version: f.task().version,
      reason: 'Stay on the worker route', noAutomaticRetry: true, caller: CALLER,
    }));
    assert.equal(reset.resolution.noAutomaticRetry, true);
    assert.match(reset.resolution.noAutomaticRetryProvenance ?? '', /route role=worker/);
    const cleared = await f.engine.performTaskControl(taskControlInputSchema.parse({
      action: 'route', role: 'worker', profileId: 'worker', taskId: f.taskId, version: f.task().version,
      reason: 'Back to automatic handling', noAutomaticRetry: false, caller: CALLER,
    }));
    assert.equal(cleared.resolution.noAutomaticRetry, false);
    assert.equal(cleared.resolution.noAutomaticRetryDecided, true);
    assert.equal(f.next().noAutomaticRetry, undefined);
  } finally { await f.close(); }
});

test('an explicit lift permits retry even though the superseded run carried the prohibition', async () => {
  const f = lightFixture();
  const runWithInstruction = (instruction: string) => {
    const run = runSchema.parse({
      id: `run-${Math.random().toString(36).slice(2)}`, taskId: f.taskId, role: 'revision', generation: 1,
      head: lightHead, base: lightBase, agentId: 'worker-agent', workspaceId: 'workspace',
      profile: lightWorker, status: 'superseded', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: false, idleSince: null, completion: null, released: true,
      instruction,
    });
    f.store.putRun(run);
    return run;
  };
  try {
    dispatched(f);
    // The owner forbids retry; the launched run carries that instruction.
    await f.engine.performTaskControl(taskControlInputSchema.parse({
      action: 'move', to: 'work', taskId: f.taskId, version: f.task().version,
      reason: 'One-shot native run only',
      instruction: 'Run one read-only preflight. No automatic retry or relaunch on failure OR completion.',
      caller: CALLER,
    }));
    runWithInstruction('Run one read-only preflight. No automatic retry or relaunch on failure OR completion.');
    f.store.update(f.taskId, { resolution: { ...f.task().resolution, pendingWorkerInstruction: null } });
    assert.equal(automaticRetryForbidden(f.task(), f.store.runs(f.taskId)), true);
    // A permitting instruction lifts the rule at the gate, not just on the flag.
    await f.engine.performTaskControl(taskControlInputSchema.parse({
      action: 'move', to: 'work', taskId: f.taskId, version: f.task().version,
      reason: 'Resume automatic handling',
      instruction: 'The preflight is done; allow automatic retry from here.', caller: CALLER,
    }));
    assert.equal(f.task().resolution.noAutomaticRetry, false);
    assert.equal(automaticRetryForbidden(f.task(), f.store.runs(f.taskId)), false,
      'the old no-retry run instruction must not re-forbid retry after the explicit lift');
    // The structured false lifts the same way after the rule is set again.
    await f.engine.performTaskControl(taskControlInputSchema.parse({
      action: 'route', role: 'worker', profileId: 'worker', taskId: f.taskId, version: f.task().version,
      reason: 'Stay on the route', noAutomaticRetry: true, caller: CALLER,
    }));
    assert.equal(automaticRetryForbidden(f.task(), f.store.runs(f.taskId)), true);
    await f.engine.performTaskControl(taskControlInputSchema.parse({
      action: 'route', role: 'worker', profileId: 'worker', taskId: f.taskId, version: f.task().version,
      reason: 'Back to automatic handling', noAutomaticRetry: false, caller: CALLER,
    }));
    assert.equal(automaticRetryForbidden(f.task(), f.store.runs(f.taskId)), false,
      'a structured false is an explicit lift too');
  } finally { await f.close(); }
});

test('the structured flag is only valid for move, restart, route or amend_brief', () => {
  const base = { taskId: 't', version: 1, reason: 'r' };
  assert.equal(taskControlInputSchema.safeParse({ ...base, action: 'move', to: 'work', noAutomaticRetry: true }).success, true);
  assert.equal(taskControlInputSchema.safeParse({ ...base, action: 'restart', noAutomaticRetry: true }).success, true);
  assert.equal(taskControlInputSchema.safeParse({ ...base, action: 'route', role: 'worker', profileId: 'p', noAutomaticRetry: false }).success, true);
  assert.equal(taskControlInputSchema.safeParse({ ...base, action: 'amend_brief', brief: 'text', noAutomaticRetry: true }).success, true);
  const refused = taskControlInputSchema.safeParse({ ...base, action: 'cancel', noAutomaticRetry: true });
  assert.equal(refused.success, false);
});

test('a no-retry route sends a blocked revision to the planner ladder with no reviewer consult', async () => {
  const f = responsibleFixture({ responsible: true });
  try {
    await f.reviews(1);
    await f.engine.performTaskControl(taskControlInputSchema.parse({
      action: 'route', role: 'worker', profileId: 'author', taskId: f.submitted.id, version: f.current().version,
      reason: 'No automatic retry on this task; decide through the planner', caller: 'owner-thread',
    }));
    assert.equal(f.current().resolution.noAutomaticRetry, true);
    await f.engine.wake();
    assert.equal(f.run().role, 'revision');
    const revisionId = f.run().id;
    const revisionSends = f.sends.filter(item => item.role === 'revision').length;
    await f.report('blocked', { summary: 'The isolation gate failed; no external blocker and no change' });
    await f.settle(2);
    assert.equal(f.events('reviewer_consult').length, 0, 'the blocker skips the reviewer consult');
    assert.equal(f.events('planner_escalation').length, 1, 'the kept result escalates to the planner');
    assert.equal(
      f.sends.filter(item => item.role === 'revision').length,
      revisionSends,
      'no automatic revision is dispatched after the refusal',
    );
    assert.equal(f.store.run(revisionId)?.completion?.status, 'blocked', 'the completed result is kept');
  } finally { await f.close(); }
});

/** Record a blocked revision report without advancing, so the test seeds detection evidence first. */
async function reportBlocked(f: ReturnType<typeof responsibleFixture>, summary: string) {
  const active = f.run();
  f.idle(active.agentId!);
  const input = {
    taskId: f.submitted.id, runId: active.id, eventId: randomUUID(), status: 'blocked', summary, head: active.head, prNumber: 1,
  } as Completion;
  assert.equal(f.engine.resolution.complete(input, f.tokens.get(active.id)!).accepted, true);
  return active;
}

test('a no-retry revision suppresses the non-delivery push-back and the provider-routed retry', async () => {
  const seedNonDelivery = (f: ReturnType<typeof responsibleFixture>, runId: string) => {
    f.store.event(f.submitted.id, 'non_delivery', JSON.stringify({
      runId, role: 'revision', status: 'blocked', provider: 'codex', model: 'author',
      baselineHead: head, observedHead: head,
    }));
  };
  // Baseline without the rule: the seeded non-delivery pushes the worker back.
  {
    const f = responsibleFixture({ responsible: true });
    try {
      await f.reviews(1);
      await f.engine.wake();
      assert.equal(f.run().role, 'revision');
      const runId = f.run().id;
      const sendsBefore = f.sends.filter(item => item.role === 'revision').length;
      await reportBlocked(f, 'No external blocker and no change');
      seedNonDelivery(f, runId);
      await f.engine.wake();
      await f.settle(2);
      assert.equal(f.events('non_delivery_pushback').length, 1, 'the baseline still pushes back');
      assert.ok(
        f.sends.filter(item => item.role === 'revision').length > sendsBefore,
        'the baseline re-dispatches the retained worker',
      );
    } finally { await f.close(); }
  }
  // With the rule: no push-back, no routed retry, the result reaches the planner.
  {
    const f = responsibleFixture({ responsible: true });
    try {
      await f.reviews(1);
      await f.engine.wake();
      assert.equal(f.run().role, 'revision');
      const runId = f.run().id;
      await f.engine.performTaskControl(taskControlInputSchema.parse({
        action: 'route', role: 'worker', profileId: 'author', taskId: f.submitted.id, version: f.current().version,
        reason: 'Stay on the route', noAutomaticRetry: true, caller: 'owner-thread',
      }));
      const sendsBefore = f.sends.filter(item => item.role === 'revision').length;
      await reportBlocked(f, 'No external blocker and no change');
      seedNonDelivery(f, runId);
      await f.engine.wake();
      await f.settle(2);
      assert.equal(f.events('non_delivery_pushback').length, 0, 'no push-back under the rule');
      assert.equal(f.events('non_delivery_provider_routed').length, 0, 'no provider-routed retry under the rule');
      assert.equal(
        f.sends.filter(item => item.role === 'revision').length,
        sendsBefore,
        'no automatic revision is dispatched after the refusal',
      );
      assert.equal(f.events('automatic_retry_suppressed').length, 1);
      assert.match(f.events('automatic_retry_suppressed')[0]!.detail, /non_delivery/);
      assert.equal(f.events('planner_escalation').length, 1, 'the kept result escalates to the planner');
      assert.equal(f.store.run(runId)?.completion?.status, 'blocked', 'the completed result is kept');
      const shown = taskNextSchema.parse(ownerTaskNext(collectOwnerVerbFacts(f.store, f.current())));
      assert.equal(shown.noAutomaticRetry, true, 'next still shows the rule after the refusal');
    } finally { await f.close(); }
  }
});

test('a no-retry revision suppresses the unfinished continuation', async () => {
  const f = responsibleFixture({ responsible: true });
  try {
    await f.reviews(1);
    await f.engine.wake();
    assert.equal(f.run().role, 'revision');
    const runId = f.run().id;
    await f.engine.performTaskControl(taskControlInputSchema.parse({
      action: 'route', role: 'worker', profileId: 'author', taskId: f.submitted.id, version: f.current().version,
      reason: 'Stay on the route', noAutomaticRetry: true, caller: 'owner-thread',
    }));
    const sendsBefore = f.sends.filter(item => item.role === 'revision').length;
    await reportBlocked(f, 'Unfinished: the wrapper is still unwritten and no external blocker blocks it');
    f.store.event(f.submitted.id, 'unfinished_continuation', JSON.stringify({
      runId, role: 'revision', status: 'blocked', provider: 'codex', model: 'author',
      baselineHead: head, observedHead: 'c'.repeat(40),
    }));
    await f.engine.wake();
    await f.settle(2);
    assert.equal(f.events('unfinished_pushback').length, 0, 'no unfinished push-back under the rule');
    assert.equal(
      f.sends.filter(item => item.role === 'revision').length,
      sendsBefore,
      'no automatic revision is dispatched after the unfinished refusal',
    );
    assert.equal(f.events('automatic_retry_suppressed').length, 1);
    assert.match(f.events('automatic_retry_suppressed')[0]!.detail, /unfinished/);
    assert.equal(f.events('planner_escalation').length, 1, 'the kept result escalates to the planner');
  } finally { await f.close(); }
});

test('an explicit lift on a legacy row with no durable decision permits retry', async () => {
  const f = lightFixture();
  try {
    dispatched(f);
    // A legacy row: no durable decision, and the superseded run's instruction
    // forbids retry, so the old-run fallback forbids.
    const run = runSchema.parse({
      id: 'run-legacy-noretry', taskId: f.taskId, role: 'revision', generation: 1,
      head: lightHead, base: lightBase, agentId: 'worker-agent', workspaceId: 'workspace',
      profile: lightWorker, status: 'superseded', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: false, idleSince: null, completion: null, released: true,
      instruction: 'Run one read-only preflight. No automatic retry or relaunch on failure OR completion.',
    });
    f.store.putRun(run);
    assert.equal(f.task().resolution.noAutomaticRetryDecided, false);
    assert.equal(automaticRetryForbidden(f.task(), f.store.runs(f.taskId)), true,
      'the old-run fallback forbids retry before any owner decision');
    // An explicit structured lift must persist the decision even though the
    // flag already defaults to false.
    const lifted = await f.engine.performTaskControl(taskControlInputSchema.parse({
      action: 'route', role: 'worker', profileId: 'worker', taskId: f.taskId, version: f.task().version,
      reason: 'Back to automatic handling', noAutomaticRetry: false, caller: CALLER,
    }));
    assert.equal(lifted.resolution.noAutomaticRetry, false);
    assert.equal(lifted.resolution.noAutomaticRetryDecided, true,
      'the lift is recorded even though the flag value is unchanged');
    assert.equal(automaticRetryForbidden(f.task(), f.store.runs(f.taskId)), false,
      'the old no-retry run instruction must not re-forbid retry after the explicit lift');
  } finally { await f.close(); }
});
