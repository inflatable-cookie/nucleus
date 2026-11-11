import { formatAgentId } from '../shared/agent-identity';
import { profile } from './support/fakes';
import { settleSupersededFences } from '../core/recovery/fence-settlement';
import { test } from 'node:test';
import { whileReaderInTurn } from './support/reader-in-turn';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { holdPatch } from '../core/merge/merge-hold';
import { taskStopRecord } from '../shared/task-stop';
import { Engine } from '../core/engine';
import {
  authorDeclarationSchema, completionSchema, dispositionSchema, incidentSchema, reviewCheckpointRecordSchema, reviewEntryRecordSchema, runSchema, submissionSchema,
  holdsOf, TASK_CONTROL_RELAYED_NOTE_ACTIONS, taskControlInputSchema, taskNextInputSchema, taskNextSchema, taskStopKind,
  taskControlRequestSchema,
  type Run, type Submission, type Task, type TaskControlInput,
} from '../shared/contracts';
import { collectOwnerVerbFacts, ownerTaskNext, ownerVerbs } from '../core/verbs/owner-verbs';
import { heldBriefQueuePolicy } from '../core/planning/handoff';
import { ABSENT_WORKER_REASON } from '../core/resolution';
import { reviewCheckpointPathFor } from '../core/review/review-continuation';
import type { Adapter, AgentObservation } from '../core/host';

/**
 * Spec 050: `task.next` and the owner verb registry. On a task in each stuck
 * state the brief names, `next` lists at least one available action with
 * complete derived arguments, and `queue.task` accepts exactly those arguments
 * plus the free-text fields the verb says the owner fills. A control applied
 * with a caller identity writes one `owner_control` event. The fence
 * settlement helper supersedes every stale fence an owner control obsoletes,
 * with the history retained.
 */

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const CALLER = 'owner-thread';

test('preserved workspace retirement uses the existing owner verb and requires attributable owner authority', async () => {
  const f = fixture();
  try {
    const timestamp = new Date().toISOString();
    f.store.update(f.taskId, { phase: 'cancelled', workspaceId: 'workspace', directory: '/missing-test-checkout',
      disposition: dispositionSchema.parse({ kind: 'cancel', status: 'complete', requestedAt: timestamp, requestedBy: 'operator control',
        reason: 'Preserve evidence', workDisposition: 'preserve', effects: [], completedAt: timestamp }) });
    f.store.upsertProject({ key: 'repo', name: 'Repo', repositories: [{ origin: null, path: '/repo' }], primary: { origin: null, path: '/repo' } });
    const view = f.next().verbs.find(verb => verb.args?.effect === 'workspace_archive.workspace')!;
    assert.equal(view.available, true);
    const args = { ...view.args, reason: 'Retire the preserved workspace' };
    const before = f.task();
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse(args)), /unattributed/);
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({ ...args, caller: 'unrelated' })), /operator at the board/);
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({ ...args, caller: CALLER })), /operator at the board/, 'a caller claiming the retired project-owner role is refused like any other');
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({ ...args, caller: 'relay', relayed: true })), /authorization note/);
    assert.deepEqual(f.task(), before, 'unauthorized calls have no effects');
    const owner = await f.engine.performTaskControl(taskControlInputSchema.parse({ ...args, caller: 'operator (board)' }));
    assert.equal(owner.resolution.workspaceRetirement?.authorization.kind, 'operator');
    assert.deepEqual(owner.disposition, before.disposition);
    const relay = await f.engine.performTaskControl(taskControlInputSchema.parse({ ...args, version: owner.version,
      caller: 'relay', relayed: true, note: 'Tom explicitly authorized retirement' }));
    assert.equal(relay.resolution.workspaceRetirement?.authorization.kind, 'relayed_note');
    assert.equal(relay.resolution.workspaceRetirement?.authorization.note, 'Tom explicitly authorized retirement');
    assert.equal(f.events('owner_control').length, 2);
  } finally { await f.close(); }
});


const workerProfile = profile('worker', 'test/worker'), reviewerProfile = profile('reviewer', 'test/reviewer');

function fixture(briefText?: string, submissionOverrides: Partial<Submission> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ns-owner-verbs-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const inserted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: briefText ? 'Original brief title' : 'Steer me', repoPath: '/repo', planningCommit: base,
    ...(briefText ? { brief: { text: briefText } } : { handoffPath: 'handoff.md' }), originAgentId: 'origin',
    ...submissionOverrides,
  }), 'host', briefText ?? 'handoff', base);
  store.setMeta('pool', [
    { profileId: workerProfile.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] },
    { profileId: reviewerProfile.id, enabled: true, group: 'review', roles: ['reviewer'], weight: 1, scopes: ['general'] },
  ]);
  const observations = new Map<string, AgentObservation>();
  const adapter = {
    profiles: async () => [workerProfile, reviewerProfile],
    observe: async (id: string) => observations.get(id) ?? { id, workspaceId: null, status: 'idle', active: false, permissions: false, error: '' },
    archiveAgent: async () => {}, notify: async () => {},
    findAgents: async () => [],
    findRunAgents: async () => [],
    verifyWorkspace: async () => {},
    createRun: async () => { throw new Error('no dispatch is expected in these fixtures'); },
    sendRun: async () => {},
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [workerProfile, reviewerProfile];
  const task = () => store.task(inserted.id);
  const facts = () => collectOwnerVerbFacts(store, task());
  const next = () => taskNextSchema.parse(ownerTaskNext(facts()));
  const view = (verb: string) => next().verbs.find(entry => entry.verb === verb)!;
  const events = (kind: string) => store.eventsAll(inserted.id).filter(event => event.kind === kind);
  return {
    dir, store, engine, adapter, observations, taskId: inserted.id, task, facts, next, view, events,
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const briefDocument = (title: string, body: string, queue = '') =>
  `---\ntitle: ${title}\nqueue_approval: checked\n${queue}---\n${body}\n`;

test('task controls accept references and omit version without losing explicit version or phase fences', async () => {
  const f=fixture();
  try {
    const before=f.task();
    f.store.update(before.id,{title:'An unrelated owner edit'});
    const applied=await f.engine.performTaskControl(taskControlRequestSchema.parse({reference:before.reference,action:'hold',phase:'queued',reason:'Wait for evidence'}));
    assert.equal(applied.id,before.id);
    assert.equal(applied.held,true);
    assert.ok(applied.changes?.includes('held'));
    assert.throws(()=>taskControlRequestSchema.parse({taskId:before.id,reference:before.reference,action:'release'}),/exactly one/);
    await assert.rejects(f.engine.performTaskControl({taskId:before.reference!,version:before.version,action:'release'}),/Task changed/);
    f.store.update(before.id,{phase:'working'});
    await assert.rejects(f.engine.performTaskControl({taskId:before.reference!,phase:'queued',action:'release'}),/Task changed: phase expected queued, now working/);
    assert.equal(f.task().held,true);
    await assert.rejects(f.engine.performTaskControl({taskId:'missing#999',action:'release'}),/Task reference not found/);
  } finally {await f.close();}
});

test('next offers set_dependencies before dispatch and the control accepts prerequisite references', async () => {
  const f=fixture();
  try {
    const prerequisite=f.store.insert(submissionSchema.parse({submissionId:randomUUID(),title:'Prerequisite',repoPath:'/repo',planningCommit:base,handoffPath:'handoff.md',originAgentId:'origin'}),'host','handoff',base);
    const view=f.view('set_dependencies');
    assert.equal(view.available,true);
    assert.deepEqual(view.fill,['dependsOn']);
    const applied=await f.engine.performTaskControl({taskId:f.task().reference!,action:'set_dependencies',dependsOn:[prerequisite.reference!]});
    assert.deepEqual(applied.dependsOn,[prerequisite.id]);
    assert.ok(applied.changes?.includes('dependsOn'));
    f.store.update(f.taskId,{phase:'dispatching'});
    assert.equal(f.view('set_dependencies').available,false);
  } finally {await f.close();}
});

test('queued brief amendments apply routing together and name the changed fields in their reply', async () => {
  const f=fixture(briefDocument('Original brief title','Original'));
  try {
    const prerequisite=f.store.insert(submissionSchema.parse({submissionId:randomUUID(),title:'Prerequisite',repoPath:'/repo',planningCommit:base,handoffPath:'handoff.md',originAgentId:'origin'}),'host','handoff',base);
    f.store.upsertLane({key:'ready',title:'Ready',aim:'Ready work',repositories:[{path:'/repo',origin:'fixture/repo'}]});
    const text=briefDocument('Revised','Revised scope',`queue:\n  dependsOn: [${prerequisite.reference}]\n  lanes: [ready]\n  complexity: high\n  siblings: false\n  interactive: true\n`);
    const amended=await f.engine.performTaskControl({taskId:f.task().reference!,action:'amend_brief',brief:text,reason:'Correct the routing'});
    assert.deepEqual(amended.dependsOn,[prerequisite.id]);
    assert.deepEqual(amended.lanes,['ready']);
    assert.equal(amended.complexity,'high');
    assert.equal(amended.siblings,false);
    assert.equal(amended.interactive,true);
    for(const field of ['brief','title','dependsOn','lanes','complexity','siblings','interactive'])assert.ok(amended.changes?.includes(field),field);
    const cleared=await f.engine.performTaskControl({taskId:amended.id,action:'amend_brief',brief:briefDocument('Revised','Clear routing'),reason:'Remove routing overrides'});
    assert.deepEqual(cleared.dependsOn,[]);
    assert.deepEqual(cleared.lanes,[]);
    assert.equal(cleared.complexity,null);
  } finally {await f.close();}
});

test('unsupported or dispatched brief routing changes refuse atomically and name every field', async () => {
  const f=fixture(briefDocument('Original brief title','Original'));
  try {
    const before=f.task();
    await assert.rejects(f.engine.performTaskControl({taskId:before.id,action:'amend_brief',brief:briefDocument('Changed','Changed',`queue:\n  complexity: high\n  skipPRReview: true\n  notifyOriginOnCloseout: true\n`),reason:'Try unsupported routing'}),/queue.skipPRReview, queue.notifyOriginOnCloseout/);
    assert.deepEqual(f.task(),before);
    const badLane=briefDocument('Changed','Changed','queue:\n  complexity: high\n  lanes: [missing]\n');
    await assert.rejects(f.engine.performTaskControl({taskId:before.id,action:'amend_brief',brief:badLane,reason:'Bad lane'}),/lane/i);
    assert.deepEqual(f.task(),before);
    f.store.update(before.id,{phase:'working',agentId:'worker'});
    const working=f.task();
    await assert.rejects(f.engine.performTaskControl({taskId:before.id,action:'amend_brief',brief:briefDocument('Changed','Changed','queue:\n  dependsOn: []\n  complexity: high\n'),reason:'Too late'}),/queue.dependsOn, queue.complexity.*before dispatch/);
    assert.deepEqual(f.task(),working);
  } finally {await f.close();}
});

const reportModeQueue=(mode:string)=>`queue:\n  lanes: [reports-a, reports-b]\n${mode}`;
const reportModeCases=[
  {name:'adding report-only mode',before:'',after:'  reportOnly: true\n',fields:['reportOnly']},
  {name:'removing report-only mode',before:'  reportOnly: true\n',after:'',fields:['reportOnly']},
  {name:'turning report-only mode off',before:'  reportOnly: true\n',after:'  reportOnly: false\n',fields:['reportOnly']},
  {name:'adding a report lane',before:'  reportOnly: true\n',after:'  reportOnly: true\n  reportLane: reports-a\n',fields:['reportLane']},
  {name:'removing a report lane',before:'  reportOnly: true\n  reportLane: reports-a\n',after:'  reportOnly: true\n',fields:['reportLane']},
  {name:'changing the report lane',before:'  reportOnly: true\n  reportLane: reports-a\n',after:'  reportOnly: true\n  reportLane: reports-b\n',fields:['reportLane']},
  {name:'removing both delivery fields',before:'  reportOnly: true\n  reportLane: reports-a\n',after:'',fields:['reportOnly','reportLane']},
  {name:'removing delivery frontmatter in a body-only edit',before:'  reportOnly: true\n  reportLane: reports-a\n',after:null,fields:['reportOnly','reportLane']},
];
for(const phase of ['queued','working'] as const) {
  for(const scenario of reportModeCases) test(`amend_brief refuses ${scenario.name} on a ${phase} task and names every delivery field`,async()=>{
    const original=briefDocument('Original brief title','Original',reportModeQueue(scenario.before));
    const f=fixture(original);
    try {
      for(const key of ['reports-a','reports-b'])f.store.upsertLane({key,title:key,aim:'Report delivery',repositories:[{path:'/repo',origin:'fixture/repo'}]});
      f.store.setTaskLanes(f.task(),['reports-a','reports-b']);
      if(phase==='working')f.store.update(f.taskId,{phase,agentId:'worker'});
      const before=f.task(),events=f.store.eventsAll(f.taskId);
      const revised=scenario.after===null?'Revised body without frontmatter':briefDocument('Changed title','Revised',reportModeQueue(scenario.after));
      await assert.rejects(f.engine.performTaskControl({taskId:before.id,action:'amend_brief',brief:revised,reason:'Change delivery mode'}),error=>{
        assert.ok(error instanceof Error);
        assert.match(error.message,/Brief routing changes refused/);
        for(const field of scenario.fields)assert.ok(error.message.includes(`queue.${field}`),error.message);
        assert.match(error.message,/nothing was written/);
        return true;
      });
      assert.deepEqual(f.task(),before,'refusal preserves the brief, delivery mode, routing and version');
      assert.deepEqual(f.store.eventsAll(f.taskId),events,'refusal publishes no amendment or delivery events');
    } finally {await f.close();}
  });
  test(`amend_brief preserves unchanged report-only delivery fields on a ${phase} task`,async()=>{
    const mode='  reportOnly: true\n  reportLane: reports-a\n';
    const f=fixture(briefDocument('Original brief title','Original',reportModeQueue(mode)));
    try {
      for(const key of ['reports-a','reports-b'])f.store.upsertLane({key,title:key,aim:'Report delivery',repositories:[{path:'/repo',origin:'fixture/repo'}]});
      f.store.setTaskLanes(f.task(),['reports-a','reports-b']);
      if(phase==='working')f.store.update(f.taskId,{phase,agentId:'worker'});
      const amended=await f.engine.performTaskControl({taskId:f.taskId,action:'amend_brief',brief:briefDocument('Original brief title','Clarified body',reportModeQueue(mode)),reason:'Clarify the report'});
      const policy=heldBriefQueuePolicy(amended.brief!.text);
      assert.equal(policy.reportOnly,true);
      assert.equal(policy.reportLane,'reports-a');
      assert.ok(amended.changes?.includes('brief'));
    } finally {await f.close();}
  });
}

test('amend_brief atomically applies an explicit title and preserves task identity, gates and review history', async () => {
  const originalText = briefDocument('Original brief title', 'Original scope: preserve both behaviours.');
  const f = fixture(originalText);
  try {
    const now = new Date().toISOString();
    const reviewerRun = runSchema.parse({
      id: 'brief-review-run', taskId: f.taskId, role: 'reviewer', generation: 1, head, base,
      agentId: 'reviewer-agent', workspaceId: 'review-workspace', profile: reviewerProfile,
      status: 'finished', createdAt: now, lastObservedAt: now, active: false, idleSince: null,
      completion: { taskId: f.taskId, runId: 'brief-review-run', eventId: 'review-ready', status: 'ready_to_merge', summary: 'Approved', head },
      released: true, briefVersion: 1,
    });
    f.store.putRun(reviewerRun);
    const persistedReviewerRun = f.store.run(reviewerRun.id);
    f.store.update(f.taskId, {
      phase: 'awaiting_review', prUrl: 'https://github.com/example/repo/pull/7', prHead: head,
      briefRuns: [{ runId: reviewerRun.id, version: 1 }],
      resolution: { ...f.task().resolution,
        review: { eventId: 'review-ready', taskId: f.taskId, runId: reviewerRun.id, status: 'ready_to_merge', summary: 'Approved', head },
        reviews: [{ runId: reviewerRun.id, agentId: reviewerRun.agentId, head, status: 'ready_to_merge', reviewId: null,
          reviewCommentId: null, at: now, verdicts: [] }],
      },
    });
    const before = f.task();
    const revisedText = briefDocument('Revised task title', 'Narrowed scope: preserve the authenticated review gate.');
    const amended = await f.engine.performTaskControl(taskControlInputSchema.parse({
      taskId: before.id, version: before.version, action: 'amend_brief', brief: revisedText,
      reason: 'The accepted brief amendment narrowed the scope',
    }));

    assert.equal(amended.title, 'Revised task title');
    assert.equal(amended.brief!.text, revisedText);
    assert.equal(amended.handoffText, revisedText);
    assert.deepEqual(amended.briefVersions.map(version => version.version), [1, 2]);
    assert.equal(amended.briefVersions[0].text, originalText);
    assert.equal(amended.briefVersions[1].text, revisedText);
    assert.equal(amended.id, before.id);
    assert.equal(amended.number, before.number);
    assert.equal(amended.prUrl, before.prUrl);
    assert.equal(amended.prHead, before.prHead);
    assert.equal(amended.mergeHold, before.mergeHold);
    assert.equal(f.store.eventsAll(f.taskId).filter(event => event.kind.startsWith('brief_') && event.kind.endsWith('_changed')).length, 0);
    assert.deepEqual(amended.briefRuns, before.briefRuns);
    assert.deepEqual(amended.resolution.review, before.resolution.review);
    assert.deepEqual(amended.resolution.reviews, before.resolution.reviews);
    assert.deepEqual(f.store.run(reviewerRun.id), persistedReviewerRun);
    assert.equal(f.store.eventsAll(f.taskId).filter(event => event.kind === 'brief_amended').length, 1);
  } finally { await f.close(); }
});

test('amend_brief preserves the task title when the accepted amendment supplies only body text', async () => {
  const f = fixture(briefDocument('Original brief title', 'Original body.'));
  try {
    const before = f.task();
    const revisedBody = 'The body scope is clarified without a replacement title.';
    const amended = await f.engine.performTaskControl(taskControlInputSchema.parse({
      taskId: before.id, version: before.version, action: 'amend_brief', brief: revisedBody, reason: 'Clarify body only',
    }));
    assert.equal(amended.title, before.title);
    assert.equal(amended.brief!.text, revisedBody);
    assert.deepEqual(amended.briefVersions.map(version => version.text), [before.brief!.text, revisedBody]);
  } finally { await f.close(); }
});

test('amend_brief refusals leave the brief, title, gate and event history unchanged', async () => {
  const f = fixture(briefDocument('Original brief title', 'Original body.'));
  try {
    const attempt = async (version: number, brief: string, reason: string, expected: RegExp) => {
      const before = f.task();
      const eventsBefore = f.store.eventsAll(f.taskId);
      await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({
        taskId: f.taskId, version, action: 'amend_brief', brief, reason,
      })), expected);
      assert.deepEqual(f.task(), before);
      assert.deepEqual(f.store.eventsAll(f.taskId), eventsBefore);
    };
    const original = f.task();
    await attempt(original.version, original.brief!.text, 'Identical content', /identical/);
    await attempt(original.version, '---\ntitle: [\n---\nMalformed frontmatter', 'Malformed document', /Invalid or duplicate brief frontmatter/);

    const advanced = f.store.update(f.taskId, { reason: 'Advance the task version' });
    await attempt(advanced.version - 1, briefDocument('New title', 'New body.'), 'Stale amendment', /Task changed; refresh before retrying/);

    const fenced = f.store.update(f.taskId, {
      disposition: dispositionSchema.parse({ kind: 'cancel', status: 'intent', requestedAt: new Date().toISOString(),
        requestedBy: 'operator', reason: 'Disposition owns the task', workDisposition: 'preserve' }),
    });
    await attempt(fenced.version, briefDocument('New title', 'New body.'), 'Fenced amendment', /Disposition fence is active/);
  } finally { await f.close(); }
});

test('amend_brief refuses after merge without changing the accepted title or brief history', async () => {
  const f = fixture(briefDocument('Original brief title', 'Original body.'));
  try {
    const merged = f.store.update(f.taskId, { resolution: { ...f.task().resolution, mergedCommit: 'c'.repeat(40) } });
    const eventsBefore = f.store.eventsAll(f.taskId);
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({
      taskId: merged.id, version: merged.version, action: 'amend_brief',
      brief: briefDocument('New title', 'New body.'), reason: 'Too late',
    })), /refused once the task has merged/);
    assert.deepEqual(f.task(), merged);
    assert.deepEqual(f.store.eventsAll(f.taskId), eventsBefore);
  } finally { await f.close(); }
});

test('a coordination note is recorded as an event without adding a brief version', async () => {
  const f = fixture(briefDocument('Original brief title', 'Original body.'));
  try {
    const before = f.task();
    const result = await f.engine.performTaskControl(taskControlInputSchema.parse({
      taskId: before.id, version: before.version, action: 'note', message: 'The reviewer is picking this up next.',
    }));
    assert.equal(result.version, before.version);
    assert.deepEqual(result.briefVersions, before.briefVersions);
    assert.deepEqual(f.events('coordination_note').map(event => event.detail), ['The reviewer is picking this up next.']);
    assert.throws(() => taskControlInputSchema.parse({
      taskId: before.id, version: before.version, action: 'amend_brief', message: 'Routine update', brief: 'Brief', reason: 'Update',
    }), /coordination message is only valid for note/);
  } finally { await f.close(); }
});

/** The task is parked with a retained pre-PR worker and no PR. */
function stoppedWorker(f: ReturnType<typeof fixture>, overrides: Partial<Task> = {}) {
  f.store.update(f.taskId, {
    phase: 'needs_attention', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
    agentId: 'worker-agent', runId: 'worker-run', profile: workerProfile, workerModel: workerProfile.model,
    resolution: { ...f.task().resolution, currentRunId: null, attention: true },
    ...overrides,
  });
  return f.task();
}

const workerInstruction = (task: Task): string =>
  task.resolution.pendingWorkerInstruction ?? task.resolution.prePrResumeInstruction ?? '';

test('every engine relayed-note action is admitted by the task-control validator', () => {
  const engineRelayedNoteActions = [
    'set_routing', 'route', 'exclude_worker', 'move', 'retry_effect', 'proof', 'accept_receipt', 'restart', 'extend_budget',
  ];
  assert.deepEqual(TASK_CONTROL_RELAYED_NOTE_ACTIONS, engineRelayedNoteActions);
  const required: Record<string, Record<string, unknown>> = {
    set_routing: { scope: 'general' },
    route: { role: 'worker', profileId: 'worker' },
    exclude_worker: { workerExclusion: { agentId: 'worker-agent' } },
    move: { to: 'merge', qualification: 'Accept the reviewed head', head },
    retry_effect: { effect: 'workspace_archive.workspace' },
    proof: {},
    accept_receipt: {},
    restart: {},
    extend_budget: {},
  };
  for (const action of TASK_CONTROL_RELAYED_NOTE_ACTIONS) {
    const parsed = taskControlInputSchema.safeParse({ taskId: 't', version: 1, action,
      ...required[action], reason: 'operator ruling', caller: 'planner', relayed: true, note: 'Tom approved this action' });
    assert.equal(parsed.success, true, `${action} must accept its relayed operator note`);
  }
  assert.equal(taskControlInputSchema.safeParse({ taskId: 't', version: 1, action: 'hold', relayed: true, note: 'ruling' }).success, false);
});

test('every registered verb maps to a live queue.task action and declares its input', () => {
  // What each mapped action needs beyond the derived identities, so the parse
  // here is exactly what an owner adds after copying the args.
  const ownerFields: Record<string, Record<string, unknown>> = {
    route: { role: 'worker', profileId: 'worker', reason: 'owner ruling' },
    rereview: { reason: 'operator reason' },
    resume_worker: { instruction: 'continue the task' },
    revise: { instruction: 'continue the task' },
    restart: { reason: 'owner reason' },
    move: { to: 'review', reason: 'owner reason' },
    retry_effect: { reason: 'owner reason' },
    complete: { reason: 'owner reason' },
    stop: { reason: 'owner reason' },
    proof: { reason: 'owner reason' },
    accept_receipt: { reason: 'owner reason' },
    extend_budget: { reason: 'owner reason' },
    set_dependencies: { dependsOn: [] },
  };
  for (const verb of ownerVerbs) {
    assert.ok(taskControlInputSchema.safeParse({
      taskId: 't', version: 1, action: verb.action, ...(ownerFields[verb.verb] ?? {}),
    }).success, `${verb.verb} must map to a catalogued queue.task action`);
    assert.ok(verb.input.safeParse({ taskId: 't', version: 1, ...(ownerFields[verb.verb] ?? {}) }).success,
      `${verb.verb} must accept taskId and version plus the fields it requires the owner to fill`);
  }
});

test('task.next input needs exactly one of taskId or reference', () => {
  assert.equal(taskNextInputSchema.safeParse({}).success, false);
  assert.equal(taskNextInputSchema.safeParse({ taskId: 't', reference: 'r' }).success, false);
  assert.equal(taskNextInputSchema.safeParse({ taskId: 't' }).success, true);
  assert.equal(taskNextInputSchema.safeParse({ reference: 'owner/name#12' }).success, true);
});

test('a fresh queued task lists routing and the stop that can park its dispatch', async () => {
  const f = fixture(); try {
    const view = f.next();
    assert.equal(view.phase, 'queued');
    assert.equal(view.workerDemandStep, 'first attempt: one step down (normal usage level)');
    assert.equal(view.stop?.kind, 'wait');
    assert.equal(view.stop?.reason, 'capacity');
    assert.equal(view.stop?.detail, 'Waiting for dispatch');
    assert.deepEqual(view.stop?.suggestedVerbs, []);
    assert.equal(view.stop?.owner, 'queue');
    assert.equal(view.stop?.evidence, null);
    assert.equal(view.activeRun, null);
    assert.ok(view.verbs.length >= 5);
    assert.ok(view.verbs.filter(verb => verb.verb === 'route' && verb.available).length === 3,
      'route is listed once for each role, each prefilled');
    assert.deepEqual(view.verbs.filter(verb => verb.available && verb.verb !== 'route').map(verb => verb.verb), ['stop','set_dependencies'],
      'owners can park dispatch or edit prerequisites before an agent starts');
    const stopped = await f.engine.stopTask(taskControlInputSchema.parse({ action: 'stop', taskId: f.taskId, version: f.task().version, reason: 'Park dispatch' }));
    assert.ok(holdsOf(stopped).dispatch);
  } finally { await f.close(); }
});

test('a held queued task reports a held stop from its fence, not its creation-time dispatch wait', async () => {
  const f = fixture(); try {
    const held = f.store.update(f.task().id, holdPatch(f.task(), 'dispatch', 'owner-thread', 'Owner gate: wait for the milestone'));
    assert.equal(held.reason, 'Waiting for dispatch', 'a held submission keeps its creation-time reason');
    const view = f.next();
    assert.equal(view.stop?.kind, 'hold');
    assert.equal(view.stop?.reason, 'held');
    assert.deepEqual(view.stop?.suggestedVerbs, []);
    assert.equal(view.stop?.detail, 'Owner gate: wait for the milestone');
    assert.equal(view.stop?.owner, 'owner-thread');
    assert.equal(view.stop?.since, holdsOf(held).dispatch!.at);
  } finally { await f.close(); }
});

test('next reads a stalled initial worker with no result: the stop names it and the active run is its task-row binding (Consumer #581)', async () => {
  const f = fixture(); try {
    // Valid initial-worker storage: the binding lives on the task row; the only stored run is an old superseded revision.
    f.store.putRun(runSchema.parse({ id: 'old-revision', taskId: f.taskId, role: 'revision', generation: 1, head: 'a'.repeat(40), base: 'a'.repeat(40),
      agentId: 'old-agent', workspaceId: 'workspace', profile: workerProfile, status: 'superseded', createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      lastObservedAt: null, active: false, idleSince: null, completion: null, released: true }));
    f.store.update(f.taskId, { phase: 'working', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
      agentId: 'initial-agent', runId: 'initial-run', profile: workerProfile, completion: null,
      resolution: { ...f.task().resolution, currentRunId: null, stop: taskStopRecord('run_stalled', 'The worker turn stopped making progress', null, new Date().toISOString(), ['restart']) } });
    const view = f.next();
    assert.equal(view.stop?.kind, 'run');
    assert.equal(view.stop?.reason, 'run_stalled');
    assert.match(view.stop!.evidence!, /^worker run initial-run \(agent initial-agent\) has no recorded result/);
    assert.equal(view.activeRun?.runId, 'initial-run', 'the live binding, not the stale superseded revision');
    assert.equal(view.activeRun?.role, 'worker');
    assert.equal(view.activeRun?.agentId, 'initial-agent');
    assert.equal(f.store.runs(f.taskId).length, 1, 'no run row is inserted');
  } finally { await f.close(); }
});

test('the initial worker binding never outranks a later run, and a stopped or completed binding is not an active participant', async () => {
  const f = fixture(); try {
    // An accepted revision resolved the initial worker's missing-callback incident, which still carries the initial run ID.
    f.store.putRun(runSchema.parse({ id: 'revision-1', taskId: f.taskId, role: 'revision', generation: 1, head: 'a'.repeat(40), base: 'a'.repeat(40),
      agentId: 'initial-agent', workspaceId: 'workspace', profile: workerProfile, status: 'finished', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: false, idleSince: null, released: true,
      completion: { taskId: f.taskId, runId: 'revision-1', eventId: 'rev-ready', status: 'ready_for_review', summary: 'Revision ready', prNumber: 7 } }));
    f.store.update(f.taskId, { phase: 'awaiting_review', agentId: 'initial-agent', runId: 'initial-run', profile: workerProfile,
      completion: { taskId: f.taskId, runId: 'revision-1', eventId: 'rev-ready', status: 'ready_for_review', summary: 'Revision ready', prNumber: 7 },
      resolution: { ...f.task().resolution, currentRunId: null, stop: null,
        incident: incidentSchema.parse({ id: 'old-incident', runId: 'initial-run', role: 'worker', cause: 'missing_callback', status: 'resolved', detail: 'Superseded by the accepted revision', attempt: 0, action: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }) } });
    assert.equal(f.next().activeRun, null, 'the released later revision is history, not a live participant, and the historical binding is not resurrected');
    // A stalled initial worker whose stop Queue observed stopped has released its lease.
    f.store.update(f.taskId, { phase: 'working', completion: null,
      resolution: { ...f.task().resolution, incident: null, stop: taskStopRecord('run_stalled', 'The worker turn stopped making progress', null, new Date().toISOString(), ['restart']),
        stalledTurnStop: { runId: 'initial-run', role: 'worker', agentId: 'initial-agent', workspaceId: 'workspace', turnId: 't', effectId: 'e', status: 'stopped', attempts: 1,
          requestedAt: new Date().toISOString(), observedInactiveAt: new Date().toISOString(), detail: '' } } });
    f.store.db.prepare('DELETE FROM runs WHERE id=?').run('revision-1');
    // The stopped stall is history named by the stop, not a live participant.
    assert.equal(f.next().activeRun, null, 'a stopped stall binding is not active');
    assert.match(f.next().stop!.evidence!, /^worker run initial-run \(agent initial-agent\) has no recorded result/);
    // A recorded initial completion is the same history, not a live binding.
    f.store.update(f.taskId, { resolution: { ...f.task().resolution, stalledTurnStop: null },
      completion: { taskId: f.taskId, runId: 'initial-run', eventId: 'initial-blocked', status: 'blocked', summary: 'Needs a decision' } });
    assert.equal(f.next().activeRun, null, 'a completed initial binding is not active');
    assert.equal(f.next().stop?.detail, 'Needs a decision', 'the stop keeps the result evidence');
  } finally { await f.close(); }
});

test('#381: an open incident of another role, or a revision-superseded initial worker, never shows the initial worker running', async () => {
  const f = fixture(); try {
    const incident = (role: 'worker' | 'coordinator') => incidentSchema.parse({ id: `${role}-incident`, runId: 'initial-run', role, cause: 'uncertain_delivery', status: 'escalated',
      detail: 'The coordinator cannot settle this stop', attempt: 0, action: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    // A held verifying task whose coordinator incident inherited the initial run ID (incidentKey falls back to task.runId).
    f.store.putRun(runSchema.parse({ id: 'recovery-1', taskId: f.taskId, role: 'recovery', generation: 1, head, base,
      agentId: 'coord-agent', workspaceId: 'workspace', profile: workerProfile, status: 'finished', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: false, idleSince: null, released: true,
      completion: { taskId: f.taskId, runId: 'recovery-1', eventId: 'rec-blocked', status: 'blocked', summary: 'Correctly parked' } }));
    f.store.update(f.taskId, { phase: 'verifying', agentId: 'initial-agent', runId: 'initial-run', profile: workerProfile, completion: null,
      resolution: { ...f.task().resolution, currentRunId: null, stop: null, incident: incident('coordinator') } });
    assert.equal(f.next().activeRun, null, 'the released coordinator incident run is history, not a live participant');
    // A worker incident at that run still names it.
    f.store.update(f.taskId, { resolution: { ...f.task().resolution, incident: incident('worker') } });
    assert.equal(f.next().activeRun?.runId, 'initial-run');
    assert.equal(f.next().activeRun?.status, 'running');
    // Once a revision of the same worker delivered a result, the initial run is history.
    f.store.putRun(runSchema.parse({ id: 'revision-1', taskId: f.taskId, role: 'revision', generation: 1, head, base,
      agentId: 'initial-agent', workspaceId: 'workspace', profile: workerProfile, status: 'finished', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: false, idleSince: null, released: true,
      completion: { taskId: f.taskId, runId: 'revision-1', eventId: 'rev-ready', status: 'ready_for_review', summary: 'Revision ready', prNumber: 7 } }));
    assert.equal(f.next().activeRun, null, 'the released revision superseded the initial binding and no participant is live');
  } finally { await f.close(); }
});

test('next reads a stalled resolution run with no result without dereferencing a completion', async () => {
  const f = fixture(); try {
    f.store.putRun(runSchema.parse({ id: 'stalled-review', taskId: f.taskId, role: 'reviewer', generation: 1, head: 'a'.repeat(40), base: 'a'.repeat(40),
      agentId: 'review-agent', workspaceId: 'workspace', profile: reviewerProfile, status: 'running', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: true, idleSince: null, completion: null, released: false }));
    f.store.update(f.taskId, { phase: 'reviewing', completion: null,
      resolution: { ...f.task().resolution, currentRunId: 'stalled-review', stop: taskStopRecord('run_stalled', 'The reviewer turn stopped making progress', null, new Date().toISOString(), ['restart']) } });
    const view = f.next();
    assert.match(view.stop!.evidence!, /^reviewer run stalled-review \(agent review-agent\) has no recorded result/);
    assert.equal(view.activeRun?.runId, 'stalled-review');
  } finally { await f.close(); }
});

test('a genuine completed report keeps its evidence on the run stop, and a hold still takes precedence', async () => {
  const f = fixture(); try {
    f.store.update(f.taskId, { phase: 'blocked', agentId: 'worker-agent', runId: 'worker-run', profile: workerProfile,
      completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'worker-blocked', status: 'blocked', summary: 'Needs the scope decision' } });
    const view = f.next();
    assert.equal(view.stop?.kind, 'run');
    assert.equal(view.stop?.detail, 'Needs the scope decision');
    assert.equal(view.stop?.evidence, 'worker run worker-run reported blocked (worker-blocked)');
    f.store.update(f.taskId, holdPatch(f.task(), 'merge', 'owner-thread', 'Owner gate'));
    assert.equal(f.next().stop?.kind, 'hold', 'a hold fence still wins over the run stop');
  } finally { await f.close(); }
});

test('route views prefill each role and ask for a profile only when none is recorded', async () => {
  const f = fixture(); try {
    // The stopped worker retains the worker profile; reviewer and coordinator
    // have no current profile, so only their views ask the owner for one.
    stoppedWorker(f);
    const verbs = f.next().verbs.filter(entry => entry.verb === 'route' && entry.available);
    assert.equal(verbs.length, 3);
    const roleOf = (entry: (typeof verbs)[number]) => (entry.args as Record<string, unknown>).role;
    assert.deepEqual(verbs.map(roleOf), ['worker', 'reviewer', 'coordinator']);
    assert.equal((verbs[0].args as Record<string, unknown>).profileId, 'worker');
    assert.deepEqual(verbs[0].fill, ['reason']);
    assert.equal((verbs[1].args as Record<string, unknown>).profileId, '');
    assert.deepEqual(verbs[1].fill, ['profileId', 'reason']);
    assert.deepEqual(verbs[2].fill, ['profileId', 'reason']);
  } finally { await f.close(); }
});
test('an available verb always carries args and a refused one always names its refusal', async () => {
  const f = fixture(); try {
    stoppedWorker(f);
    for (const verb of f.next().verbs) {
      if (verb.available) { assert.ok(verb.args && Object.keys(verb.args).length >= 2, JSON.stringify(verb)); assert.equal(verb.refusal, undefined); }
      else { assert.ok(verb.refusal && verb.refusal.length > 0, JSON.stringify(verb)); assert.equal(verb.args, undefined); }
    }
  } finally { await f.close(); }
});

test('needs_attention with an escalated recovery: restart resumes the stopped worker and settles the episode', async () => {
  const f = fixture(); try {
    const task = stoppedWorker(f);
    f.engine.resolution.recovery.escalate(task, 'Coordinator recovery could not safely continue: the thread never reported');
    f.store.putNotice({ id: 'attention', taskId: f.taskId, agentId: 'origin', recipientAgentId: 'origin', workspaceId: null, sources: [], originEntry: true, kind: 'attention', status: 'pending', error: '', text: 'Needs attention' });

    const view = f.next();
    assert.equal(view.stop?.kind, 'incident');
    // Round 4: one restart resumes the stopped worker; its escalation is backed
    // by the task's own fault, so the restart settles it rather than answering it.
    const retry = f.view('restart');
    assert.equal(retry.available, true, JSON.stringify(retry));
    assert.equal((retry.args as Record<string, unknown>).role, 'worker');
    f.observations.set('worker-agent', { id: 'worker-agent', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });

    const nudged = await f.engine.performTaskControl(taskControlInputSchema.parse({ ...retry.args, reason: 'The thread is reachable again', caller: CALLER }));
    assert.equal(nudged.resolution.attention, false);
    assert.notEqual(nudged.resolution.recovery?.status, 'escalated', 'the restart settles the escalated episode');
    assert.equal(JSON.parse(f.events('owner_control').at(-1)!.detail).verb, 'restart');
  } finally { await f.close(); }
});

test('a finished task with an escalated recovery: restart answers it with complete args and queue.task accepts them (round 4)', async () => {
  const f = fixture(); try {
    const timestamp = new Date().toISOString();
    f.store.update(f.taskId, {
      phase: 'cancelled', reason: 'Operator disposed the answered escalation',
      disposition: dispositionSchema.parse({ kind: 'cancel', status: 'complete', requestedAt: timestamp, requestedBy: 'operator control',
        reason: 'Operator disposed the answered escalation', workDisposition: 'preserve', effects: [], completedAt: timestamp }),
      resolution: { ...f.task().resolution, attention: true },
    });
    f.engine.resolution.recovery.escalate(f.task(), 'Operator disposition required before closeout can continue');
    f.store.putNotice({ id: 'attention', taskId: f.taskId, agentId: 'origin', recipientAgentId: 'origin', workspaceId: null, sources: [], originEntry: true, kind: 'attention', status: 'pending', error: '', text: 'Needs attention' });

    const verb = f.view('restart');
    assert.equal(verb.available, true, JSON.stringify(verb));
    assert.deepEqual(verb.args, { action: 'restart', taskId: f.taskId, version: f.task().version });
    assert.deepEqual(verb.fill, ['reason']);

    const resolved = await f.engine.performTaskControl(taskControlInputSchema.parse({
      ...verb.args, reason: 'The incident question was answered on the thread', caller: CALLER }));
    assert.equal(resolved.resolution.recovery?.status, 'resolved');
    assert.equal(resolved.resolution.incident?.status, 'resolved');
    assert.equal(resolved.resolution.attention, false);
    const audit = f.events('owner_control');
    assert.equal(audit.length, 1);
    const recorded = JSON.parse(audit[0].detail);
    assert.equal(recorded.verb, 'restart');
    assert.equal(recorded.caller, CALLER);
    assert.equal('ownerThread' in recorded, false, 'the retired owner bit no longer records');
    assert.equal(recorded.phaseBefore, 'cancelled');
    assert.equal(recorded.phaseAfter, 'cancelled', 'answering the escalation never decides the task');
    assert.equal(recorded.reason, 'The incident question was answered on the thread');
  } finally { await f.close(); }
});



test('a control without a caller keeps the legacy record and writes no owner_control event', async () => {
  const f = fixture(); try {
    const timestamp = new Date().toISOString();
    f.store.update(f.taskId, {
      phase: 'cancelled',
      disposition: dispositionSchema.parse({ kind: 'cancel', status: 'complete', requestedAt: timestamp, requestedBy: 'operator control',
        reason: 'Finished before the escalation', workDisposition: 'preserve', effects: [], completedAt: timestamp }),
    });
    f.engine.resolution.recovery.escalate(f.task(), 'Needs an owner answer');
    await f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: f.taskId, version: f.task().version, action: 'restart', reason: 'answered' }));
    assert.equal(f.events('owner_control').length, 0);
    assert.ok(f.events('operator_control').length >= 1);
  } finally { await f.close(); }
});

test('a blocked pre-PR worker: restart resumes it with one instruction', async () => {
  const f = fixture(); try {
    f.store.update(f.taskId, {
      phase: 'blocked', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
      agentId: 'worker-agent', runId: 'worker-run', profile: workerProfile, workerModel: workerProfile.model,
      completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'blocked-callback', status: 'blocked', summary: 'Tool unavailable' },
    });
    // restart observes the retained worker idle before resuming it (Spec 050 observed liveness).
    f.observations.set('worker-agent', { id: 'worker-agent', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
    const verb = f.view('restart');
    assert.equal(verb.available, true, JSON.stringify(verb));
    assert.equal((verb.args as Record<string, unknown>).action, 'restart');
    assert.equal(f.next().stop?.kind, 'run');
    assert.match(f.next().stop!.evidence!, /reported blocked/);

    const resumed = await f.engine.performTaskControl(taskControlInputSchema.parse({
      ...verb.args, reason: 'The tool is back', instruction: 'Retry the tool now that it is back', caller: CALLER }));
    assert.equal(resumed.phase, 'changes_requested');
    assert.equal(workerInstruction(resumed), 'Retry the tool now that it is back');
    assert.equal(JSON.parse(f.events('owner_control').at(-1)!.detail).verb, 'restart');
  } finally { await f.close(); }
});

test('a blocked task behind its retained PR: restart re-runs the parked step with no other lookup', async () => {
  const f = fixture(); try {
    f.store.putRun(runSchema.parse({
      id: 'revision-run', taskId: f.taskId, role: 'revision', generation: 1, head, base, agentId: 'worker-agent', workspaceId: 'workspace',
      profile: workerProfile, status: 'finished', createdAt: new Date().toISOString(), lastObservedAt: null,
      active: false, idleSince: null, completion: { taskId: f.taskId, runId: 'revision-run', eventId: 'revision-blocked', status: 'blocked', summary: 'Conflict with main' },
      released: true,
    }));
    f.store.update(f.taskId, {
      phase: 'blocked', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
      agentId: 'worker-agent', runId: 'worker-run', profile: workerProfile, workerModel: workerProfile.model,
      resumePrNumber: 7, prHead: head, prUrl: 'https://github.com/example/repo/pull/7',
      completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'blocked-callback', status: 'blocked', summary: 'Conflict with main' },
    });
    const verb = f.view('restart');
    assert.equal(verb.available, true, JSON.stringify(verb));
    // Tom 2026-10-23: the offered default carries no role (routing by the blocking
    // run, here the worker's own revision), and the note names role "worker".
    assert.deepEqual(verb.args, { action: 'restart', taskId: f.taskId, version: f.task().version });
    assert.deepEqual(verb.fill, ['reason']);
    assert.match(verb.note ?? '', /Add role: "worker"/);
    f.observations.set('worker-agent', { id: 'worker-agent', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });

    const resumed = await f.engine.performTaskControl(taskControlInputSchema.parse({ ...verb.args, reason: 'Main is fixed; resume', caller: CALLER }));
    assert.equal(resumed.phase, 'changes_requested');
    assert.equal(JSON.parse(f.events('owner_control').at(-1)!.detail).verb, 'restart');
  } finally { await f.close(); }
});

test('a stopped working worker with a missing callback: restart returns it to work', async () => {
  const f = fixture(); try {
    stoppedWorker(f, { resolution: { ...f.task().resolution, attention: true, incident: incidentSchema.parse({
      id: 'incident-1', role: 'worker', runId: 'worker-run', fingerprint: '', attempt: 1, cause: 'missing_callback',
      detail: 'One bounded callback reminder issued', action: 'callback_reminder', status: 'reconciling',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }) } });
    const view = f.next();
    assert.equal(view.stop?.kind, 'incident');
    f.observations.set('worker-agent', { id: 'worker-agent', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
    const verb = f.view('restart');
    assert.equal(verb.available, true, JSON.stringify(verb));
    const resumed = await f.engine.performTaskControl(taskControlInputSchema.parse({
      ...verb.args, reason: 'The turn was not delivered', instruction: 'Your last turn was not delivered; continue from the retained workspace', caller: CALLER }));
    assert.equal(resumed.phase, 'changes_requested');
    assert.equal(f.events('owner_control').length, 1);
  } finally { await f.close(); }
});

/** A reviewing task whose reviewer reported one checkpoint, as Spec 044 records it. */
function reviewing(f: ReturnType<typeof fixture>, reviewer = reviewerProfile) {
  f.store.update(f.taskId, {
    phase: 'reviewing', planningBase: base, workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
    agentId: 'worker-agent', runId: 'worker-run', profile: workerProfile, workerModel: workerProfile.model, prHead: head,
    prUrl: 'https://github.com/example/repo/pull/7',
    completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'worker-ready', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
  });
  const runId = 'review-run';
  f.store.putRun(runSchema.parse({
    id: runId, taskId: f.taskId, role: 'reviewer', generation: 1, head, base, agentId: 'review-agent', workspaceId: 'workspace',
    profile: reviewer, status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null,
    active: true, idleSince: null, completion: null, released: false,
  }));
  f.store.setCredential(runId, 'token');
  f.store.update(f.taskId, { resolution: { ...f.task().resolution, currentRunId: runId, reviewerAgentId: 'review-agent', reviewerProfile: reviewer } });
  f.observations.set('review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '', provider: 'test', model: reviewer.model });
  const deliveries: { runId: string; messageId: string; text: string }[] = [];
  const timeline: { timestamp: string; item: { type: string; messageId: string; text: string } }[] = [];
  const adapter = f.adapter as Adapter & { verifyPr?: unknown; continueReviewer?: unknown; agentTimeline?: unknown };
  adapter.verifyPr = async () => ({ url: 'https://github.com/example/repo/pull/7', head: f.store.task(f.taskId).prHead ?? head });
  adapter.continueReviewer = async (_task: Task, run: Run, messageId: string, text: string, allowed: () => Promise<boolean>, stillAllowed: () => boolean) => {
    if (!await allowed()) return { sent: false as const, reason: 'authorization changed' };
    if (!stillAllowed()) return { sent: false as const, reason: 'fence changed' };
    deliveries.push({ runId: run.id, messageId, text });
    timeline.push({ timestamp: new Date().toISOString(), item: { type: 'user_message', messageId, text } });
    return { sent: true as const };
  };
  adapter.agentTimeline = async () => timeline;
  // Settle the wake the receipt schedules, so a version read for the control
  // never races the checkpoint stop record (milestone QA a43d6304).
  // The reader reports from inside its own turn (see whileReaderInTurn).
  const report = () => whileReaderInTurn(f.engine, f.store.run(runId)!.agentId, () => f.engine.complete({ eventId: 'cp-1', taskId: f.taskId, runId, status: 'review_in_progress',
    summary: 'Reading budget exhausted', head, checkpoint: { covered: ['Harness one'], remaining: ['Harness two'] } }, 'token'));
  return { runId, deliveries, report };
}

async function acceptControl(f: ReturnType<typeof fixture>, control: TaskControlInput) {
  const accepted = await f.engine.startOperation({ key: `owner-verbs-${randomUUID()}`, kind: 'task_control', payload: { type: 'task_control', control }, taskId: control.taskId, expectedVersion: control.version });
  if ('backpressured' in accepted) throw new Error('owner verb operation was unexpectedly backpressured');
  return f.engine.awaitOperation(accepted.operation.id, 10_000);
}

test('an owner-routed reviewer on the author model can continue its checkpoint', async () => {
  const f = fixture(); try {
    // A reviewer profile that shares the author's model; only the owner `route`
    // can request it, and Spec 050 makes independence a preference, not a gate.
    const shared = profile('shared-reviewer', workerProfile.model);
    f.store.setMeta('pool', [...f.store.pool(), { profileId: shared.id, enabled: true, group: 'review', roles: ['reviewer'], weight: 1, scopes: ['general'] }]);
    f.engine.profiles = [...f.engine.profiles, shared];
    // The direct write simulates an owner `route`, so it carries the
    // route-only marker; without it the same-model reviewer is refused.
    f.store.update(f.taskId, { profileRequests: { ...f.task().profileRequests, reviewer: { profileId: shared.id, reason: 'Owner chose this reviewer', required: true, ownerRoute: true } } });
    const review = reviewing(f, shared);
    const receipt = await review.report();
    assert.equal(receipt.accepted, true);
    const verb = f.view('restart');
    assert.equal(verb.available, true, JSON.stringify(verb));
    const outcome = await acceptControl(f, taskControlInputSchema.parse({
      ...verb.args, reason: 'The owner routed this reviewer; finish the checkpoint', instruction: 'Continue from the saved checkpoint', caller: CALLER }));
    assert.equal(outcome.state, 'succeeded', 'the same-model owner-routed reviewer continues on its own run');
    assert.equal(review.deliveries.length, 1);
  } finally { await f.close(); }
});

test('a checkpointed review: restart role=reviewer continues it; Queue derives the exact run, head and ordinal', async () => {
  const f = fixture(); try {
    const review = reviewing(f);
    const receipt = await review.report();
    assert.equal(receipt.accepted, true);
    const verb = f.view('restart');
    assert.equal(verb.available, true, JSON.stringify(verb));
    assert.deepEqual(verb.args, { action: 'restart', taskId: f.taskId, version: f.task().version, role: 'reviewer' });
    assert.deepEqual(verb.fill, ['reason']);
    // The settled stop: a lifecycle wait, since Queue continues the checkpoint
    // itself once the reader's turn ends (Tom, 2026-10-31); the owner may still
    // continue it now.
    assert.equal(f.next().stop?.reason, 'lifecycle');
    assert.match(f.next().stop!.detail, /saved a checkpoint/);
    assert.deepEqual(f.store.run(review.runId)!.reviewCheckpoints?.map(item => item.ordinal), [1], 'the stop is checkpoint 1 of this run');

    const outcome = await acceptControl(f, taskControlInputSchema.parse({
      ...verb.args, reason: 'The covered set is sufficient; finish the remaining figures', instruction: 'Continue from the saved checkpoint', caller: CALLER }));
    assert.equal(outcome.state, 'succeeded');
    assert.equal(review.deliveries.length, 1);
    assert.equal(JSON.parse(f.events('owner_control').at(-1)!.detail).verb, 'restart');
    assert.ok(existsSync(reviewCheckpointPathFor(f.store, f.taskId, review.runId, 1)));
    assert.equal(f.store.run(review.runId)!.reviewDeliveries?.[0].status, 'delivered');
  } finally { await f.close(); }
});

test('fresh review displaces a checkpoint wait with an existing result or another unreleased reviewer', async () => {
  for (const fence of ['result', 'run'] as const) {
    const f = fixture(); try {
      const review = reviewing(f);
      assert.equal((await review.report()).accepted, true);
      f.store.setMeta('paused', true);
      const before = f.store.run(review.runId)!;
      const result = completionSchema.parse({ taskId: f.taskId, runId: review.runId, eventId: 'review-environment-block',
        status: 'blocked', summary: 'No findings; review environment unavailable', head, reviewResponsibility: 'environment' });
      if (fence === 'result') f.store.update(f.taskId, { resolution: { ...f.task().resolution, review: result } });
      else {
        f.store.putRun({ ...before, id: 'other-review-run', agentId: 'other-review-agent', reviewCheckpoints: [] });
        f.observations.set('other-review-agent', { id: 'other-review-agent', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
      }
      const fresh = f.next().verbs.find(verb => verb.available && verb.args?.to === 'review' && verb.args?.fresh === true);
      assert.ok(fresh, `${fence}: next offers the fresh-review exit`);
      const outcome = await acceptControl(f, taskControlInputSchema.parse({ ...fresh.args,
        reason: 'Replace the checkpointed round at the current head', caller: CALLER }));
      assert.equal(outcome.state, 'succeeded', `${fence}: ${outcome.diagnostic}`);
      assert.equal(f.task().phase, 'awaiting_review');
      assert.equal(f.task().prHead, head);
      assert.equal(f.task().resolution.currentRunId, null);
      assert.equal(f.task().resolution.reviewerAgentId, null);
      assert.equal(f.task().resolution.review, null);
      assert.equal(review.deliveries.length, 0, 'replacement never sends a checkpoint continuation');
      const displaced = f.store.run(review.runId)!;
      assert.equal(displaced.status, 'superseded');
      assert.ok(displaced.replacedAt);
      assert.deepEqual(displaced.reviewCheckpoints, before.reviewCheckpoints, 'saved coverage remains history');
      if (fence === 'result') assert.deepEqual(f.task().resolution.reviewSupersessions.at(-1)?.review, result);
      else {
        assert.equal(f.store.run('other-review-run')!.status, 'superseded');
        assert.ok(f.store.run('other-review-run')!.replacedAt, 'every stopped reviewer becomes history');
      }
    } finally { await f.close(); }
  }
});

test('an aged queue checkpoint wait suggests available exits while holds and unknown effects keep their fences', async () => {
  const f = fixture(); try {
    const review = reviewing(f);
    assert.equal((await review.report()).accepted, true);
    f.store.setMeta('paused', true);
    f.store.setMeta('stallThresholdMinutes', 1);
    assert.deepEqual(f.next().stop?.suggestedVerbs, [], 'a new lifecycle wait has time to settle');
    const aged = { ...f.task().resolution.stop!, since: new Date(Date.now() - 61_000).toISOString() };
    f.store.update(f.taskId, { resolution: { ...f.task().resolution, stop: aged } });
    assert.ok(f.next().stop?.suggestedVerbs.includes('restart'));
    assert.ok(f.next().stop?.suggestedVerbs.includes('move'));

    const before = f.store.run(review.runId)!;
    f.store.putRun({ ...before, id: 'unknown-run', reviewCheckpoints: [], status: 'uncertain' });
    const fenced = f.next();
    assert.ok(!fenced.verbs.some(verb => verb.available && verb.verb === 'move'
      && ['work', 'review', 'merge'].includes(String(verb.args?.to))), 'unknown delivery never offers displacement');
    assert.ok(!fenced.verbs.some(verb => verb.available && verb.args?.fresh === true && verb.args?.to === 'review'));
    f.store.putRun({ ...f.store.run('unknown-run')!, status: 'superseded', released: true });

    f.store.update(f.taskId, holdPatch(f.task(), 'dispatch', 'owner-thread', 'Wait for the owner'));
    assert.equal(f.next().stop?.kind, 'hold');
    assert.deepEqual(f.next().stop?.suggestedVerbs, []);
  } finally { await f.close(); }
});

test('a reviewer restart applies over a stale pending recovery episode and settles it with the continuation', async () => {
  const f = fixture(); try {
    const review = reviewing(f);
    assert.equal((await review.report()).accepted, true);
    // An agentless pending episode left by an earlier stop: next lists the verb, so the verb must apply.
    const current = f.task();
    f.store.update(f.taskId, { resolution: { ...current.resolution, recovery: { id: randomUUID(), key: 'k'.repeat(64), generation: current.coordinatorGeneration,
      runId: null, agentId: null, status: 'pending', summary: 'Earlier stop', idleSince: null, incidentId: null } } });
    const verb = f.view('restart');
    assert.equal(verb.available, true, JSON.stringify(verb));
    const outcome = await acceptControl(f, taskControlInputSchema.parse({
      ...verb.args, reason: 'Finish the remaining figures', instruction: 'Continue from the saved checkpoint', caller: CALLER }));
    assert.equal(outcome.state, 'succeeded', outcome.diagnostic);
    assert.equal(review.deliveries.length, 1);
    assert.equal(f.task().resolution.recovery?.status, 'resolved', 'the superseded episode settles with the continuation');
  } finally { await f.close(); }
});

test('restart is listed for a task parked in attention in any phase when no run is live', async () => {
  const f = fixture(); try {
    const current = f.task();
    f.store.update(f.taskId, { phase: 'syncing', reason: 'Command failed: git merge-base --is-ancestor HEAD origin/main',
      resolution: { ...current.resolution, attention: true } });
    assert.equal(f.store.runs(f.taskId).some(run => !run.released), false);
    const verb = f.view('restart');
    assert.equal(verb.available, true, JSON.stringify(verb));
    // The advertised verb applies: the handler accepts it and requests the recheck.
    const outcome = await acceptControl(f, taskControlInputSchema.parse({ ...verb.args, reason: 'Recheck the repaired sync', caller: CALLER }));
    assert.equal(outcome.state, 'succeeded', outcome.diagnostic);
    assert.ok(f.events('resolution_retry').length >= 1, 'the resolution recheck was requested');
  } finally { await f.close(); }
});

test('next refuses a reviewer restart whenever the continuation gate would (an unfinished stalled stop, another live run), and lists it under a dispatch hold', async () => {
  for (const fence of ['hold', 'stalled', 'run'] as const) {
    const f = fixture(); try {
      const review = reviewing(f);
      assert.equal((await review.report()).accepted, true);
      assert.equal(f.view('restart').available, true, `${fence}: available before the fence`);
      const current = f.task();
      if (fence === 'hold') f.store.update(f.taskId, holdPatch(current, 'dispatch', 'owner-thread', 'Owner gate'));
      if (fence === 'stalled') f.store.update(f.taskId, { resolution: { ...current.resolution,
        stalledTurnStop: { runId: review.runId, role: 'reviewer', agentId: 'reviewer-agent', workspaceId: 'workspace', turnId: 'turn-1',
          effectId: 'effect-1', status: 'sent', attempts: 1, requestedAt: new Date().toISOString(), observedInactiveAt: null, detail: '' } } });
      if (fence === 'run') f.store.putRun({ ...f.store.run(review.runId)!, id: 'other-live', released: false, completion: null, reviewCheckpoints: [] });
      const verb = f.view('restart');
      // Round 4: a dispatch hold no longer refuses; the continuation is recorded and sent once the hold clears.
      if (fence === 'hold') { assert.equal(verb.available, true, `${fence}: ${JSON.stringify(verb)}`); continue; }
      assert.equal(verb.available, false, `${fence}: ${JSON.stringify(verb)}`);
      assert.match(verb.refusal!, /fence|dispatch|unreleased run/i, fence);
    } finally { await f.close(); }
  }
});

test('restart is refused on a finished task with nothing escalated, and targets a retained stopped run over the park', async () => {
  const f = fixture(); try {
    const current = f.task();
    f.store.update(f.taskId, { phase: 'done', resolution: { ...current.resolution, attention: true } });
    assert.equal(f.view('restart').available, false, 'a done task has nothing to restart or answer');
    f.store.update(f.taskId, { phase: 'reviewing', resolution: { ...f.task().resolution, attention: true, currentRunId: 'stopped-review' } });
    f.store.putRun({ id: 'stopped-review', taskId: f.taskId, role: 'reviewer', generation: 1, head: 'a'.repeat(40), base: 'main', agentId: 'reviewer-agent',
      workspaceId: 'workspace', profile: null, status: 'finished', createdAt: new Date().toISOString(), lastObservedAt: null, active: false,
      idleSince: null, completion: null, released: true } as never);
    const verb = f.view('restart');
    assert.equal(verb.available, true, JSON.stringify(verb));
    assert.equal((verb.args as Record<string, unknown>).role, 'reviewer', 'the retained current run is the target, not the parked step');
  } finally { await f.close(); }
});

test('changes_requested: move to work returns the retained author to work', async () => {
  const f = fixture(); try {
    f.store.update(f.taskId, {
      phase: 'changes_requested', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
      agentId: 'worker-agent', runId: 'worker-run', profile: workerProfile, workerModel: workerProfile.model,
      prHead: head, prUrl: 'https://github.com/example/repo/pull/7',
      completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'worker-ready', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
      resolution: { ...f.task().resolution, review: { taskId: f.taskId, runId: 'review-run', eventId: 'review-1', status: 'changes_required', summary: 'Fix the figures', head } },
    });
    const verb = f.next().verbs.find(entry => entry.verb === 'move' && (entry.args as Record<string, unknown> | undefined)?.to === 'work')!;
    assert.equal(verb?.available, true, JSON.stringify(verb));

    const revised = await f.engine.performTaskControl(taskControlInputSchema.parse({
      ...verb.args, reason: 'Fix the figures', instruction: 'Address the review findings on the figures', caller: CALLER }));
    assert.equal(revised.phase, 'changes_requested');
    assert.equal(workerInstruction(revised), 'Address the review findings on the figures');
    assert.equal(JSON.parse(f.events('owner_control').at(-1)!.detail).verb, 'move');
  } finally { await f.close(); }
});

test('a pre-dispatch review-entry park (#325): restart requeues it whatever the attention flag says', async () => {
  const f = fixture(); try {
    f.store.update(f.taskId, {
      phase: 'needs_attention', entrypoint: 'review',
      reason: 'Review entry admitted; waiting for Paseo readiness before validation',
      reviewEntry: reviewEntryRecordSchema.parse({
        operationId: (randomUUID() + randomUUID()).replace(/-/g, ''), prNumber: 12, repository: 'example/repo', branch: 'feature/one',
        workspaceId: 'ws-review', verifiedHead: head, verifiedBase: base, dispatchBase: null, planningCommit: base,
        authority: 'Direct intake by the origin author', authorDeclaration: authorDeclarationSchema.parse({
          models: ['test/worker'], githubAuthor: 'example', authoringSystem: 'pi', attestedBy: 'origin', provenance: 'Authored in the origin workspace',
        }), checkedAt: new Date().toISOString(), preserveWorkspace: true,
      }),
      resolution: { ...f.task().resolution, attention: false },
    });
    const view = f.next();
    assert.equal(view.phase, 'needs_attention');
    assert.equal(view.attention, false);
    const retry = f.view('restart');
    assert.equal(retry.available, true, JSON.stringify(retry));
    assert.deepEqual(retry.args, { action: 'restart', taskId: f.taskId, version: f.task().version, role: 'worker' });

    const requeued = await f.engine.performTaskControl(taskControlInputSchema.parse({ ...retry.args, reason: 'Paseo is ready', caller: CALLER }));
    assert.equal(requeued.phase, 'queued');
    assert.equal(JSON.parse(f.events('owner_control').at(-1)!.detail).verb, 'restart');
  } finally { await f.close(); }
});

test('a workerless review entry whose reviewer blocked: the default restart returns it to review (review #539)', async () => {
  const f = fixture(); try {
    f.store.putRun(runSchema.parse({
      id: 'blocked-review', taskId: f.taskId, role: 'reviewer', generation: 1, head, base, agentId: 'reviewer-agent', workspaceId: 'ws-review',
      profile: reviewerProfile, status: 'finished', createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null, released: true,
      completion: { taskId: f.taskId, runId: 'blocked-review', eventId: 'review-blocked', status: 'blocked', summary: 'Reviewer environment unavailable', head },
    }));
    f.store.update(f.taskId, {
      phase: 'blocked', entrypoint: 'review', reason: 'Reviewer environment unavailable', workspaceId: 'ws-review', directory: '/worktree',
      prHead: head, prUrl: 'https://github.com/example/repo/pull/12', resumePrNumber: 12,
      reviewEntry: reviewEntryRecordSchema.parse({
        operationId: (randomUUID() + randomUUID()).replace(/-/g, ''), prNumber: 12, repository: 'example/repo', branch: 'feature/one',
        workspaceId: 'ws-review', verifiedHead: head, verifiedBase: base, dispatchBase: null, planningCommit: base,
        authority: 'Direct intake by the origin author', authorDeclaration: authorDeclarationSchema.parse({
          models: ['test/worker'], githubAuthor: 'example', authoringSystem: 'pi', attestedBy: 'origin', provenance: 'Authored in the origin workspace',
        }), checkedAt: new Date().toISOString(), preserveWorkspace: true,
      }),
      resolution: { ...f.task().resolution, currentRunId: null, attention: false },
    });
    assert.equal(f.task().agentId, null, 'a review entry has no retained worker');
    const verb = f.view('restart');
    assert.equal(verb.available, true, JSON.stringify(verb));
    assert.equal((verb.args as Record<string, unknown>).role, undefined, 'the parked step, not a worker restart it cannot serve');
    const restarted = await f.engine.performTaskControl(taskControlInputSchema.parse({ ...verb.args, reason: 'The reviewer environment is back', caller: CALLER }));
    assert.ok(['awaiting_review', 'reviewing'].includes(restarted.phase), restarted.phase);
  } finally { await f.close(); }
});

test('a changed workerless review-entry head refuses; a same-head review move remains valid while paused', async () => {
  const f = fixture(); try {
    f.store.update(f.taskId, {
      phase: 'blocked', entrypoint: 'review', reason: 'Owner revision pending', workspaceId: 'ws-review', directory: '/worktree',
      prHead: head, prUrl: 'https://github.com/example/repo/pull/12',
      reviewEntry: reviewEntryRecordSchema.parse({
        operationId: (randomUUID() + randomUUID()).replace(/-/g, ''), prNumber: 12, repository: 'example/repo', branch: 'feature/one',
        workspaceId: 'ws-review', verifiedHead: head, verifiedBase: base, dispatchBase: null, planningCommit: base,
        authority: 'Direct intake by the origin author', authorDeclaration: authorDeclarationSchema.parse({
          models: ['test/worker'], githubAuthor: 'example', authoringSystem: 'pi', attestedBy: 'origin', provenance: 'Authored in the origin workspace',
        }), checkedAt: new Date().toISOString(), preserveWorkspace: true,
      }),
    });
    // A changed head must go through the revision worker, even while paused.
    const moved = 'c'.repeat(40);
    Object.assign(f.adapter, { verifyPr: async () => ({ url: 'https://github.com/example/repo/pull/12', head: moved }) });
    f.store.setMeta('paused', true);
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: f.taskId, version: f.task().version, action: 'move', to: 'review',
      reason: 'Review the changed PR head', prNumber: 12, caller: CALLER })), /use move to=work to start the revision worker in the task workspace/);
    assert.equal(f.task().resolution.deferredVerb, null);
    Object.assign(f.adapter, { verifyPr: async () => ({ url: 'https://github.com/example/repo/pull/12', head }) });
    const applied = await f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: f.taskId, version: f.task().version, action: 'move', to: 'review',
      reason: 'Review the same head again', prNumber: 12, caller: CALLER })).catch((error: Error) => error);
    assert.equal(f.task().resolution.deferredVerb, null, `a same-head move is never deferred: ${applied instanceof Error ? applied.message : applied.phase}`);
  } finally { await f.close(); }
});

test('an uncertain worker creation with no agent (#151): restart re-creates in the retained workspace', async () => {
  const f = fixture(); try {
    f.store.update(f.taskId, {
      phase: 'needs_attention', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
      agentId: null, runId: 'uncertain-run', profile: workerProfile, workerModel: workerProfile.model,
      reason: ABSENT_WORKER_REASON,
      resolution: { ...f.task().resolution, attention: true },
    });
    const verb = f.view('restart');
    assert.equal(verb.available, true, JSON.stringify(verb));
    const resumed = await f.engine.performTaskControl(taskControlInputSchema.parse({
      ...verb.args, reason: 'The creation was refused before send', instruction: 'Paseo refused the malformed workspace before send; create the worker now', caller: CALLER }));
    assert.equal(resumed.phase, 'dispatching');
    assert.equal(resumed.agentIntent, false, 'the old uncertain creation intent is revoked before the new one');
    assert.equal(JSON.parse(f.events('owner_control').at(-1)!.detail).verb, 'restart');
  } finally { await f.close(); }
});

test('a legacy author-escalation row: move to work continues the author', async () => {
  const f = fixture(); try {
    f.store.update(f.taskId, {
      phase: 'needs_attention', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
      agentId: 'worker-agent', runId: 'worker-run', profile: workerProfile, workerModel: workerProfile.model,
      prHead: head, prUrl: 'https://github.com/example/repo/pull/7',
      completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'worker-ready', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
      failoverReason: '',
      reason: `Author capability escalation needs project-owner disposition: No enabled available strictly higher author than worker (very_high); project route disposition required at the top capability tier`,
      resolution: { ...f.task().resolution, attention: true },
    });
    const verb = f.next().verbs.find(entry => entry.verb === 'move' && (entry.args as Record<string, unknown> | undefined)?.to === 'work')!;
    assert.equal(verb?.available, true, JSON.stringify(f.next().verbs.filter(entry => entry.verb === 'move')));
    f.observations.set('worker-agent', { id: 'worker-agent', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
    const revised = await f.engine.performTaskControl(taskControlInputSchema.parse({
      ...verb.args, reason: 'No higher route exists', instruction: 'No higher route exists; continue this author and address the review findings', caller: CALLER }));
    assert.equal(revised.phase, 'changes_requested');
    assert.equal(workerInstruction(revised), 'No higher route exists; continue this author and address the review findings');
  } finally { await f.close(); }
});

test('settleSupersededFences supersedes an escalated incident and episode on a superseded reviewer run and keeps the history', async () => {
  const f = fixture(); try {
    const runId = 'review-run';
    f.store.update(f.taskId, {
      phase: 'needs_attention', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
      agentId: 'worker-agent', runId: 'worker-run', profile: workerProfile, prHead: head,
      prUrl: 'https://github.com/example/repo/pull/7',
      completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'worker-ready', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
    });
    f.store.putRun(runSchema.parse({
      id: runId, taskId: f.taskId, role: 'reviewer', generation: 1, head, base, agentId: 'review-agent', workspaceId: 'workspace',
      profile: reviewerProfile, status: 'superseded', createdAt: new Date().toISOString(), lastObservedAt: null,
      active: false, idleSince: null, completion: null, released: true,
      reviewCheckpoints: [{ ordinal: 1, checkpoint: { covered: ['a'], remaining: ['b'] }, head, at: new Date().toISOString(), runId, path: `/tmp/${f.taskId}/cp-1.json` }],
    }));
    f.store.update(f.taskId, { resolution: { ...f.task().resolution, currentRunId: null, attention: true,
      externalMergePreAttention: { phase: 'needs_attention', reason: 'Stale external merge check' } } });
    f.store.update(f.taskId, { checkpoints: { records: [], intent: { id: 'intent-1', ordinal: 1, summary: 'Reading', head, runId,
      eventId: 'cp-1', status: 'pending', createdAt: new Date().toISOString(), deliveredAt: null, attempts: 0, error: '' } } });
    f.store.putNotice({ id: 'attention', taskId: f.taskId, agentId: 'origin', recipientAgentId: 'origin', workspaceId: null, sources: [], originEntry: true, kind: 'attention', status: 'pending', error: '', text: 'Reviewer stopped' });
    f.engine.resolution.recovery.escalate(f.task(), 'Coordinator recovery could not safely continue: the reviewer run was already superseded');
    assert.equal(f.events('recovery_escalated').length, 1);
    // The escalated episode carries a pending accepted action: settlement must
    // record it as not applied on the resolved episode.
    f.store.update(f.taskId, { resolution: { ...f.task().resolution, recovery: { ...f.task().resolution.recovery!,
      action: { eventId: 'accepted-report', runId: 'review-run', reportStatus: 'recovered', recoveryAction: 'resume_worker',
        summary: 'Resume the reviewer thread', status: 'pending' } } } });

    const settled = settleSupersededFences(f.store, f.taskId, 'The owner restarted the review');
    assert.deepEqual(settled, { incident: true, recovery: true, attentionNotices: 1, checkpointIntent: true, externalMergePreAttention: true });
    const after = f.task();
    assert.equal(after.resolution.incident?.status, 'resolved');
    assert.equal(after.resolution.recovery?.status, 'resolved');
    assert.equal(after.resolution.recovery?.action?.status, 'refused', 'the pending accepted action is recorded as not applied');
    assert.match(after.resolution.recovery?.action?.reason ?? '', /Not applied/, 'the refusal names the supersession');
    assert.equal(after.resolution.recoveryActive, false);
    assert.equal(after.resolution.externalMergePreAttention, null, 'the stale external-merge record is cleared');
    assert.equal(after.checkpoints.intent, null);
    assert.equal(f.store.notices(f.taskId).find(notice => notice.id === 'attention')?.status, 'superseded');
    // History retained: the escalation event stays, and the settlement is its own event.
    assert.equal(f.events('recovery_escalated').length, 1);
    assert.equal(f.events('owner_fence_settled').length, 1);
    assert.ok(f.events('incident').some(event => event.detail.includes('"status":"resolved"')));

    // A second settlement is a no-op, and the settled incident no longer reads as the stop:
    // the parked task's own attention wait replaces it, with no incident evidence.
    assert.deepEqual(settleSupersededFences(f.store, f.taskId, 'repeat'),
      { incident: false, recovery: false, attentionNotices: 0, checkpointIntent: false, externalMergePreAttention: false });
    f.store.update(f.taskId, { resolution: { ...f.task().resolution, attention: false } });
    const view = taskNextSchema.parse(ownerTaskNext(collectOwnerVerbFacts(f.store, f.task())));
    assert.equal(view.stop?.kind, 'attention');
    assert.ok(!/incident/.test(view.stop?.evidence ?? ''));
  } finally { await f.close(); }
});

test('an escalated episode behind an unreleased run is not answered: restart acts on the stopped worker (round 4)', async () => {
  const f = fixture(); try {
    stoppedWorker(f);
    f.store.putRun(runSchema.parse({
      id: 'review-run', taskId: f.taskId, role: 'reviewer', generation: 1, head, base, agentId: 'review-agent', workspaceId: 'workspace',
      profile: reviewerProfile, status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null,
      active: true, idleSince: null, completion: null, released: false,
    }));
    f.engine.resolution.recovery.escalate(f.task(), 'Escalated while the reviewer is still out');
    // Round 4: restart is not an answer here; it acts on the stopped worker and
    // settles what is in its way (the reviewer run is displaced, not a refusal).
    const verb = f.view('restart');
    assert.equal(verb.available, true, JSON.stringify(verb));
    assert.equal((verb.args as Record<string, unknown>).role, 'worker');
  } finally { await f.close(); }
});

test('the shared board stop category never drifts from the task.next stop', async () => {
  const f = fixture(); try {
    const head = 'a'.repeat(40), at = '2026-10-01T00:00:00.000Z';
    const expect = (kind: string | null) => {
      assert.equal(taskStopKind(f.task(), f.store.runs(f.taskId)), kind, `taskStopKind for phase ${f.task().phase}`);
      assert.equal(f.next().stop?.kind ?? null, kind, `task.next stop for phase ${f.task().phase}`);
    };
    expect('wait');
    f.store.update(f.taskId, { held: true });
    expect('hold');
    f.store.update(f.taskId, { phase: 'working', held: false, resolution: { ...f.task().resolution, incident: incidentSchema.parse({ id: 'inc', role: 'worker', createdAt: at, updatedAt: at }) } });
    expect('incident');
    f.store.update(f.taskId, { resolution: { ...f.task().resolution, incident: null, recovery: { id: 'rec', key: 'rec', generation: 1, runId: null, agentId: null, status: 'running', summary: 'Coordinator on it', idleSince: null, incidentId: null } } });
    expect('recovery');
    f.store.update(f.taskId, { phase: 'needs_attention', resolution: { ...f.task().resolution, recovery: null } });
    expect('attention');
    f.store.update(f.taskId, { phase: 'error', resolution: { ...f.task().resolution, attention: false }, completion: { eventId: 'e1', taskId: f.taskId, runId: 'worker-run', status: 'error', summary: 'worker failed' } });
    expect('run');
    f.store.putRun(runSchema.parse({
      id: 'review-run', taskId: f.taskId, role: 'reviewer', generation: 1, head, base: head,
      agentId: 'reviewer', workspaceId: 'workspace', profile: null, status: 'running',
      createdAt: at, lastObservedAt: null, active: null, idleSince: null, completion: null, released: false,
      reviewCheckpoints: [reviewCheckpointRecordSchema.parse({
        ordinal: 1, checkpoint: { remaining: ['finish the review'] }, head, at,
        runId: 'review-run', path: '.paseo/checkpoints/review-run/1.json',
      })],
    }));
    f.store.update(f.taskId, { phase: 'reviewing', completion: null, resolution: { ...f.task().resolution, currentRunId: 'review-run' } });
    expect('run');
    f.store.putRun(runSchema.parse({
      id: 'review-run', taskId: f.taskId, role: 'reviewer', generation: 1, head, base: head,
      agentId: 'reviewer', workspaceId: 'workspace', profile: null, status: 'running',
      createdAt: at, lastObservedAt: null, active: null, idleSince: null, completion: null, released: true,
    }));
    f.store.update(f.taskId, { phase: 'working', resolution: { ...f.task().resolution, currentRunId: null } });
    expect(null);
  } finally { await f.close(); }
});

test('a held task lists release and keep_hold for its fence, naming the holder and the condition', async () => {
  const f = fixture(); try {
    await f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: f.taskId, version: f.task().version, action: 'hold', reason: 'Owner reads the pickup wording', agentId: 'owner-thread' }));
    const view = f.next();
    const release = view.verbs.find(verb => verb.verb === 'release');
    const keep = view.verbs.find(verb => verb.verb === 'keep_hold');
    assert.ok(release?.available && keep?.available, JSON.stringify(view.verbs.filter(verb => verb.verb === 'release' || verb.verb === 'keep_hold')));
    assert.match(String((release!.args as Record<string, unknown>).summary), /held by owner-thread: Owner reads the pickup wording\. Release only once that condition is met/);
    assert.deepEqual(keep!.fill, ['reason']);
    // The prefilled args apply as they are.
    const released = await f.engine.performTaskControl(taskControlInputSchema.parse({ ...release!.args, caller: 'owner-thread' }));
    assert.equal(released.held, false);
    assert.ok(!f.next().verbs.some(verb => verb.verb === 'release'), 'no hold, no release entry');
  } finally { await f.close(); }
});

test('a stale-version control refusal names the current version and the read to make', async () => {
  const f = fixture(); try {
    const stale = f.task().version;
    await f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: f.taskId, version: stale, action: 'hold', reason: 'First hold' }));
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: f.taskId, version: stale, action: 'release' })),
      new RegExp(`the task is now version ${f.task().version}; read next again and reassess before retrying`));
  } finally { await f.close(); }
});

test('two hold fences list separate release entries, and a cancelled task can still release them', async () => {
  const f = fixture(); try {
    await f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: f.taskId, version: f.task().version, action: 'hold', kind: 'dispatch', reason: 'Dispatch gate' }));
    await f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: f.taskId, version: f.task().version, action: 'hold', kind: 'merge', reason: 'Merge gate' }));
    const releases = f.next().verbs.filter(verb => verb.verb === 'release');
    assert.deepEqual(releases.map(verb => (verb.args as Record<string, unknown>).kind), ['dispatch', 'merge']);
    const merge = releases.find(verb => (verb.args as Record<string, unknown>).kind === 'merge')!;
    const released = await f.engine.performTaskControl(taskControlInputSchema.parse({ ...merge.args }));
    assert.ok(!holdsOf(released).merge && holdsOf(released).dispatch, 'the merge entry releases only the merge fence');
    // Project-C #089: a hold on a cancelled task is always releasable; renewing it is not.
    f.store.update(f.taskId, { phase: 'cancelled' });
    const terminal = f.next().verbs.filter(verb => verb.verb === 'release' || verb.verb === 'keep_hold');
    assert.deepEqual(terminal.map(verb => [verb.verb, verb.available]), [['release', true], ['keep_hold', false]]);
  } finally { await f.close(); }
});

test('while Queue is paused, next offers the same verbs and the handlers apply them (round 4)', async () => {
  const f = fixture(); try {
    stoppedWorker(f);
    f.observations.set('worker-agent', { id: 'worker-agent', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
    const offered = () => f.next().verbs.filter(view => view.available).map(view => `${view.verb}:${String(view.args?.to ?? view.args?.role ?? '')}`).sort();
    const open = offered();
    assert.ok(open.some(entry => entry.startsWith('route')) && open.some(entry => entry.startsWith('restart')), 'route and restart are offered');
    f.store.setMeta('paused', true);
    assert.deepEqual(offered(), open, 'pausing hides no verb');
    const restart = f.next().verbs.find(view => view.verb === 'restart' && view.available)!;
    const restarted = await f.engine.performTaskControl({ ...restart.args, reason: 'owner reason' } as never);
    assert.notEqual(restarted.phase, 'needs_attention', 'the restart applied its state while paused');
  } finally { await f.close(); }
});

test('while paused, a review move is still offered without inspecting the forge head (round 4, review #544)', async () => {
  for (const workerless of [true, false]) {
    const f = fixture(); try {
      // The recorded head still equals the reviewed head; only the forge could
      // show an owner push, and next cannot read the forge.
      const reviewed = 'c'.repeat(40);
      f.store.update(f.taskId, {
        phase: 'needs_attention', entrypoint: workerless ? 'review' : 'worker', agentId: workerless ? null : 'worker-agent',
        prUrl: 'https://github.com/example/repo/pull/12', prHead: reviewed, workspaceId: 'ws-review', directory: '/worktree',
        ...(workerless ? { reviewEntry: reviewEntryRecordSchema.parse({
          operationId: (randomUUID() + randomUUID()).replace(/-/g, ''), prNumber: 12, repository: 'example/repo', branch: 'feature/one',
          workspaceId: 'ws-review', verifiedHead: reviewed, verifiedBase: base, dispatchBase: null, planningCommit: base,
          authority: 'Direct intake by the origin author', authorDeclaration: authorDeclarationSchema.parse({
            models: ['test/worker'], githubAuthor: 'example', authoringSystem: 'pi', attestedBy: 'origin', provenance: 'Authored in the origin workspace',
          }), checkedAt: new Date().toISOString(), preserveWorkspace: true,
        }) } : { completion: { eventId: 'done', taskId: f.taskId, runId: 'worker-run', status: 'ready_for_review', summary: 'Done', prNumber: 12, head: reviewed } }),
        resolution: { ...f.task().resolution, attention: true,
          review: { eventId: 'review', taskId: f.taskId, runId: 'review-run', status: 'ready_to_merge', summary: 'Approved', head: reviewed } },
      });
      const review = () => f.next().verbs.find(view => view.verb === 'move' && (view.args?.to === 'review' || (view.refusal ?? '').startsWith('move review:')))!;
      assert.equal(review().available, true, `${workerless}: unpaused the review move is offered: ${JSON.stringify(review())}`);
      f.store.setMeta('paused', true);
      const paused = review();
      // `next` is read-only and cannot inspect the forge head, so it keeps offering the move.
      assert.equal(paused.available, true, `${workerless}: the review move is offered while paused`);
    } finally { await f.close(); }
  }
});

/**
 * Queue #395: a continuation may reuse what an earlier run built. The owner's
 * continuation gates quote the recorded run-bound cleanup beside the verb, and
 * the note never changes which verb is available, its args, the stop or the
 * holds — nor does a record's `complete` state ever read as a deletion claim.
 */
const cleanupNoteFixture = (f: ReturnType<typeof fixture>) => {
  f.store.update(f.taskId, {
    phase: 'blocked', workspaceId: 'workspace', directory: '/worktree', branch: 'ns-work',
    agentId: 'worker-agent', runId: 'worker-run', reason: 'Blocked after a build',
    completion: completionSchema.parse({ eventId: 'w1', taskId: f.taskId, runId: 'worker-run', status: 'blocked', summary: 'Blocked after a build', head }),
  });
  return f.next();
};
// The store update that records the cleanup edits the task row, so the owner
// must refresh the version; every other derived field must read the same.
const withoutNotes = (view: ReturnType<ReturnType<typeof fixture>['next']>) => ({
  ...view, version: 0,
  verbs: view.verbs.map(({ note: _note, ...verb }) => ({ ...verb,
    ...(verb.args ? { args: { ...verb.args, version: 0 } } : {}),
    ...(verb.forceArgs ? { forceArgs: { ...verb.forceArgs, version: 0 } } : {}) })),
});

test('owner continuation gates disclose recorded run-bound cleanup without changing available verbs, args, stop or holds', async () => {
  const f = fixture(); try {
    const before = cleanupNoteFixture(f);
    const at = '2026-10-24T00:00:00.000Z';
    f.store.update(f.taskId, { resolution: { ...f.task().resolution, buildOutputCleanups: [
      { workspaceId: 'workspace', directory: '/worktree', runId: 'worker-run', agentId: 'worker-agent', state: 'complete', at,
        detail: 'Removed task-local Cargo target output at /worktree/target. Retained node_modules at /worktree/node_modules for the task\'s next continuation' },
      { workspaceId: 'review-view', directory: '/review-view', runId: 'review-run', state: 'complete', at: '2026-10-24T01:00:00.000Z',
        detail: 'Left build output symlinks: /review-view/target (Cargo target): symlink left in place; target untouched' },
    ] } });
    const after = f.next();
    // The note is additive: verb set, availability, args, fill, refusals, stop and holds are identical.
    assert.deepEqual(withoutNotes(after), withoutNotes(before));
    for (const verb of after.verbs) if (!verb.available) assert.equal(verb.note, undefined, `${verb.verb} refusal carries no disclosure`);
    const work = after.verbs.find(verb => verb.verb === 'move' && verb.args?.to === 'work')!;
    assert.equal(work.available, true, 'the continuation gate stays available');
    assert.match(work.note ?? '', /Nucleus recorded run-bound build output cleanup for this task \(2 complete\), 1 of them in another workspace/, 'the note counts the records and their workspace');
    assert.match(work.note ?? '', /1 of them in another workspace/, 'the note tells another workspace from this checkout');
    assert.match(work.note ?? '', /prior build artifacts are not guaranteed retained, so re-run any command whose output you rely on/, 'the note forbids relying on prior output');
    assert.match(work.note ?? '', /grants no authority to rebuild, reseed, refund budget, replay proof, waive cleanup or retain artifacts/, 'the note grants no authority');
    assert.doesNotMatch(work.note ?? '', /deleted|capacity released|still present/, 'the note never claims deletion or presence');
    // The other verbs the owner may call keep their own text untouched.
    assert.equal(after.verbs.find(verb => verb.verb === 'route')!.note, undefined);
    assert.equal(after.verbs.find(verb => verb.verb === 'complete')!.note, undefined);
    assert.equal(after.verbs.find(verb => verb.verb === 'restart')!.note, undefined, 'a refused verb carries no disclosure');
  } finally { await f.close(); }
});

test('a continuation whose prior run has no cleanup record is told so, and a finished task carries none', async () => {
  const f = fixture(); try {
    const before = cleanupNoteFixture(f);
    const work = before.verbs.find(verb => verb.verb === 'move' && verb.args?.to === 'work')!;
    assert.match(work.note ?? '', /no run-bound cleanup record names run worker-run/, 'the missing record is named, not inferred');
    assert.match(work.note ?? '', /prior build artifacts are not guaranteed retained/);
    // A skipped or uncertain record is quoted with its own state, never as a removal.
    f.store.update(f.taskId, { resolution: { ...f.task().resolution, buildOutputCleanups: [
      { workspaceId: 'workspace', directory: '/worktree', runId: 'worker-run', state: 'skipped', at: '2026-10-24T00:00:00.000Z',
        detail: 'Skipped build output roots: /worktree/target: Git reports tracked files at or under this build root' },
    ] } });
    const skipped = f.next().verbs.find(verb => verb.verb === 'move' && verb.args?.to === 'work')!;
    assert.match(skipped.note ?? '', /\(1 skipped\)/);
    assert.doesNotMatch(skipped.note ?? '', /a recorded removal|output retained/);
    // A finished task's restart re-runs a parked closeout step, not artifact work.
    f.store.update(f.taskId, { phase: 'done', resolution: { ...f.task().resolution, mergedCommit: head } });
    const done = f.next();
    assert.ok(!done.verbs.some(verb => verb.note && /run-bound build output cleanup/.test(verb.note)), 'a finished task carries no continuation disclosure');
  } finally { await f.close(); }
});


test('qualified owner verb callers keep planner force authority scoped to the same host', async () => {
 const f=fixture();try {
  f.store.upsertProject({key:'caller-project',name:'Caller project',repositories:[{origin:null,path:'/repo'}]});
  f.store.setProjectPlanner({key:'caller-project',agentId:'planner',setBy:'operator (board)'});
  assert.equal(f.engine.forceCallerAuthorized(f.task(),formatAgentId('host','planner')),true);
  f.store.setProjectPlanner({key:'caller-project',agentId:formatAgentId('host','planner'),setBy:'operator (board)'});
  assert.equal(f.engine.forceCallerAuthorized(f.task(),formatAgentId('host','planner')),true);
  assert.equal(f.engine.forceCallerAuthorized(f.task(),formatAgentId('other-host','planner')),false);
  const result=await f.engine.performTaskControl(taskControlInputSchema.parse({taskId:f.taskId,version:f.task().version,
    action:'hold',reason:'Waiting',caller:formatAgentId('host','planner'),agentId:formatAgentId('host','planner')}));
  assert.equal(holdsOf(result).dispatch?.owner,formatAgentId('host','planner'));
  assert.equal(JSON.parse(f.events('owner_control').at(-1)!.detail).caller,formatAgentId('host','planner'));
 }finally{await f.close();}
});
