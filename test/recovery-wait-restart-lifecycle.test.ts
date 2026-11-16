import { profile } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { occupiesSlot } from '../core/dispatch/capacity';
import { liveNoopSummary } from '../core/recovery/live-noop';
import { NO_RESOLUTION_RUN_REFUSAL } from '../core/verbs/verb-refusal-text';
import {
  runSchema, submissionSchema, taskControlInputSchema, type Completion, type Run, type Task,
} from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';

/**
 * nucleus#1278: recovery stands down on a live task, a planner wait on a
 * recovery escalation resumes ordinary next when it ends, and owner restart
 * keeps the task's slot. Fixtures copy the stored escalation / run / event
 * shapes from a721bbcc, baaa2daa and fedca2e8 with synthetic IDs.
 */

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const worker = profile('worker', 'test/worker');
const reviewer = profile('reviewer', 'test/reviewer');
const coordinator = profile('coordinator', 'test/coordinator');
// The wall-clock budget charges run starts against a 180-minute default limit:
// pin the fixture's activity a few minutes ago so the limit never exhausts
// mid-test, however long after 2026-11-16 the file runs (nucleus#1268). Fixed
// timestamps aged past the limit, and the launch's correct budget park fenced
// the restart hold the slot tests assert, failing 4 pass / 3 fail with no
// code change.
const lastActivity = new Date(Date.now() - 5 * 60 * 1000).toISOString();

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-1258-lifecycle-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  store.setMeta('globalLimit', 1);
  store.setMeta('projectLimit', 1);
  store.setMeta('pool', [
    { profileId: worker.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] },
    { profileId: reviewer.id, enabled: true, group: 'review', roles: ['reviewer'], weight: 1, scopes: ['general'] },
    { profileId: coordinator.id, enabled: true, group: 'coordinate', roles: ['coordinator'], weight: 1, scopes: ['general'] },
  ]);
  const submitted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Live recovery wait restart', repoPath: '/repo', planningCommit: base,
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', base);
  store.update(submitted.id, {
    phase: 'reviewing', planningBase: base, workspaceIntent: true, agentIntent: true, workspaceId: 'workspace',
    directory: '/worktree', agentId: 'worker', runId: 'worker-run', profile: worker, workerModel: worker.model,
    prHead: head, prUrl: 'https://github.com/example/repo/pull/7', responsible: true,
    completion: { taskId: submitted.id, runId: 'worker-run', eventId: 'worker-ready', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
  }, 'dispatched');
  const reviewerRun = (id: string, agentId: string, patch: Partial<Run> = {}): Run => runSchema.parse({
    id, taskId: submitted.id, role: 'reviewer', generation: 1, head, base, agentId, workspaceId: 'workspace',
    profile: reviewer, status: 'running', createdAt: lastActivity, briefVersion: submitted.briefVersions.at(-1)?.version ?? null,
    lastObservedAt: lastActivity, active: true, idleSince: null, completion: null, released: false, ...patch,
  });
  const tokens = new Map<string, string>([['reviewer-token', 'reviewer-token']]);
  store.putRun(reviewerRun('review-run', 'review-agent'));
  store.setCredential('review-run', 'reviewer-token');
  store.update(submitted.id, { resolution: { ...store.task(submitted.id).resolution, currentRunId: 'review-run', reviewerAgentId: 'review-agent', reviewerProfile: reviewer } });

  const states = new Map<string, AgentObservation>([
    ['worker', { id: 'worker', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '', provider: 'test', model: worker.model }],
    ['review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '', provider: 'test', model: reviewer.model, activeTurnId: 'turn-1' }],
  ]);
  const createdRuns: Run[] = [];
  const adapter = {
    profiles: async () => [worker, reviewer, coordinator], validate: async () => base,
    createWorkspace: async () => { throw new Error('fixtures do not create workspaces'); },
    findWorkspaces: async () => [], findAgents: async () => [], findRunAgents: async () => [],
    createAgent: async () => { throw new Error('fixtures do not create agents'); },
    observe: async (id: string) => states.get(id) ?? { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' },
    archiveAgent: async () => {}, notify: async () => {},
    originAgent: async (id: string) => ({ id, workspaceId: 'workspace', title: id, archived: false }),
    stopAgentTurn: async (id: string) => {
      const state = states.get(id);
      if (state) states.set(id, { ...state, active: false, status: 'idle', activeTurnId: undefined });
    },
    verifyPr: async () => ({ url: 'https://github.com/example/repo/pull/7', head: store.task(submitted.id).prHead ?? head }),
    verifyPrIdentity: async () => ({ url: 'https://github.com/example/repo/pull/7', head: store.task(submitted.id).prHead ?? head, repository: 'example/repo', headRepository: 'example/repo' }),
    verifyCleanQueueWorktree: async () => {}, verifyReview: async () => {},
    mergeGate: async () => ({ head, base, wait: '' }), merge: async () => {},
    merged: async () => ({ merged: false, commit: null, head, base: 'main' }),
    syncMain: async () => head, verifyCloseout: async () => {},
    createRun: async (_t: Task, r: Run, token: string) => {
      createdRuns.push(r); tokens.set(r.id, token);
      const id = `agent-${r.id}`;
      states.set(id, { id, workspaceId: r.workspaceId, status: 'running', active: true, permissions: false, error: '' });
      return { id, workspaceId: r.workspaceId };
    },
    sendRun: async (_t: Task, r: Run, token: string) => {
      createdRuns.push(r); tokens.set(r.id, token);
      if (r.agentId) states.set(r.agentId, { ...(states.get(r.agentId) ?? { id: r.agentId, workspaceId: r.workspaceId, permissions: false, error: '' }), active: true, status: 'running' });
    },
    supportsCoordinatorRecovery: true,
  } as unknown as Adapter & { supportsCoordinatorRecovery?: boolean };
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [worker, reviewer, coordinator];
  return {
    dir, store, engine, adapter, submitted, tokens, states, createdRuns, reviewerRun,
    current: () => store.task(submitted.id),
    events: (kind: string) => store.eventsAll(submitted.id).filter(event => event.kind === kind),
    coordinatorRuns: () => store.runs(submitted.id).filter(item => item.role === 'recovery'),
    idle: (id: string) => {
      const state = states.get(id);
      if (state) states.set(id, { ...state, active: false, status: 'idle', activeTurnId: undefined });
    },
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('recovery observes a live reviewer and reports the no-op; no escalation and no second recovery while the reviewer stays active', async () => {
  const f = fixture();
  try {
    // Stall-shaped: the reviewer run still occupies the slot, but the host
    // observation is idle so recovery can lease and launch. The papercut is
    // the coordinator finding that occupant live after launch.
    f.idle('review-agent');
    f.store.update(f.submitted.id, {
      reason: 'Stalled turn recorded',
      resolution: { ...f.current().resolution, attention: true },
    });
    await f.engine.resolution.recovery.route(f.current());
    await f.engine.quiesce();
    const recovery = f.coordinatorRuns().at(-1);
    assert.ok(recovery, `recovery launched to observe the live reviewer; stop=${f.current().resolution.stop?.reason ?? 'none'} reason=${f.current().reason}`);
    const live = f.store.run('review-run')!;
    const summary = liveNoopSummary(live);
    f.idle(recovery.agentId!);
    f.states.set('review-agent', {
      id: 'review-agent', workspaceId: 'workspace', status: 'running', active: true,
      permissions: false, error: '', provider: 'test', model: reviewer.model, activeTurnId: 'turn-1',
    });
    f.engine.resolution.complete({
      eventId: randomUUID(), taskId: f.submitted.id, runId: recovery.id, status: 'recovered', summary,
      coordinatorGeneration: recovery.generation,
    } as Completion, f.tokens.get(recovery.id)!);
    await f.engine.resolution.recovery.pass(f.submitted.id);
    assert.equal(f.events('planner_escalation').length, 0, 'live no-op opens no planner escalation');
    assert.equal(f.current().resolution.recovery?.status, 'resolved');
    assert.match(f.current().resolution.recovery?.summary ?? '', /^live: reviewer is working, last activity /);
    assert.match(f.current().reason, /reviewer thread running/);
    assert.notEqual(f.current().resolution.stop?.reason, 'escalated');
    assert.equal(f.current().resolution.attention, false);
    const count = f.coordinatorRuns().length;
    await f.engine.resolution.recovery.route(f.current());
    await f.engine.quiesce();
    assert.equal(f.coordinatorRuns().length, count, 'no second recovery while the reviewer stays active');
  } finally { await f.close(); }
});

for (const scenario of [
  "active turn",
  "advancing activity",
  "initial worker",
  "slot wait",
  "prerequisite wait",
] as const) {
  test(`a blocked recovery report on ${scenario} settles without an escalation or phase change`, async () => {
    const f = fixture();
    try {
      f.idle("review-agent");
      f.store.update(f.submitted.id, {
        reason: "Stalled turn recorded",
        resolution: { ...f.current().resolution, attention: true },
      });
      await f.engine.resolution.recovery.route(f.current());
      await f.engine.quiesce();
      const recovery = f.coordinatorRuns().at(-1)!;
      assert.ok(recovery);
      f.idle(recovery.agentId!);
      f.states.set("review-agent", {
        ...f.states.get("review-agent")!,
        active: true,
        status: "running",
        activeTurnId: "turn-1",
      });
      if (scenario === "advancing activity") {
        f.store.putRun({ ...f.store.run("review-run")!, active: false });
        f.states.set("review-agent", {
          ...f.states.get("review-agent")!,
          active: false,
          activeTurnId: null,
          updatedAt: new Date().toISOString(),
        });
      } else if (scenario !== "active turn") {
        f.store.putRun({
          ...f.store.run("review-run")!,
          released: true,
          active: false,
        });
        f.idle("review-agent");
        if (scenario === "initial worker") {
          f.store.update(f.submitted.id, {
            phase: "working",
            completion: null,
            agentActive: false,
            resolution: { ...f.current().resolution, currentRunId: null },
          });
          f.states.set("worker", {
            ...f.states.get("worker")!,
            active: true,
            status: "running",
            activeTurnId: "worker-turn",
          });
        } else {
          f.store.update(f.submitted.id, {
            phase: "awaiting_review",
            resolution: { ...f.current().resolution, currentRunId: null },
          });
          const other = f.store.insert(
            submissionSchema.parse({
              submissionId: randomUUID(),
              title: "Synthetic prerequisite or occupant",
              repoPath: "/repo",
              planningCommit: base,
              brief: { text: "Synthetic" },
              originAgentId: "origin",
            }),
            "host",
            "brief",
            base,
          );
          if (scenario === "slot wait")
            f.store.update(other.id, {
              phase: "working",
              agentActive: true,
              agentId: "other-worker",
            });
          else
            f.store.update(f.submitted.id, {
              prerequisiteWait: {
                id: randomUUID(),
                waitsFor: [other.id],
                reason: "Waiting for synthetic prerequisite",
                releasedAt: null,
              },
            });
        }
      }
      const phase = f.current().phase;
      f.engine.resolution.complete(
        {
          eventId: randomUUID(),
          taskId: f.submitted.id,
          runId: recovery.id,
          status: "blocked",
          summary: "No justified recovery verb",
          coordinatorAction: {
            verb: "cannot",
            reason: "No justified recovery verb",
          },
          coordinatorGeneration: recovery.generation,
        },
        f.tokens.get(recovery.id)!,
      );
      await f.engine.resolution.recovery.pass(f.submitted.id);
      assert.equal(f.events("planner_escalation").length, 0);
      assert.equal(f.current().resolution.recovery?.status, "resolved");
      assert.equal(f.current().phase, phase);
      assert.match(
        f.events("recovery_live_noop").at(-1)?.detail ?? "",
        /recovery: task live, nothing to do/,
      );
      assert.equal(f.current().resolution.attention, false);
      if (scenario === "slot wait" || scenario === "prerequisite wait")
        assert.equal(
          f.current().resolution.stop?.reason,
          scenario === "slot wait" ? "capacity" : "prerequisite",
        );
      const count = f.coordinatorRuns().length;
      await f.engine.resolution.recovery.route(f.current());
      await f.engine.quiesce();
      assert.equal(
        f.coordinatorRuns().length,
        count,
        "healthy work does not start another recovery",
      );
    } finally {
      await f.close();
    }
  });
}

test('recovered without action and no live participant is refused; the stop is not cleared', async () => {
  const f = fixture();
  try {
    f.store.putRun({ ...f.store.run('review-run')!, released: true, active: false, status: 'finished' });
    f.idle('review-agent');
    f.store.update(f.submitted.id, {
      phase: 'blocked',
      reason: 'Worker blocked: tests red',
      resolution: {
        ...f.current().resolution,
        currentRunId: null,
        attention: true,
        stop: {
          reason: 'operator_needed', detail: 'Worker blocked: tests red', since: lastActivity,
          suggestedVerbs: ['restart', 'route', 'move'],
        },
      },
    });
    await f.engine.resolution.recovery.route(f.current());
    await f.engine.quiesce();
    const recovery = f.coordinatorRuns().at(-1);
    assert.ok(recovery, `recovery launched; stop=${f.current().resolution.stop?.reason ?? 'none'} reason=${f.current().reason}`);
    f.idle(recovery.agentId!);
    f.engine.resolution.complete({
      eventId: randomUUID(), taskId: f.submitted.id, runId: recovery.id, status: 'recovered',
      summary: 'Nothing to do', coordinatorGeneration: recovery.generation,
    } as Completion, f.tokens.get(recovery.id)!);
    await f.engine.resolution.recovery.pass(f.submitted.id);
    assert.ok(f.current().resolution.stop, 'no-live recovered-without-action must not clear the stop');
    assert.notEqual(f.current().resolution.recovery?.action?.status, 'applied');
    const refused = f.current().resolution.recovery?.action?.status === 'refused'
      || f.current().resolution.recovery?.status === 'escalated'
      || f.events('planner_escalation').length > 0;
    assert.ok(refused, JSON.stringify({
      recovery: f.current().resolution.recovery,
      stop: f.current().resolution.stop,
      escalations: f.events('planner_escalation').map(event => event.detail.slice(0, 160)),
    }));
  } finally { await f.close(); }
});

/** nucleus#1217: released reviewer, empty currentRunId, raising recovery gone, timed wait due. */
function load1217Wait(
  f: ReturnType<typeof fixture>,
  kind: "time" | "task" = "time",
) {
  const recoveryId = "recovery-1217";
  const escalationId = "c".repeat(64);
  const target = "2020-01-01T00:00:00.000Z";
  const stopDetail = `Escalation ${escalationId}: waiting until ${target}`;
  const waitId = randomUUID();
  let prerequisite: Task | null = null;
  if (kind === "task") {
    prerequisite = f.store.insert(
      submissionSchema.parse({
        submissionId: randomUUID(),
        title: "Synthetic wait target",
        repoPath: "/upstream",
        planningCommit: base,
        brief: { text: "Synthetic" },
        originAgentId: "origin",
      }),
      "host",
      "brief",
      base,
    );
    f.store.update(prerequisite.id, { phase: "done" });
  }
  f.store.putRun({ ...f.store.run('review-run')!, released: true, active: false, status: 'finished', completion: null });
  f.idle('review-agent');
  f.store.putRun(runSchema.parse({
    id: recoveryId, taskId: f.submitted.id, role: 'recovery', generation: 1, head, base,
    agentId: 'coord-1217', workspaceId: 'workspace', profile: coordinator, status: 'finished',
    createdAt: lastActivity, lastObservedAt: lastActivity, active: false, idleSince: lastActivity,
    completion: { eventId: 'esc-report', taskId: f.submitted.id, runId: recoveryId, status: 'blocked', summary: 'no justified recovery verb' },
    released: true,
    active: false,
    status: "finished",
    completion: null,
  });
  f.idle("review-agent");
  f.store.putRun(
    runSchema.parse({
      id: recoveryId,
      taskId: f.submitted.id,
      role: "recovery",
      generation: 1,
      head,
      base,
      agentId: "coord-1217",
      workspaceId: "workspace",
      profile: coordinator,
      status: "finished",
      createdAt: lastActivity,
      lastObservedAt: lastActivity,
      active: false,
      idleSince: lastActivity,
      completion: {
        eventId: "esc-report",
        taskId: f.submitted.id,
        runId: recoveryId,
        status: "blocked",
        summary: "no justified recovery verb",
      },
      released: true,
    }),
  );
  f.store.event(
    f.submitted.id,
    "planner_escalation",
    `${escalationId}: cause ${"d".repeat(64)}; run ${recoveryId}; question ${"e".repeat(64)} (80 chars); options Restart | Wait until a time`,
  );
  f.store.event(
    f.submitted.id,
    "planner_escalation_payload",
    `${escalationId}: ${JSON.stringify({ id: escalationId, runId: recoveryId, question: "How should the task proceed?" })}`,
  );
  f.store.event(
    f.submitted.id,
    "planner_escalation_answered",
    `${escalationId}: answered by planner-1: Choice: Wait until a time\nReason: ${target}`,
  );
  f.store.event(
    f.submitted.id,
    "planner_escalation_applied",
    `${escalationId}: waiting until ${target}`,
  );
  f.store.event(
    f.submitted.id,
    "planner_escalation_wait",
    `${escalationId}: ${JSON.stringify({ kind, target: prerequisite?.id ?? target, ...(prerequisite ? { waitId } : {}), stopDetail, stopReason: "lifecycle" })}`,
  );
  f.store.update(f.submitted.id, {
    phase: "blocked",
    ...(prerequisite
      ? {
          prerequisiteWait: {
            id: waitId,
            waitsFor: [prerequisite.id],
            reason: "Waiting for synthetic target",
            releasedAt: null,
          },
        }
      : {}),
    reason: stopDetail,
    resolution: {
      ...f.current().resolution,
      currentRunId: null,
      attention: true,
      stop: { reason: 'lifecycle', detail: stopDetail, since: lastActivity, suggestedVerbs: [] },
      recovery: {
        id: 'episode-1217', key: 'blocked-live', generation: 1, runId: recoveryId, agentId: 'coord-1217',
        status: 'escalated', summary: 'no justified recovery verb', idleSince: null, incidentId: null, progress: null,
      },
    },
  });
  return { recoveryId, escalationId };
}

for (const kind of ["time", "task"] as const) {
  test(`a ${kind} wait on a recovery escalation whose raising run has released wakes into the ordinary next step`, async () => {
    const f = fixture();
    try {
      load1217Wait(f, kind);
      const recoveriesBefore = f.coordinatorRuns().length;
      await f.engine.resolution.ladder.resumeEscalationWaits(f.current());
      assert.equal(
        f.events("planner_escalation_wake_refused").length,
        0,
        f
          .events("planner_escalation_wake_refused")
          .map((event) => event.detail)
          .join("\n") || "no refusal",
      );
      assert.equal(
        f.events("planner_escalation_woke").length,
        1,
        JSON.stringify(
          f.store
            .eventsAll(f.submitted.id)
            .map((event) => ({
              kind: event.kind,
              detail: event.detail.slice(0, 160),
            })),
        ),
      );
      const woke = f.events("planner_escalation_woke").at(-1)?.detail ?? "";
      assert.doesNotMatch(woke, new RegExp(NO_RESOLUTION_RUN_REFUSAL));
      assert.match(woke, /ordinary restart/, woke);
      assert.doesNotMatch(f.current().reason, /wake was refused/);
      assert.equal(
        f.current().phase,
        "awaiting_review",
        `ordinary next must resume review; phase=${f.current().phase} reason=${f.current().reason}`,
      );
      await f.engine.wake();
      assert.equal(
        f.coordinatorRuns().length,
        recoveriesBefore,
        `wake must not start another recovery; runs=${f
          .coordinatorRuns()
          .map((run) => run.id)
          .join(",")}`,
      );
    } finally {
      await f.close();
    }
  });

  test(`a ${kind} wait whose retained reviewer is closed resumes recovery without replacing that reviewer`, async () => {
    const f = fixture();
    try {
      load1217Wait(f, kind);
      f.states.set("review-agent", {
        id: "review-agent",
        workspaceId: "workspace",
        status: "closed",
        active: false,
        permissions: false,
        error: "",
        provider: "test",
        model: reviewer.model,
      });
      const recoveriesBefore = f.coordinatorRuns().length;
      const reviewerRunsBefore = f.store
        .runs(f.submitted.id)
        .filter((run) => run.role === "reviewer")
        .map((run) => run.id);
      await f.engine.resolution.ladder.resumeEscalationWaits(f.current());
      assert.equal(
        f.events("planner_escalation_wake_refused").length,
        0,
        f
          .events("planner_escalation_wake_refused")
          .map((event) => event.detail)
          .join("\n") || "no refusal",
      );
      assert.equal(
        f.events("planner_escalation_woke").length,
        1,
        JSON.stringify(
          f.store
            .eventsAll(f.submitted.id)
            .map((event) => ({
              kind: event.kind,
              detail: event.detail.slice(0, 160),
            })),
        ),
      );
      const woke = f.events("planner_escalation_woke").at(-1)?.detail ?? "";
      assert.doesNotMatch(woke, /ordinary restart/, woke);
      assert.match(woke, /ordinary recovery/, woke);
      assert.doesNotMatch(f.current().reason, /wake was refused/);
      assert.notEqual(
        f.current().phase,
        "awaiting_review",
        `closed reviewer must not be replaced; phase=${f.current().phase} reason=${f.current().reason}`,
      );
      assert.equal(f.current().resolution.reviewerAgentId, "review-agent");
      await f.engine.quiesce();
      assert.ok(
        f.coordinatorRuns().length > recoveriesBefore,
        "a fresh recovery owns the remaining fault",
      );
      await f.engine.wake();
      assert.equal(
        f.coordinatorRuns().length,
        recoveriesBefore + 1,
        "one recovery resumes the ended wait",
      );
      const reviewerRuns = f.store
        .runs(f.submitted.id)
        .filter((run) => run.role === "reviewer")
        .map((run) => run.id);
      assert.deepEqual(
        reviewerRuns,
        reviewerRunsBefore,
        "wake must not start a fresh reviewer",
      );
      assert.equal(
        f.createdRuns.filter((run) => run.role === "reviewer").length,
        0,
      );
    } finally {
      await f.close();
    }
  });
}

for (const occupant of ["reviewer", "recovery"] as const) {
  test(`reviewer restart keeps the task slot held by ${occupant} and returns to reviewing ahead of queued work`, async () => {
    const f = fixture();
    try {
      f.store.putRun({ ...f.store.run("review-run")!, active: null });
      f.states.set("review-agent", {
        id: "review-agent",
        workspaceId: "workspace",
        status: "idle",
        active: false,
        permissions: false,
        error: "",
        provider: "test",
        model: reviewer.model,
      });
      if (occupant === "recovery") {
        f.store.putRun({ ...f.store.run("review-run")!, active: false });
        f.store.update(f.submitted.id, {
          reason: "Reviewer provider failure",
          resolution: { ...f.current().resolution, attention: true },
        });
        await f.engine.resolution.recovery.route(f.current());
        await f.engine.quiesce();
        assert.ok(f.coordinatorRuns().at(-1));
      }
      const holding = f.current();
      assert.equal(
        occupiesSlot(holding, f.store.runs(holding.id)),
        true,
        "the reviewer run holds the only slot",
      );
      const queued = f.store.insert(
        submissionSchema.parse({
          submissionId: randomUUID(),
          title: "Queued behind the live review",
          repoPath: "/repo",
          planningCommit: base,
          handoffPath: "handoff.md",
          originAgentId: "origin",
        }),
        "host",
        "handoff",
        base,
      );
      assert.match(
        f.engine.resolution.slotAdmissionReason(f.store.task(queued.id)),
        /1\/1 occupied/,
        "the queued task waits behind the slot-holding review",
      );
      await f.engine.performTaskControl(
        taskControlInputSchema.parse({
          taskId: holding.id,
          version: holding.version,
          action: "restart",
          role: "reviewer",
          reason: "Owner restart of the idle reviewer",
          caller: "owner-thread",
        }),
      );
      const restarted = f.store.task(holding.id);
      assert.equal(
        occupiesSlot(restarted, f.store.runs(restarted.id)),
        true,
        "restart keeps the task's slot",
      );
      assert.equal(f.store.task(queued.id).phase, "queued");
      assert.match(
        f.engine.resolution.slotAdmissionReason(f.store.task(queued.id)),
        /1\/1 occupied/,
        "the queued task does not take the restarted task's slot",
      );
      await f.engine.wake();
      assert.equal(
        occupiesSlot(f.store.task(holding.id), f.store.runs(holding.id)),
        true,
      );
      assert.equal(f.store.task(queued.id).phase, "queued");
      assert.equal(f.current().phase, "reviewing", f.current().reason);
      assert.equal(
        f.current().resolution.restartSlotHold,
        null,
        "the new reviewer consumed the task slot hold",
      );
    } finally {
      await f.close();
    }
  });
}

test('a fenced restart hold does not keep the slot', async () => {
  const f = fixture();
  try {
    f.store.putRun({ ...f.store.run('review-run')!, active: null });
    f.states.set('review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '', provider: 'test', model: reviewer.model });
    const holding = f.current();
    const queued = f.store.insert(submissionSchema.parse({
      submissionId: randomUUID(), title: 'Queued behind a fenced restart', repoPath: '/repo', planningCommit: base,
      handoffPath: 'handoff.md', originAgentId: 'origin',
    }), 'host', 'handoff', base);
    await f.engine.performTaskControl(taskControlInputSchema.parse({
      taskId: holding.id, version: holding.version, action: 'restart', role: 'reviewer',
      reason: 'Owner restart of the idle reviewer', caller: 'owner-thread',
    }));
    const restarted = f.store.task(holding.id);
    assert.ok(restarted.resolution.restartSlotHold, 'restart wrote a slot hold');
    assert.equal(occupiesSlot(restarted, f.store.runs(restarted.id)), true);
    f.store.update(restarted.id, {
      held: true,
      holds: { dispatch: { owner: 'operator', reason: 'Dispatch held', at: lastActivity, generation: 1, until: null } },
    });
    const fenced = f.store.task(restarted.id);
    assert.equal(occupiesSlot(fenced, f.store.runs(fenced.id)), false, 'a fenced restart hold occupies no slot');
    assert.doesNotMatch(f.engine.resolution.slotAdmissionReason(f.store.task(queued.id)), /1\/1 occupied/,
      f.engine.resolution.slotAdmissionReason(f.store.task(queued.id)));
  } finally { await f.close(); }
});

for (const occupant of ["worker", "recovery"] as const) {
  test(`worker restart keeps the task slot held by ${occupant} while another task is queued`, async () => {
    const f = fixture();
    try {
      f.store.putRun({
        ...f.store.run("review-run")!,
        released: true,
        active: false,
        status: "finished",
      });
      f.idle("review-agent");
      f.store.putRun(
        runSchema.parse({
          id: "revision-run",
          taskId: f.submitted.id,
          role: "revision",
          generation: 1,
          head,
          base,
          agentId: "worker",
          workspaceId: "workspace",
          profile: worker,
          status: "running",
          createdAt: lastActivity,
          briefVersion: f.submitted.briefVersions.at(-1)?.version ?? null,
          lastObservedAt: lastActivity,
          active: null,
          idleSince: lastActivity,
          completion: null,
          released: false,
        }),
      );
      f.store.update(f.submitted.id, {
        phase: "changes_requested",
        reason: "Idle worker",
        agentActive: false,
        lastAgentStatus: "idle",
        resolution: {
          ...f.current().resolution,
          currentRunId: "revision-run",
          reviewerAgentId: null,
          reviewerProfile: null,
        },
      });
      if (occupant === "recovery") {
        f.store.putRun({ ...f.store.run("revision-run")!, active: false });
        f.store.update(f.submitted.id, {
          reason: "Worker provider failure",
          resolution: { ...f.current().resolution, attention: true },
        });
        await f.engine.resolution.recovery.route(f.current());
        await f.engine.quiesce();
        assert.ok(f.coordinatorRuns().at(-1));
      }
      const holding = f.current();
      assert.equal(
        occupiesSlot(holding, f.store.runs(holding.id)),
        true,
        "the idle revision run holds the only slot",
      );
      const queued = f.store.insert(
        submissionSchema.parse({
          submissionId: randomUUID(),
          title: "Queued behind the idle worker",
          repoPath: "/repo",
          planningCommit: base,
          handoffPath: "handoff.md",
          originAgentId: "origin",
        }),
        "host",
        "handoff",
        base,
      );
      assert.match(
        f.engine.resolution.slotAdmissionReason(f.store.task(queued.id)),
        /1\/1 occupied/,
        "the queued task waits behind the slot-holding worker",
      );
      await f.engine.performTaskControl(
        taskControlInputSchema.parse({
          taskId: holding.id,
          version: holding.version,
          action: "restart",
          role: "worker",
          reason: "Owner restart of the idle worker",
          caller: "owner-thread",
        }),
      );
      const restarted = f.store.task(holding.id);
      assert.equal(
        occupiesSlot(restarted, f.store.runs(restarted.id)),
        true,
        "worker restart keeps the task's slot",
      );
      assert.equal(f.store.task(queued.id).phase, "queued");
      assert.match(
        f.engine.resolution.slotAdmissionReason(f.store.task(queued.id)),
        /1\/1 occupied/,
        "the queued task does not take the restarted worker's slot",
      );
    } finally {
      await f.close();
    }
    const holding = f.current();
    assert.equal(occupiesSlot(holding, f.store.runs(holding.id)), true, 'the idle revision run holds the only slot');
    const queued = f.store.insert(submissionSchema.parse({
      submissionId: randomUUID(), title: 'Queued behind the idle worker', repoPath: '/repo', planningCommit: base,
      handoffPath: 'handoff.md', originAgentId: 'origin',
    }), 'host', 'handoff', base);
    assert.match(f.engine.resolution.slotAdmissionReason(f.store.task(queued.id)), /1\/1 occupied/,
      'the queued task waits behind the slot-holding worker');
    await f.engine.performTaskControl(taskControlInputSchema.parse({
      taskId: holding.id, version: holding.version, action: 'restart', role: 'worker',
      reason: 'Owner restart of the idle worker', caller: 'owner-thread',
    }));
    const restarted = f.store.task(holding.id);
    assert.equal(occupiesSlot(restarted, f.store.runs(restarted.id)), true, 'worker restart keeps the task\'s slot');
    assert.equal(f.store.task(queued.id).phase, 'queued');
    assert.match(f.engine.resolution.slotAdmissionReason(f.store.task(queued.id)), /1\/1 occupied/,
      'the queued task does not take the restarted worker\'s slot');
  } finally { await f.close(); }
});
}

test("a blocked recovery report on an idle fault still escalates", async () => {
  const f = fixture();
  try {
    f.idle("review-agent");
    f.store.update(f.submitted.id, {
      reason: "Unresolved environment fault",
      resolution: { ...f.current().resolution, attention: true },
    });
    await f.engine.resolution.recovery.route(f.current());
    await f.engine.quiesce();
    const recovery = f.coordinatorRuns().at(-1)!;
    assert.ok(recovery);
    f.idle(recovery.agentId!);
    f.engine.resolution.complete(
      {
        eventId: randomUUID(),
        taskId: f.submitted.id,
        runId: recovery.id,
        status: "blocked",
        summary: "Required tool is missing",
        coordinatorAction: {
          verb: "cannot",
          reason: "Required tool is missing",
        },
        coordinatorGeneration: recovery.generation,
      },
      f.tokens.get(recovery.id)!,
    );
    await f.engine.resolution.recovery.pass(f.submitted.id);
    assert.equal(f.events("recovery_live_noop").length, 0);
    assert.equal(f.events("planner_escalation").length, 1);
  } finally {
    await f.close();
  }
});
