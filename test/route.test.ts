import { fakeAdapter } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { chooseProfile } from '../core/dispatch/routing';
import { submissionSchema, reviewEntryRecordSchema, runSchema, taskControlInputSchema, type Profile, type Run } from '../shared/contracts';
import type { Adapter } from '../core/host';
import type { ResolutionAdapter } from '../core/resolution';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { Decisions } from '../core/planning/decisions';
import { reconcileRoutingSignoffs, SIGNOFF_DECLINE, signoffApprove } from '../core/dispatch/routing-signoff';

/**
 * Spec 050 `route`: an owner points one role's next run at a named profile on
 * a live task, before or after dispatch. The route lands on `profileRequests`,
 * the field the existing selection path reads; a matching worker exclusion is
 * lifted; a reviewer on an author model is honoured with a recorded waiver;
 * and `now` stops and replaces the role's live run without losing the PR or
 * head. Every control writes one `owner_control` event.
 */

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const CALLER = 'owner-thread';

type Role = 'worker' | 'reviewer' | 'coordinator';
const profile = (id: string, model: string, roles: Role[] = ['worker'], group?: string,
  rating: { capability?: 'low' | 'frontier'; cost?: 'very_low' | 'very_high' } = {}) => ({
  profile: { id, name: id, provider: 'test', model, notes: '', available: true, problem: '', supportedThinking: ['low'] } as Profile,
  entry: { profileId: id, enabled: true, group: group ?? id, roles, weight: 1, scopes: ['general'] as const, ...rating },
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-route-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const author = profile('author', 'author-model', ['worker', 'reviewer']);
  const sol = profile('sol', 'sol-model', ['worker']);
  const luna = profile('luna', 'luna-model', ['reviewer']);
  const authorrev = profile('authorrev', 'author-model', ['reviewer']);
  // Spec 053: the rating, not the role switch, keeps coord to coordinator demand.
  const coord = profile('coord', 'coord-model', ['coordinator'], undefined, { capability: 'low', cost: 'very_low' });
  // Spec 052: a frontier profile automatic selection never lands on below Maximum (task 577 routes to it).
  const nova = profile('nova', 'nova-model', ['worker'], undefined, { cost: 'very_high', capability: 'frontier' });
  const all = [author, sol, luna, authorrev, coord, nova];
  store.setMeta('pool', all.map(item => item.entry));
  const submitted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Route me', repoPath: '/repo', planningCommit: base,
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', base);
  const task = store.update(submitted.id, {
    phase: 'needs_attention', reason: 'Between runs', workspaceId: 'workspace', directory: '/worktree',
    agentId: 'worker', runId: 'initial', profile: author.profile, workerModel: author.profile.model,
    workerModels: [author.profile.model], prHead: head, prUrl: 'https://github.com/example/repo/pull/1',
    completion: { taskId: submitted.id, runId: 'initial', eventId: 'initial-result', status: 'ready_for_review', summary: 'Ready', prNumber: 1 },
  });
  const observations = new Map<string, { id: string; workspaceId: string; status: string; active: boolean; permissions: boolean; error: string; activeTurnId?: string }>();
  const idle = (id: string, workspaceId = 'workspace') => observations.set(id, { id, workspaceId, status: 'idle', active: false, permissions: false, error: '' });
  idle('worker');
  const stops: string[] = [];
  const agentPrompts: string[] = [], runPrompts: string[] = [], creates: Run[] = [];
  const archived = new Set<string>();
  const adapter: Adapter & ResolutionAdapter = fakeAdapter({
    profiles: async () => all.map(item => item.profile),
    validate: async () => base, verifyWorkspace: async () => task.branch,
    createWorkspace: async () => { throw new Error('No workspace creation in route fixtures'); },
    createAgent: async (t, token, mcpPrompt) => {
      agentPrompts.push(String(mcpPrompt));
      const id = `agent-${t.profile!.id}`;
      observations.set(id, { id, workspaceId: t.workspaceId!, status: 'running', active: true, permissions: false, error: '' });
      return { id, workspaceId: t.workspaceId! };
    },
    observe: async id => { const state = observations.get(id); if (!state) throw new Error('Agent missing'); return state as never; }, originAgent: async (id: string) => ({ id, workspaceId: 'workspace', title: id, archived: archived.has(id) }),
    archiveAgent: async (id: string) => { archived.add(id); },
    verifyPr: async () => ({ head, url: task.prUrl! }), verifyPrIdentity: async () => ({ head, url: task.prUrl! }), verifyCleanQueueWorktree: async () => {},
    verifyResume: async () => {},
    stopAgentTurn: async (id: string) => { stops.push(id); const state = observations.get(id); if (state) { state.active = false; state.status = 'idle'; delete state.activeTurnId; } },
    createRun: async (t, r, token) => {
      creates.push(r);
      runPrompts.push(JSON.stringify({ runId: r.id, role: r.role, profile: r.profile?.id, reason: r.reviewReason }));
      const id = `agent-${r.id}`; observations.set(id, { id, workspaceId: r.workspaceId, status: 'running', active: true, permissions: false, error: '' });
      return { id, workspaceId: r.workspaceId };
    },
    sendRun: async () => {}, findRunAgents: async () => [],
    verifyReview: async () => {}, mergeGate: async () => ({ head, base, wait: '' }), merge: async () => {},
    merged: async () => ({ merged: false, commit: null, head, base: 'main' }), syncMain: async () => base, verifyCloseout: async () => {}, notify: async () => {},
  });
  const engine = new Engine(store, adapter, 0);
  engine.profiles = all.map(item => item.profile);
  const current = () => store.task(task.id);
  const events = (kind: string) => store.eventsAll(task.id).filter(event => event.kind === kind);
  const control = (args: Record<string, unknown>) => engine.performTaskControl(taskControlInputSchema.parse({
    taskId: task.id, version: current().version, action: 'route', reason: 'Owner ruling', caller: CALLER, ...args,
  }));
  return { dir, store, engine, adapter, task, current, events, control, observations, idle, stops, creates, agentPrompts, runPrompts,
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('route schema requires a role, a profile and a reason, and scopes its fields', () => {
  const base = { taskId: 'task', version: 1, action: 'route' } as const;
  assert.equal(taskControlInputSchema.safeParse({ ...base, profileId: 'sol', reason: 'x' }).success, false, 'a role is required');
  assert.equal(taskControlInputSchema.safeParse({ ...base, role: 'worker', reason: 'x' }).success, false, 'a profile is required');
  assert.equal(taskControlInputSchema.safeParse({ ...base, role: 'worker', profileId: 'sol' }).success, false, 'a reason is required');
  assert.equal(taskControlInputSchema.safeParse({ taskId: 'task', version: 1, action:'move',to:'work',reason:'Return to the retained author', role: 'worker' }).success, false, 'a role is only valid for route');
  assert.equal(taskControlInputSchema.safeParse({ taskId: 'task', version: 1, action:'move',to:'work',reason:'Return to the retained author', now: true }).success, false, 'a now flag is only valid for route');
  assert.ok(taskControlInputSchema.safeParse({ ...base, role: 'worker', profileId: 'sol', reason: 'x' }).success);
  assert.ok(taskControlInputSchema.safeParse({ ...base, role: 'reviewer', profileId: 'sol', reason: 'x', now: true }).success);
});

test('route worker changes the next worker run to a different profile, keeping the PR and head', async () => {
  const f = fixture(); try {
    const routed = await f.control({ role: 'worker', profileId: 'sol', reason: 'Sol is stronger for the revision' });
    assert.equal(routed.profileRequests?.worker?.profileId, 'sol');
    assert.equal(routed.replacementProfile?.profileId, 'sol');
    assert.match(routed.failoverReason, /Sol is stronger for the revision/);
    assert.equal(routed.phase, 'changes_requested');
    const event = f.events('route_changed').at(-1)!;
    assert.equal(JSON.parse(event.detail).role, 'worker');
    assert.equal(JSON.parse(f.events('owner_control').at(-1)!.detail).verb, 'route');

    await f.engine.wake();
    const replaced = f.current();
    assert.equal(replaced.profile?.id, 'sol', 'the next worker run uses the routed profile');
    assert.equal(replaced.retiredWorkers.at(-1)?.agentId, 'worker');
    assert.equal(replaced.prUrl, 'https://github.com/example/repo/pull/1', 'the PR is kept');
    assert.equal(replaced.resumePrNumber, 1, 'the PR number is retained across the replacement');
  } finally { await f.close(); }
});

test('route worker makes the next revision a fresh agent on the routed profile in the same workspace, branch and PR', async () => {
  const f = fixture(); try {
    // A retained author waiting for the next revision, exactly what the route
    // redirects: no active run, a PR and a review that asked for changes.
    f.store.update(f.task.id, {
      phase: 'changes_requested', reason: 'Address the review findings', branch: 'ns-task',
      resolution: { ...f.current().resolution, currentRunId: null,
        review: { taskId: f.task.id, runId: 'review-run', eventId: 'review-change', status: 'changes_required', summary: 'One finding', head } },
    });
    const routed = await f.control({ role: 'worker', profileId: 'sol', reason: 'Sol is stronger for the revision' });
    assert.equal(routed.profileRequests?.worker?.profileId, 'sol');
    assert.equal(routed.replacementProfile?.profileId, 'sol');

    await f.engine.wake();
    const replaced = f.current();
    assert.equal(replaced.profile?.id, 'sol', 'the next revision runs on the routed profile');
    assert.equal(replaced.workspaceId, 'workspace', 'the task workspace is kept');
    assert.equal(replaced.branch, 'ns-task', 'the branch is kept');
    assert.equal(replaced.prUrl, 'https://github.com/example/repo/pull/1', 'the PR is kept');
    assert.equal(replaced.retiredWorkers.at(-1)?.agentId, 'worker', 'the retained author retired');
    assert.notEqual(replaced.agentId, 'worker', 'a fresh agent takes the routed profile');
  } finally { await f.close(); }
});

test('route worker to the same profile continues the retained worker (Spec 058 task 577)', async () => {
  const f = fixture(); try {
    const routed = await f.control({ role: 'worker', profileId: 'author', reason: 'Reset the same profile' });
    assert.equal(routed.profileRequests?.worker?.profileId, 'author', 'the request is recorded');
    assert.equal(routed.replacementProfile, null, 'the same model with no provider failure arms no replacement');
    assert.equal(routed.failoverReason, '', 'no failover is armed');
    const refused = f.events('worker_replacement_refused').at(-1)!;
    assert.match(refused.detail, /^same_model_no_failure:/, 'the refusal names its rule');
    assert.equal(routed.phase, 'changes_requested', 'the next run continues the retained worker');
    await f.engine.wake();
    assert.equal(f.current().retiredWorkers.length, 0, 'no worker retired for the same-model route');
    assert.equal(f.current().agentId, 'worker', 'the retained worker continues');
  } finally { await f.close(); }
});

test('move to work launches the pending worker route from verifying and keeps the merge hold', async () => {
  const f = fixture(); try {
    const at = new Date().toISOString();
    f.store.update(f.task.id, {
      phase: 'verifying', agentId: null, agentIntent: false, runId: null,
      holds: { merge: { owner: 'operator', reason: 'Hold merge for review', at, generation: 1, until: null } },
      resolution: { ...f.current().resolution, currentRunId: null },
    });
    const routed = await f.control({ role: 'worker', profileId: 'sol', now: true, reason: 'Use Sol for the repair' });
    assert.equal(routed.agentId, null, 'route now with no worker run only arms the next launch');
    assert.equal(routed.profileRequests?.worker?.profileId, 'sol');

    const next = ownerTaskNext(collectOwnerVerbFacts(f.store, f.current()));
    const work = next.verbs.find(entry => entry.verb === 'move' && entry.args?.to === 'work')!;
    assert.equal(work.available, true, JSON.stringify(work));
    const moved = await f.engine.performTaskControl(taskControlInputSchema.parse({ ...work.args,
      reason: 'Return the held task to work', instruction: 'Repair the verification issue', caller: CALLER }));
    assert.equal(moved.phase, 'changes_requested');
    assert.equal(moved.replacementProfile?.profileId, 'sol');
    assert.equal(moved.prUrl, f.task.prUrl);
    assert.equal(moved.branch, f.task.branch);
    assert.deepEqual(moved.holds?.merge, routed.holds?.merge, 'the merge hold remains in place');
    assert.match(f.events('worker_route_honoured').at(-1)!.detail, /sol/);

    await f.engine.wake();
    const launched = f.current();
    assert.equal(launched.profile?.id, 'sol');
    assert.equal(launched.workspaceId, 'workspace');
    assert.equal(launched.branch, f.task.branch);
    assert.equal(launched.prUrl, f.task.prUrl);
  } finally { await f.close(); }
});

test('move to work refuses while a pending worker replacement is being created', async () => {
  const f = fixture(); try {
    f.store.update(f.task.id, {
      phase: 'dispatching', agentId: null, agentIntent: true,
      failoverReason: 'Operator-approved retained worker remap. Continue the existing task',
      replacementProfile: { profileId: 'sol', reason: 'Use Sol' },
    });
    const next = ownerTaskNext(collectOwnerVerbFacts(f.store, f.current()));
    const work = next.verbs.find(entry => entry.verb === 'move' && entry.refusal?.startsWith('move work:'))!;
    assert.equal(work.available, false);
    assert.match(work.refusal!, /already being created/);
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'move', to: 'work',
      taskId: f.task.id, version: f.current().version, reason: 'Try to move during launch', caller: CALLER })), /already being created/);
  } finally { await f.close(); }
});

test('route reviewer on the author model is used and records the independence waiver', async () => {
  const f = fixture(); try {
    f.store.update(f.task.id, { phase: 'awaiting_review', resolution: { ...f.current().resolution, currentRunId: null } });
    const routed = await f.control({ role: 'reviewer', profileId: 'authorrev', reason: 'Tom chose this reviewer freely' });
    assert.equal(routed.profileRequests?.reviewer?.profileId, 'authorrev');
    const audit = JSON.parse(f.events('owner_control').at(-1)!.detail);
    assert.equal(audit.identities.route.role, 'reviewer');
    assert.equal(audit.identities.route.independenceWaived, true, 'the audit records the waived independence');
    await f.engine.wake();
    const run = f.creates.find(candidate => candidate.role === 'reviewer');
    assert.ok(run, 'the next review launches');
    assert.equal(run.profile?.id, 'authorrev', 'the owner-routed reviewer is used even on the author model');
  } finally { await f.close(); }
});

test('an optional reviewer request on the author model is not selected', async () => {
  const f = fixture(); try {
    const optional = { ...f.current(), profileRequests: { reviewer: { profileId: 'authorrev', reason: 'A soft preference', required: false } } };
    const selection = f.engine.resolution.select(optional as never, 'reviewer');
    assert.ok(selection, 'an independent reviewer is still selected');
    assert.equal(selection.profile.id, 'luna', 'the optional same-model request stays excluded; only a required owner route waives independence');
  } finally { await f.close(); }
});
test('a workerless review entry honours the owner-routed reviewer on a declared external author model', async () => {
  const f = fixture(); try {
    // The imported head has no Queue authoring worker: its current author is the
    // recorded declaration, not an unknown worker.
    const workerless = f.store.update(f.task.id, {
      agentId: null, runId: null, profile: null, workerModel: null, workerModels: [],
      reviewEntry: reviewEntryRecordSchema.parse({ operationId: 'c'.repeat(64), prNumber: 1, repository: 'example/repo',
        branch: 'feature/external', workspaceId: 'workspace', verifiedHead: head, verifiedBase: base, planningCommit: base,
        authority: 'Operator authorized independent review of the existing PR',
        authorDeclaration: { models: ['provider/author-model'], githubAuthor: 'external-author', authoringSystem: 'external-agent',
          attestedBy: 'operator', provenance: 'Provider records and author report' },
        checkedAt: new Date().toISOString(), preserveWorkspace: true }),
    });
    assert.equal(workerless.agentId, null);
    assert.equal(workerless.workerModel, null);
    assert.equal(f.engine.resolution.select({ ...workerless, profileRequests: {} } as never, 'reviewer')?.profile.id, 'luna',
      'with no request, an independent reviewer is selected');
    assert.equal(f.engine.resolution.select({ ...workerless, profileRequests: { reviewer: { profileId: 'authorrev',
      reason: 'Owner routed the external author model', required: true, ownerRoute: true } } } as never, 'reviewer')?.profile.id, 'authorrev',
      'the recorded owner route waives the declared external author model, not an unknown worker');
    assert.equal(f.engine.resolution.select({ ...workerless, profileRequests: { reviewer: { profileId: 'authorrev',
      reason: 'Board choice', required: true } } } as never, 'reviewer'), null,
      'an unmarked request still cannot certify the external author\'s own model');
    assert.equal(f.engine.resolution.select({ ...workerless, profileRequests: { reviewer: { profileId: 'authorrev',
      reason: 'A soft preference', required: false } } } as never, 'reviewer')?.profile.id, 'luna',
      'an optional request never waives the current author model');
    // A real Queue author whose current model was never recorded is unknown, so no
    // fresh reviewer is selected even though the declared external authors are
    // concrete and an independent profile exists.
    const unrecordedAuthor = f.store.update(f.task.id, { agentId: 'unrecorded-author', runId: 'unrecorded-run' });
    assert.equal(f.engine.resolution.select({ ...unrecordedAuthor, profileRequests: {} } as never, 'reviewer'), null,
      'an unknown current Queue author refuses fresh reviewer selection');
    assert.equal(f.engine.resolution.select({ ...unrecordedAuthor, profileRequests: { reviewer: { profileId: 'authorrev',
      reason: 'Owner routed it', required: true, ownerRoute: true } } } as never, 'reviewer'), null,
      'an owner route cannot certify a reviewer while the current author is unknown');
    // A prior Queue author's recorded model is author evidence too: with the
    // current worker recorded, a retired author's model still excludes it.
    const priorAuthor = f.store.update(f.task.id, {
      agentId: 'worker', runId: 'initial', profile: profile('author', 'author-model', ['worker', 'reviewer']).profile,
      workerModel: 'author-model', workerModels: ['author-model'],
      retiredWorkers: [{ agentId: 'old-author', runId: 'old-run',
        profile: profile('old', 'luna-model', ['reviewer']).profile, reason: 'Replaced by the current worker' }] });
    const priorSelection = f.engine.resolution.select({ ...priorAuthor, profileRequests: {} } as never, 'reviewer');
    assert.ok(priorSelection, 'an independent profile still serves');
    assert.notEqual(priorSelection.profile.id, 'luna', 'a retired Queue author model is excluded from fresh reviewer selection');
    // A later recorded revision contributor collides the same way.
    f.store.putRun(runSchema.parse({ id: 'revision-contributor', taskId: f.task.id, role: 'revision', generation: 1, head, base,
      agentId: 'revision-agent', workspaceId: 'workspace', profile: profile('luna', 'luna-model', ['reviewer']).profile, status: 'finished',
      createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null, completion: null, released: true }));
    const revisionSelection = f.engine.resolution.select({ ...f.current(), profileRequests: {} } as never, 'reviewer');
    assert.ok(revisionSelection, 'an independent profile still serves');
    assert.notEqual(revisionSelection.profile.id, 'luna', 'a recorded revision contributor model is excluded from fresh reviewer selection');
  } finally { await f.close(); }
});
test('route coordinator replaces the assigned coordinator with the routed profile', async () => {
  const f = fixture(); try {
    // An assigned coordinator agent overrides the role selection, so the route
    // must clear it for the profile to be used on the next coordinator run.
    f.store.update(f.task.id, { coordinatorAgentId: 'old-coord', coordinatorGeneration: 1 });
    const routed = await f.control({ role: 'coordinator', profileId: 'coord', reason: 'A coordinator profile' });
    assert.equal(routed.profileRequests?.coordinator?.profileId, 'coord');
    assert.equal(routed.coordinatorAgentId, '', 'the assigned coordinator is cleared so the profile route is used');
    assert.equal(routed.coordinatorGeneration, 2, 'a coordinator replacement advances the generation');
    const selection = f.engine.resolution.select(routed, 'coordinator');
    assert.ok(selection, 'the routed coordinator profile is selectable');
    assert.equal(selection.profile.id, 'coord', 'the next coordinator is chosen by the routed profile, not the old agent');
  } finally { await f.close(); }
});

test('a required non-route reviewer request on the current author model is not selected', async () => {
  const f = fixture(); try {
    // `set_routing` and submissions write required:true without the marker.
    // Like any required request that independence excludes, selection is
    // empty rather than certifying the head through its own author's model.
    const board = { ...f.current(), profileRequests: { reviewer: { profileId: 'authorrev', reason: 'Board choice', required: true } } };
    assert.equal(f.engine.resolution.select(board as never, 'reviewer'), null,
      'the unmarked same-model request stays excluded; only an owner route waives the current author model');
  } finally { await f.close(); }
});
test('set_routing and submissions store the plain reviewer request without the owner-route marker', async () => {
  const f = fixture(); try {
    const submitted = f.store.insert(submissionSchema.parse({
      submissionId: randomUUID(), title: 'Pre-dispatch', repoPath: '/repo', planningCommit: base,
      handoffPath: 'handoff.md', originAgentId: 'origin',
      profileRequests: { reviewer: { profileId: 'luna', reason: 'Submission preference', required: true, ownerRoute: true } },
    }), 'host', 'handoff', base);
    assert.equal(submitted.profileRequests?.reviewer?.ownerRoute, undefined, 'a submission never records the marker');
    const changed = await f.engine.performTaskControl(taskControlInputSchema.parse({
      taskId: submitted.id, version: submitted.version, action: 'set_routing', reason: 'Board choice',
      profileRequests: { reviewer: { profileId: 'luna', reason: 'Board prefers Luna', required: true, ownerRoute: true } },
    }));
    assert.equal(changed.profileRequests?.reviewer?.profileId, 'luna');
    assert.equal(changed.profileRequests?.reviewer?.ownerRoute, undefined, 'set_routing never records the marker, even when the input claims it');
  } finally { await f.close(); }
});
test('route coordinator now during another role\u2019s live run records the request without unbinding it', async () => {
  const f = fixture(); try {
    // The live reviewer run owns the current slot; the coordinator binding is
    // from an earlier turn. A coordinator `now` must not orphan that run.
    f.store.putRun({ id: 'rev-live', taskId: f.task.id, role: 'reviewer', generation: 1, head, base, agentId: 'reviewer', workspaceId: 'workspace',
      profile: f.engine.profiles.find(candidate => candidate.id === 'luna')!, status: 'running', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: true, idleSince: null, completion: null, released: false } as Run);
    f.store.setCredential('rev-live', 'token');
    f.store.update(f.task.id, { phase: 'reviewing', coordinatorAgentId: 'old-coord', coordinatorGeneration: 1,
      resolution: { ...f.current().resolution, currentRunId: 'rev-live', reviewerAgentId: 'reviewer',
        reviewerProfile: f.engine.profiles.find(candidate => candidate.id === 'luna')! } });
    const routed = await f.control({ role: 'coordinator', profileId: 'coord', now: true, reason: 'Route the next coordinator' });
    assert.equal(routed.profileRequests?.coordinator?.profileId, 'coord', 'the route is recorded');
    assert.equal(routed.resolution.currentRunId, 'rev-live', 'the live reviewer run stays bound');
    assert.equal(f.store.run('rev-live')!.released, false, 'the live reviewer run is not stopped or released');
    assert.deepEqual(f.stops, [], 'no turn is stopped for another role');
    assert.equal(routed.coordinatorAgentId, 'old-coord', 'the coordinator binding is kept');
    assert.equal(routed.coordinatorGeneration, 1, 'the generation is not bumped');
  } finally { await f.close(); }
});
test('a non-now coordinator route during a live run takes effect on the next coordinator run', async () => {
  const f = fixture(); try {
    const coord2 = profile('coord2', 'coord2-model', ['coordinator']);
    f.store.setMeta('pool', [...f.store.pool(), coord2.entry]);
    f.engine.profiles = [...f.engine.profiles, coord2.profile];
    const oldProfile = f.engine.profiles.find(candidate => candidate.id === 'coord')!;
    f.store.putRun({ id: 'coord-live', taskId: f.task.id, role: 'closeout', generation: 1, head, base, agentId: 'old-coord', workspaceId: 'workspace',
      profile: oldProfile, status: 'running', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: true, idleSince: null, completion: null, released: false } as Run);
    f.store.setCredential('coord-live', 'token');
    f.store.update(f.task.id, { phase: 'closing', coordinatorAgentId: 'old-coord', coordinatorGeneration: 1,
      resolution: { ...f.current().resolution, currentRunId: 'coord-live', syncedCommit: 'c'.repeat(40) } });
    const routed = await f.control({ role: 'coordinator', profileId: 'coord2', reason: 'Route the next coordinator' });
    assert.equal(routed.coordinatorAgentId, 'old-coord', 'the live binding is kept while its run is live');
    assert.equal(routed.coordinatorGeneration, 1, 'the live predecessor retains its callback generation');
    assert.deepEqual(routed.profileRequests?.coordinator, { profileId: 'coord2', reason: 'Route the next coordinator', required: true, ownerRoute: true, requestedBy: CALLER });
    const live = f.store.run('coord-live')!;
    f.store.putRun({ ...live, status: 'finished', released: true,
      completion: { taskId: f.task.id, runId: 'coord-live', eventId: 'coord-done', status: 'closed', summary: 'Closed', head, coordinatorGeneration: 1 } });
    f.store.update(f.task.id, { resolution: { ...f.current().resolution, currentRunId: null } });
    let replacementToken = '';
    const createRun = f.adapter.createRun!;
    f.adapter.createRun = async (task, run, token) => {
      assert.equal(task.coordinatorGeneration, 2, 'the adapter receives the replacement task generation');
      assert.equal(run.generation, task.coordinatorGeneration);
      replacementToken = token;
      return createRun(task, run, token);
    };
    await f.engine.resolution.launch(f.current(), 'closeout', {});
    const run = f.creates.find(candidate => candidate.role === 'closeout' && candidate.id !== 'coord-live');
    assert.ok(run, 'the next coordinator run launches');
    assert.equal(run.profile?.id, 'coord2', 'the next coordinator run uses the routed profile, not the old binding');
    assert.equal(run.generation, 2, 'the replacement run advances the callback generation');
    assert.equal(f.current().coordinatorGeneration, 2, 'the task advances with the replacement run');
    assert.equal(f.store.run('coord-live')!.generation, 1, 'historical run generation stays unchanged');
    assert.throws(() => f.engine.resolution.complete({ taskId: f.task.id, runId: 'coord-live', eventId: 'late-coord', status: 'closed', summary: 'Late', head: 'c'.repeat(40), coordinatorGeneration: 1 }, 'token'), /Unauthorized callback/);
    assert.equal(f.engine.resolution.complete({ taskId: f.task.id, runId: run.id, eventId: 'new-coord', status: 'closed', summary: 'Closed', head: 'c'.repeat(40), coordinatorGeneration: 2 }, replacementToken).accepted, true, 'replacement callbacks use the new generation');
    assert.equal(f.current().coordinatorAgentId, `agent-${run.id}`, 'the new coordinator agent is recorded');
    assert.ok(f.events('coordinator_route_applied').length >= 1, 'the binding switch is recorded');
  } finally { await f.close(); }
});
test('a non-now reviewer route on a merging task only records the request and leaves the phase alone', async () => {
  const f = fixture(); try {
    f.store.update(f.task.id, {
      phase: 'merging',
      resolution: { ...f.current().resolution, currentRunId: null, mergeIntent: true,
        mechanicalVerification: { at: new Date().toISOString(), head, base } },
    });
    const routed = await f.control({ role: 'reviewer', profileId: 'luna', reason: 'Route the next reviewer' });
    assert.equal(routed.phase, 'merging', 'a non-now reviewer route never rewinds a merging task');
    assert.ok(routed.resolution.mechanicalVerification, 'the mechanical verification evidence is kept');
    assert.equal(routed.profileRequests?.reviewer?.profileId, 'luna');
  } finally { await f.close(); }
});

test('route lifts a matching worker exclusion and records the lift', async () => {
  const f = fixture(); try {
    f.store.update(f.task.id, { workerExclusions: [{ agentId: null, profileId: 'sol', reason: 'Earlier trouble', createdAt: new Date().toISOString() }] as never });
    const routed = await f.control({ role: 'worker', profileId: 'sol', reason: 'Tom reinstated Sol' });
    assert.deepEqual(routed.workerExclusions, [], 'the matching profile exclusion is lifted');
    const detail = JSON.parse(f.events('route_changed').at(-1)!.detail);
    assert.equal(detail.exclusionLifted, true);
    assert.equal(f.events('owner_control').at(-1) && JSON.parse(f.events('owner_control').at(-1)!.detail).verb, 'route');
  } finally { await f.close(); }
});

test('route refuses an unavailable subscription group with the retry time and eligible alternatives', async () => {
  const f = fixture(); try {
    f.store.db.prepare('INSERT INTO availability VALUES(?,?)').run('sol', JSON.stringify({ group: 'sol', unavailable: true, reason: 'quota paused', retryAt: '2099-01-01T00:00:00.000Z' }));
    await assert.rejects(f.control({ role: 'worker', profileId: 'sol', reason: 'Moved anyway' }),
      /Subscription group sol is unavailable: quota paused \(retry 2099-01-01T00:00:00.000Z\); eligible worker alternatives: .*author|Subscription group sol is unavailable: quota paused \(retry 2099-01-01T00:00:00.000Z\); eligible worker alternatives: author/);
    assert.equal(f.current().version, f.task.version, 'a refused route changes nothing');
  } finally { await f.close(); }
});

test('route now stops and replaces a live revision worker without losing the PR or head', async () => {
  const f = fixture(); try {
    f.store.putRun({ id: 'rev-live', taskId: f.task.id, role: 'revision', generation: 1, head, base, agentId: 'worker', workspaceId: 'workspace',
      profile: f.engine.profiles.find(p => p.id === 'author')!, status: 'running', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: true, idleSince: null, completion: null, released: false } as Run);
    f.store.setCredential('rev-live', 'token');
    f.store.update(f.task.id, { phase: 'working', resolution: { ...f.current().resolution, currentRunId: 'rev-live' } });
    f.observations.set('worker', { id: 'worker', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '', activeTurnId: 'turn-1' });

    const routed = await f.control({ role: 'worker', profileId: 'sol', now: true, reason: 'Switch the live worker now' });
    assert.deepEqual(f.stops, ['worker'], 'the live worker turn was stopped through Paseo');
    assert.equal(f.current().resolution.currentRunId, null);
    assert.equal(f.store.run('rev-live')!.released, true, 'the old run released so the replacement can start');
    assert.equal(f.store.run('rev-live')!.status, 'superseded');
    assert.ok(f.events('route_stop_intent').length >= 1);
    assert.equal(routed.prUrl, 'https://github.com/example/repo/pull/1');
    assert.equal(routed.prHead, head);
    assert.equal(routed.profileRequests?.worker?.profileId, 'sol');

    await f.engine.wake();
    const replaced = f.current();
    assert.equal(replaced.profile?.id, 'sol', 'the replacement starts on the new route');
    assert.equal(replaced.prUrl, 'https://github.com/example/repo/pull/1', 'the PR is kept');
    assert.equal(replaced.resumePrNumber, 1, 'the PR number is retained across the replacement');
  } finally { await f.close(); }
});

test('an approved pending worker request routes the live automatic run now and keeps its workspace and branch', async () => {
  const f = fixture(); try {
    const nova = f.engine.profiles.find(p => p.id === 'nova')!;
    f.store.update(f.task.id, { phase: 'working', completion: null,
      profileRequests: { worker: { profileId: 'nova', reason: 'Frontier analysis', required: true } } });
    f.store.putRun({ id: 'rev-live', taskId: f.task.id, role: 'revision', generation: 1, head, base, agentId: 'worker', workspaceId: 'workspace',
      profile: f.engine.profiles.find(p => p.id === 'author')!, status: 'running', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: true, idleSince: null, completion: null, released: false } as Run);
    f.store.setCredential('rev-live', 'token');
    f.store.update(f.task.id, { resolution: { ...f.current().resolution, currentRunId: 'rev-live' } });
    f.observations.set('worker', { id: 'worker', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '', activeTurnId: 'turn-1' });
    reconcileRoutingSignoffs(f.store, new Decisions(f.store), f.task.id, f.engine.profiles);
    const pending = f.current().profileRequests!.worker!.signoff!;
    const decision = f.engine.signoffDecisions.get({ id: pending.decisionId! });
    f.engine.signoffDecisions.answer({ id: decision.id, version: decision.version, answer: signoffApprove(nova.name),
      answeredBy: 'operator (board)', relayed: false, note: '' });

    await f.engine.taskQuantumOwner.taskQuantum(f.task.id);
    assert.deepEqual(f.stops, ['worker']);
    assert.equal(f.current().workspaceId, 'workspace');
    assert.equal(f.current().branch, f.task.branch);
    assert.equal(f.current().directory, '/worktree');
    assert.equal(f.current().profileRequests!.worker!.signoff!.decisionId, decision.id);
    assert.match(f.current().profileRequests!.worker!.reason, /Frontier analysis/);
  } finally { await f.close(); }
});

test('approval reroutes and stops a live initial worker turn through route now', async () => {
  const f = fixture(); try {
    const nova = f.engine.profiles.find(p => p.id === 'nova')!;
    f.store.update(f.task.id, { phase: 'working', completion: null,
      profileRequests: { worker: { profileId: 'nova', reason: 'Frontier analysis', required: true } },
      resolution: { ...f.current().resolution, currentRunId: null } });
    f.observations.set('worker', { id: 'worker', workspaceId: 'workspace', status: 'running', active: true,
      permissions: false, error: '', activeTurnId: 'initial-turn' });
    reconcileRoutingSignoffs(f.store, new Decisions(f.store), f.task.id, f.engine.profiles);
    const pending = f.current().profileRequests!.worker!.signoff!;
    const decision = f.engine.signoffDecisions.get({ id: pending.decisionId! });
    f.engine.signoffDecisions.answer({ id: decision.id, version: decision.version, answer: signoffApprove(nova.name),
      answeredBy: 'operator (board)', relayed: false, note: '' });

    await f.engine.taskQuantumOwner.taskQuantum(f.task.id);
    const routed = f.current();
    assert.deepEqual(f.stops, ['worker'], 'approval uses the same live-turn stop as an owner route now');
    assert.equal(routed.replacementProfile?.profileId, 'nova');
    assert.equal(routed.workspaceId, 'workspace');
    assert.equal(routed.branch, f.task.branch);
    assert.equal(routed.reason, `Rerouted to nova after approval ${decision.id}`);
    const event = f.events('route_changed').at(-1)!;
    assert.match(event.detail, new RegExp(`Rerouted to nova after approval ${decision.id}`));
    assert.equal(f.events('routing_signoff_live_route_refused').length, 0);

    await f.engine.wake();
    assert.equal(f.current().profile?.id, 'nova', 'the replacement starts on the approved profile');
    assert.equal(f.current().workspaceId, 'workspace', 'the existing workspace is retained');
    assert.equal(f.current().branch, f.task.branch, 'the existing branch is retained');
  } finally { await f.close(); }
});

test('an approval after worker handoff sets its next route without interrupting the reviewer', async () => {
  const f = fixture(); try {
    const nova = f.engine.profiles.find(p => p.id === 'nova')!;
    f.store.update(f.task.id, { phase: 'awaiting_review',
      profileRequests: { worker: { profileId: 'nova', reason: 'Frontier analysis', required: true } } });
    f.store.putRun({ id: 'review-live', taskId: f.task.id, role: 'reviewer', generation: 1, head, base, agentId: 'reviewer', workspaceId: 'workspace',
      profile: f.engine.profiles.find(p => p.id === 'luna')!, status: 'running', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: true, idleSince: null, completion: null, released: false } as Run);
    f.store.update(f.task.id, { resolution: { ...f.current().resolution, currentRunId: 'review-live', reviewerAgentId: 'reviewer', reviewerProfile: f.engine.profiles.find(p => p.id === 'luna')! } });
    reconcileRoutingSignoffs(f.store, new Decisions(f.store), f.task.id, f.engine.profiles);
    const pending = f.current().profileRequests!.worker!.signoff!;
    const decision = f.engine.signoffDecisions.get({ id: pending.decisionId! });
    f.engine.signoffDecisions.answer({ id: decision.id, version: decision.version, answer: signoffApprove(nova.name),
      answeredBy: 'operator (board)', relayed: false, note: '' });

    await f.engine.taskQuantumOwner.taskQuantum(f.task.id);
    assert.equal(f.current().resolution.currentRunId, 'review-live');
    assert.equal(f.store.run('review-live')!.released, false);
    assert.equal(f.stops.length, 0);
    assert.equal(f.current().profileRequests!.worker!.profileId, 'nova');
    assert.equal(f.current().profileRequests!.worker!.signoff!.decisionId, decision.id);
  } finally { await f.close(); }
});

test('declining a pending worker profile request leaves its live automatic run alone', async () => {
  const f = fixture(); try {
    f.store.update(f.task.id, { phase: 'working', completion: null,
      profileRequests: { worker: { profileId: 'nova', reason: 'Frontier analysis', required: true } } });
    f.store.putRun({ id: 'rev-live', taskId: f.task.id, role: 'revision', generation: 1, head, base, agentId: 'worker', workspaceId: 'workspace',
      profile: f.engine.profiles.find(p => p.id === 'author')!, status: 'running', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: true, idleSince: null, completion: null, released: false } as Run);
    f.store.setCredential('rev-live', 'token');
    f.store.update(f.task.id, { resolution: { ...f.current().resolution, currentRunId: 'rev-live' } });
    f.observations.set('worker', { id: 'worker', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '', activeTurnId: 'turn-1' });
    reconcileRoutingSignoffs(f.store, new Decisions(f.store), f.task.id, f.engine.profiles);
    const pending = f.current().profileRequests!.worker!.signoff!;
    const decision = f.engine.signoffDecisions.get({ id: pending.decisionId! });
    f.engine.signoffDecisions.answer({ id: decision.id, version: decision.version, answer: SIGNOFF_DECLINE,
      answeredBy: 'operator (board)', relayed: false, note: '' });

    await f.engine.taskQuantumOwner.taskQuantum(f.task.id);
    assert.deepEqual(f.stops, []);
    assert.equal(f.current().resolution.currentRunId, 'rev-live');
    assert.equal(f.store.run('rev-live')!.released, false);
    assert.equal(f.current().profileRequests!.worker!.signoff!.status, 'declined');
  } finally { await f.close(); }
});

test('route now to a frontier profile preserves the request and leaves the retained worker untouched until sign-off', async () => {
  const f = fixture(); try {
    f.store.putRun({ id: 'rev-live', taskId: f.task.id, role: 'revision', generation: 1, head, base, agentId: 'worker', workspaceId: 'workspace',
      profile: f.engine.profiles.find(p => p.id === 'author')!, status: 'running', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: true, idleSince: null, completion: null, released: false } as Run);
    f.store.setCredential('rev-live', 'token');
    f.store.update(f.task.id, { phase: 'working', completion: null, resolution: { ...f.current().resolution, currentRunId: 'rev-live' } });
    f.observations.set('worker', { id: 'worker', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '', activeTurnId: 'turn-2' });

    // effigy#531 10:30 with now: true (review 825): the unsigned route used to
    // throw before recording its request, so the operator was never asked. The
    // `now` replacement is refused, the request stands, and the retained
    // worker and its run are untouched until the sign-off is approved.
    await assert.rejects(
      f.control({ role: 'worker', profileId: 'nova', now: true, reason: 'Nova for the revision, now' }),
      /needs the operator's board sign-off/,
    );
    assert.deepEqual(f.stops, [], 'the live worker turn was not stopped');
    assert.equal(f.store.run('rev-live')!.released, false, 'the live run was not released');
    assert.equal(f.store.run('rev-live')!.status, 'running', 'the live run was not superseded');
    const routed = f.current();
    assert.equal(routed.resolution.currentRunId, 'rev-live', 'the run stays bound');
    assert.equal(routed.agentId, 'worker', 'the retained worker is untouched');
    assert.equal(routed.phase, 'working', 'the phase is untouched');
    assert.equal(routed.replacementProfile, null, 'nothing is armed while sign-off is pending');
    assert.equal(routed.failoverReason, '', 'no failover is armed');
    assert.equal(routed.profileRequests?.worker?.profileId, 'nova', 'the route request is recorded');
    assert.equal(routed.profileRequests?.worker?.ownerRoute, true);
    const refused = f.events('worker_replacement_refused');
    assert.equal(refused.length, 1);
    assert.match(refused[0]!.detail, /^signoff_pending:/, 'the refusal names its rule');

    // The preserved request still opens the operator's sign-off decision.
    const decisions = new Decisions(f.store);
    reconcileRoutingSignoffs(f.store, decisions, f.task.id, f.engine.profiles);
    const signoff = f.current().profileRequests?.worker?.signoff;
    assert.equal(signoff?.status, 'pending', 'the request waits for the operator');
    assert.ok(signoff?.decisionId, 'the sign-off decision is linked');
    const open = decisions.get({ id: signoff!.decisionId! });
    assert.equal(open.status, 'open');
    assert.match(open.question, /nova/);
  } finally { await f.close(); }
});

for (const supplied of [false, true]) test(`routed blocked worker moves its retained PR to fresh review (${supplied ? 'matching' : 'omitted'} number)`, async () => {
  const f = fixture(); try {
    let token = '';
    const createAgent = f.adapter.createAgent;
    f.adapter.createAgent = async (...args) => { token = args[1]; return createAgent(...args); };
    // Route a live initial author. Its known PR survives the replacement and
    // the replacement's authenticated blocked result, without another ready report.
    f.store.update(f.task.id, { phase: 'working', completion: null, resumePrNumber: 1 });
    f.observations.set('worker', { id: 'worker', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
    await f.control({ role: 'worker', profileId: 'sol', now: true, reason: 'Replace the author on the same task' });
    await f.engine.wake();
    const replacement = f.current();
    assert.equal(replacement.profile?.id, 'sol');
    assert.equal(replacement.resumePrNumber, 1);
    const publishedHead = 'c'.repeat(40);
    const verified: number[] = [];
    f.adapter.verifyPr = async (_task, number) => { verified.push(number); return { url: f.task.prUrl!, head: publishedHead }; };
    f.adapter.verifyInspectedRevisionHead = async (task, number, expected) => {
      assert.equal(task.branch, replacement.branch); assert.equal(number, 1); assert.equal(expected, publishedHead);
    };
    f.idle(replacement.agentId!);
    const report = { taskId: f.task.id, runId: replacement.runId!, eventId: randomUUID(), status: 'blocked' as const,
      summary: 'Published work is ready for the owner to assess; author proof allowance is spent' };
    assert.equal((await f.engine.complete(report, token)).accepted, true);
    await f.engine.wake();
    assert.equal(f.current().prUrl, null); assert.equal(f.current().prHead, null);
    assert.equal(f.current().completion?.status, 'blocked');
    // Keep old review evidence and fixed accounting across the owner move.
    const oldReview = { taskId: f.task.id, runId: 'old-review', eventId: 'old-verdict', status: 'changes_required' as const,
      summary: 'Earlier findings', head };
    f.store.update(f.task.id, { resolution: { ...f.current().resolution, review: oldReview } });
    const before = f.current();
    const receipts = f.store.db.prepare('SELECT * FROM receipts WHERE task=?').all(f.task.id);
    const view = ownerTaskNext(collectOwnerVerbFacts(f.store, before)).verbs.find(item => item.args?.to === 'review');
    assert.equal(view?.available, true); assert.equal(view?.args?.prNumber, undefined);
    const moved = await f.engine.performTaskControl(taskControlInputSchema.parse({ ...view!.args, reason: 'Accept the delivered scope for independent review',
      caller: CALLER, ...(supplied ? { prNumber: 1 } : {}) }));
    assert.equal(moved.phase, 'awaiting_review'); assert.equal(moved.prHead, publishedHead); assert.equal(moved.prUrl, f.task.prUrl);
    assert.equal(moved.id, before.id); assert.equal(moved.branch, before.branch); assert.equal(moved.workspaceId, before.workspaceId);
    assert.equal(moved.agentId, before.agentId); assert.equal(moved.runId, before.runId);
    assert.deepEqual(moved.completion, report); assert.deepEqual(moved.retiredWorkers, before.retiredWorkers);
    assert.deepEqual(moved.workerModels, before.workerModels); assert.deepEqual(moved.profileRequests, before.profileRequests);
    assert.deepEqual(moved.checkpoints, before.checkpoints); assert.deepEqual(moved.holds, before.holds);
    assert.equal(moved.resolution.review, null);
    assert.deepEqual(moved.resolution.reviewSupersessions.at(-1)?.review, oldReview);
    for (const key of ['revisionRuns', 'roleReplacements', 'recoveryAttempts', 'reviews'] as const)
      assert.deepEqual(moved.resolution[key], before.resolution[key], key);
    assert.deepEqual(f.store.db.prepare('SELECT * FROM receipts WHERE task=?').all(f.task.id), receipts);
    await f.engine.wake();
    const review = f.creates.find(run => run.role === 'reviewer');
    assert.ok(review); assert.equal(review.head, publishedHead); assert.equal(review.profile?.id, 'luna');
    assert.notEqual(review.profile?.model, replacement.profile?.model);
    assert.ok(verified.every(number => number === 1));
    assert.equal(f.events('pr_identity_repaired').length, 0);
  } finally { await f.close(); }
});

test('route now stops and replaces a live reviewer without losing the PR or head', async () => {
  const f = fixture(); try {
    f.store.putRun({ id: 'rev-live', taskId: f.task.id, role: 'reviewer', generation: 1, head, base, agentId: 'reviewer', workspaceId: 'workspace',
      profile: f.engine.profiles.find(p => p.id === 'luna')!, status: 'running', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: true, idleSince: null, completion: null, released: false } as Run);
    f.store.setCredential('rev-live', 'token');
    f.store.update(f.task.id, { phase: 'reviewing', resolution: { ...f.current().resolution, currentRunId: 'rev-live', reviewerAgentId: 'reviewer',
      reviewerProfile: f.engine.profiles.find(p => p.id === 'luna')! } });
    f.observations.set('reviewer', { id: 'reviewer', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '', activeTurnId: 'turn-9' });

    const routed = await f.control({ role: 'reviewer', profileId: 'authorrev', now: true, reason: 'Replace the live reviewer' });
    assert.deepEqual(f.stops, ['reviewer'], 'the live reviewer turn was stopped through Paseo');
    assert.equal(f.current().resolution.currentRunId, null);
    assert.equal(f.current().resolution.reviewerAgentId, null);
    assert.equal(f.store.run('rev-live')!.released, true, 'archived replacement releases ownership');
    assert.ok(f.store.run('rev-live')!.replacedAt);
    assert.throws(() => f.store.authenticate('rev-live', 'token'));
    assert.equal(routed.phase, 'awaiting_review');
    assert.equal(routed.prUrl, 'https://github.com/example/repo/pull/1');
    assert.equal(routed.prHead, head);

    await f.engine.wake();
    const run = f.creates.find(candidate => candidate.role === 'reviewer');
    assert.ok(run, 'the replacement reviewer launches');
    assert.equal(run.profile?.id, 'authorrev', 'the replacement starts on the new route');
    assert.equal(f.current().prUrl, 'https://github.com/example/repo/pull/1', 'the PR is kept');
    assert.equal(f.current().prHead, head, 'the exact head is kept');
  } finally { await f.close(); }
});

test('routing a reviewer with a live run only records the next-run route', async () => {
  const f = fixture(); try {
    f.store.putRun({ id: 'rev-live', taskId: f.task.id, role: 'reviewer', generation: 1, head, base, agentId: 'reviewer', workspaceId: 'workspace',
      profile: f.engine.profiles.find(p => p.id === 'luna')!, status: 'running', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: true, idleSince: null, completion: null, released: false } as Run);
    f.store.setCredential('rev-live', 'token');
    f.store.update(f.task.id, { phase: 'reviewing', resolution: { ...f.current().resolution, currentRunId: 'rev-live', reviewerAgentId: 'reviewer',
      reviewerProfile: f.engine.profiles.find(p => p.id === 'luna')! } });

    const routed = await f.control({ role: 'reviewer', profileId: 'authorrev', reason: 'Use this profile on the next review' });
    assert.equal(routed.profileRequests?.reviewer?.profileId, 'authorrev');
    assert.equal(routed.phase, 'reviewing');
    assert.equal(routed.resolution.currentRunId, 'rev-live');
    assert.equal(f.store.run('rev-live')!.released, false);
    assert.deepEqual(f.stops, []);
  } finally { await f.close(); }
});

test('route starts the reviewer when a blocked task is waiting on a finished reviewer', async () => {
  const f = fixture(); try {
    const completion = { taskId: f.task.id, runId: 'rev-stopped', eventId: 'review-blocked', status: 'blocked' as const, summary: 'Reviewer could not complete', prNumber: 1 };
    f.store.putRun({ id: 'rev-stopped', taskId: f.task.id, role: 'reviewer', generation: 1, head, base, agentId: 'reviewer', workspaceId: 'workspace',
      profile: f.engine.profiles.find(p => p.id === 'luna')!, status: 'finished', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: false, idleSince: null, completion, released: true } as Run);
    f.store.update(f.task.id, { phase: 'blocked', completion, resolution: { ...f.current().resolution, currentRunId: null,
      reviewerAgentId: 'reviewer', reviewerProfile: f.engine.profiles.find(p => p.id === 'luna')! } });

    const routed = await f.control({ role: 'reviewer', profileId: 'authorrev', reason: 'Use the available reviewer profile' });
    assert.equal(routed.phase, 'awaiting_review', 'routing resumes the waiting review step');
    await f.engine.wake();
    const reviewer = f.creates.find(run => run.role === 'reviewer');
    assert.ok(reviewer, `the routed reviewer starts (${f.current().phase}: ${f.current().reason})`);
    assert.equal(reviewer.profile?.id, 'authorrev', 'the new run uses the routed profile');
  } finally { await f.close(); }
});

for (const role of ['reviewer', 'coordinator'] as const) {
  test(`route ${role} thinking option stays scoped to that role and leaves the next worker eligible`, async () => {
    const f = fixture();
    try {
      const profileId = role === 'reviewer' ? 'luna' : 'coord';
      const target = f.engine.profiles.find(p => p.id === profileId)!;
      target.supportedThinking = ['high'];
      target.thinkingOptionId = 'high';
      f.store.update(f.task.id, { thinkingOptionId: 'low' });
      const routed = await f.control({ role, profileId, thinkingOptionId: 'high' });
      assert.equal(routed.thinkingOptionId, 'low', 'the worker override stays unchanged');
      assert.equal(f.current().profileRequests?.[role]?.thinkingOptionId, 'high', 'the role override survives storage');
      const selected = f.engine.resolution.select(f.current(), role);
      assert.equal(selected?.profile.id, profileId);
      assert.equal(selected?.profile.thinkingOptionId, 'high', 'the next role run uses its override');
      const worker = chooseProfile(f.current(), f.engine.profiles, f.store.pool(), {}, new Set());
      assert.ok(worker, 'reviewer/coordinator thinking never filters out the worker');
      assert.equal(worker.profile.thinkingOptionId, 'low');
      assert.equal(f.events('owner_control').length, 1);
      // Settle the route's own post-commit wake before the next version-guarded
      // control; the wake bumps the task version, and the stale-version refusal
      // must never be what this test observes.
      await f.engine.wake();
      await assert.rejects(f.control({ role, profileId, thinkingOptionId: 'unsupported' }), /does not support thinking option unsupported/);
      assert.equal(f.events('owner_control').length, 1, 'a refusal records no control');
      await f.engine.wake();
      await f.control({ role, profileId });
      assert.equal(f.current().profileRequests?.[role]?.thinkingOptionId, undefined);
      assert.equal(f.engine.resolution.select(f.current(), role)?.profile.thinkingOptionId, 'high', 'omitting an override uses the profile default, even with incompatible worker thinking');
    } finally { await f.close(); }
  });
}

test('route worker thinking option still changes the next worker without changing other role overrides', async () => {
  const f = fixture();
  try {
    f.engine.profiles.find(p => p.id === 'sol')!.supportedThinking = ['high'];
    await f.control({ role: 'reviewer', profileId: 'luna', thinkingOptionId: 'low' });
    // Settle the route's post-commit wake before the next version-guarded
    // control (see the thinking-scope test above).
    await f.engine.wake();
    const routed = await f.control({ role: 'worker', profileId: 'sol', thinkingOptionId: 'high' });
    assert.equal(routed.thinkingOptionId, 'high');
    const worker = chooseProfile(f.current(), f.engine.profiles, f.store.pool(), {}, new Set());
    assert.equal(worker?.profile.id, 'sol');
    assert.equal(worker?.profile.thinkingOptionId, 'high');
    assert.equal(f.engine.resolution.select(f.current(), 'reviewer')?.profile.thinkingOptionId, 'low');
    assert.equal(f.events('owner_control').length, 2);
  } finally { await f.close(); }
});

for (const role of ['reviewer', 'coordinator'] as const) {
  test(`submissions and set_routing preserve ${role} thinking while stripping the owner-route marker`, async () => {
    const f = fixture();
    try {
      const profileId = role === 'reviewer' ? 'luna' : 'coord';
      f.engine.profiles.find(p => p.id === profileId)!.supportedThinking = ['low', 'high'];
      const request = { profileId, reason: 'Submission choice', required: true, ownerRoute: true, thinkingOptionId: 'high' };
      const submitted = f.store.insert(submissionSchema.parse({
        submissionId: randomUUID(), title: 'Thinking preferences', repoPath: '/repo', planningCommit: base,
        handoffPath: 'handoff.md', originAgentId: 'origin', thinkingOptionId: 'low',
        profileRequests: { [role]: request },
      }), 'host', 'handoff', base);
      assert.equal(submitted.profileRequests?.[role]?.ownerRoute, undefined);
      assert.equal(submitted.profileRequests?.[role]?.thinkingOptionId, 'high');
      assert.equal(chooseProfile(submitted, f.engine.profiles, f.store.pool(), {}, new Set(), role)?.profile.thinkingOptionId, 'high');
      const changed = await f.engine.performTaskControl(taskControlInputSchema.parse({
        taskId: submitted.id, version: submitted.version, action: 'set_routing', reason: 'Board choice',
        profileRequests: { [role]: { ...request, thinkingOptionId: 'low' } },
      }));
      assert.equal(changed.profileRequests?.[role]?.ownerRoute, undefined);
      assert.equal(f.store.task(submitted.id).profileRequests?.[role]?.thinkingOptionId, 'low');
      assert.equal(chooseProfile(changed, f.engine.profiles, f.store.pool(), {}, new Set(), role)?.profile.thinkingOptionId, 'low');
      await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({
        taskId: submitted.id, version: changed.version, action: 'set_routing', reason: 'Unsupported preference',
        profileRequests: { [role]: { ...request, thinkingOptionId: 'unsupported' } },
      })), /does not support thinking option unsupported/);
      assert.equal(f.store.task(submitted.id).version, changed.version, 'invalid thinking leaves routing unchanged');
    } finally { await f.close(); }
  });
}

test('route worker refuses a profile on the retained reviewer model, and next never prefills it (papercut afe3cd10)', async () => {
  const f = fixture(); try {
    // The retained reviewer runs on sol-model; worker selection drops every sol-model worker with no waiver.
    const sol = f.engine.profiles.find(profile => profile.id === 'sol')!;
    f.store.update(f.task.id, { resolution: { ...f.current().resolution, reviewerProfile: sol } });
    f.store.setProfiles(f.engine.profiles.map(profile => ({ id: profile.id, name: profile.name, provider: profile.provider, model: profile.model, notes: profile.notes })));
    await assert.rejects(f.control({ role: 'worker', profileId: 'sol', reason: 'Sol for the revision', now: true }),
      /Worker profile sol shares the reviewer's model \(sol-model\); filtered for review independence; worker selection drops it with no waiver\. Route the retained reviewer to a different model/);
    assert.equal(f.current().profileRequests?.worker, undefined, 'the refused route records nothing');
    assert.equal(f.events('route_changed').length, 0, 'no route change is written');
    assert.equal(f.current().replacementProfile ?? null, null, 'no replacement is armed');

    // A recorded worker route the rule filters (stale, or recorded before it) is never prefilled as available.
    f.store.update(f.task.id, { profileRequests: { ...f.current().profileRequests, worker: { profileId: 'sol', reason: 'Stale', required: true } } });
    const filtered = ownerTaskNext(collectOwnerVerbFacts(f.store, f.current())).verbs.find(verb => verb.verb === 'route' && verb.args?.role === 'worker')!;
    assert.equal(filtered.args?.profileId, '', 'the filtered profile is not prefilled');
    assert.deepEqual(filtered.fill, ['profileId', 'reason'], 'the owner must pick an eligible worker');
    assert.match(filtered.note ?? '', /sol shares the reviewer's model \(sol-model\); filtered for review independence/);

    // An eligible worker stays prefilled with no note.
    f.store.update(f.task.id, { profileRequests: { ...f.current().profileRequests, worker: { profileId: 'luna', reason: 'Eligible', required: true } } });
    const eligible = ownerTaskNext(collectOwnerVerbFacts(f.store, f.current())).verbs.find(verb => verb.verb === 'route' && verb.args?.role === 'worker')!;
    assert.equal(eligible.args?.profileId, 'luna');
    assert.equal(eligible.note, undefined);
  } finally { await f.close(); }
});
