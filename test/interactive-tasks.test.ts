import { fakeAdapter, profile } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, digest } from '../core/store/store';
import { Engine, INTERACTIVE_RUNNING_REASON, INTERACTIVE_WAIT_REASON } from '../core/engine';
import { createTaskDetailCache } from '../core/telemetry/task-detail';
import { REVISION_BUDGET, submissionSchema, type Completion, type Profile, type Run } from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';
import type { ResolutionAdapter } from '../core/resolution';
import { deriveTaskTelemetry, telemetrySnapshot } from '../core/telemetry/telemetry';
import { REPOSITORY_CONTENTION_GRACE_MS } from '../core/scheduling/repository-contention';
import { stepEngine } from './support/engine-step';
import { taskStopRecord } from '../shared/task-stop';

const head = 'a'.repeat(40), base = 'b'.repeat(40), merged = 'c'.repeat(40);


type Found = { id: string; workspaceId: string | null };

function fixture(graceMs = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'ns-reconcile-')), store = new Store(join(dir, 'queue.sqlite'));
  const worker = profile('author'), reviewer = profile('reviewer'), coordinator = profile('coordinator');
  store.setMeta('paused', false);
  store.setMeta('pool', [
    { profileId: worker.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] },
    { profileId: reviewer.id, enabled: true, group: 'review', roles: ['reviewer'], weight: 1, scopes: ['general'] },
    { profileId: coordinator.id, enabled: true, group: 'coordinate', roles: ['coordinator'], weight: 1, scopes: ['general'] },
  ]);
  const states = new Map<string, AgentObservation>();
  const idle = (id: string, workspaceId = 'workspace') => states.set(id, { id, workspaceId, status: 'idle', active: false, permissions: false, error: '' });
  idle('worker');
  const tokens = new Map<string, string>(), creates: Run[] = [], sends: Run[] = [], reminders: string[] = [];
  const foundAgents = new Map<string, Found[]>();
  let reviewChecks = 0, currentHead = head;
  const add = (changes: Record<string, unknown> = {}, submission: Record<string, unknown> = {}) => {
    const submitted = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Task', repoPath: '/repo', planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin', ...submission }), 'host', 'handoff', base);
    return store.update(submitted.id, { phase: 'working', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree', agentId: 'worker', runId: `run-${submitted.id.slice(0, 8)}`, profile: worker, workerModel: worker.model, prHead: head, prUrl: 'https://github.com/example/repo/pull/1', agentActive: false, lastAgentStatus: 'idle', lastObservedAt: new Date().toISOString(), ...changes });
  };
  const task = add();
  const adapter: Adapter & ResolutionAdapter = fakeAdapter({
    profiles: async () => [worker, reviewer, coordinator], validate: async () => base, verifyWorkspace: async t => t.branch, verifyResume: async () => {},
    createWorkspace: async () => { throw new Error('fixtures do not create workspaces') }, verifyCleanQueueWorktree: async () => {},
    createAgent: async (t, token) => { tokens.set(t.runId!, token); const id = `agent-${t.runId}`; idle(id); return { id, workspaceId: t.workspaceId }; },
    findAgents: async t => foundAgents.get(t.runId!) ?? [],
    observe: async id => { const s = states.get(id); if (!s) throw new Error('Agent missing'); return s },
    verifyPr: async () => ({ head: currentHead, url: 'https://github.com/example/repo/pull/1' }), verifyPrIdentity: async () => ({ head: currentHead, url: 'https://github.com/example/repo/pull/1' }),
    createRun: async (t, r, token) => { creates.push(r); tokens.set(r.id, token); const id = `agent-${r.id}`; states.set(id, { id, workspaceId: r.workspaceId, status: 'running', active: true, permissions: false, error: '' }); return { id, workspaceId: r.workspaceId }; },
    sendRun: async (t, r, token) => { sends.push(r); tokens.set(r.id, token); states.set(r.agentId!, { ...states.get(r.agentId!)!, active: true, status: 'running' }) },
    findRunAgents: async r => foundAgents.get(r.id) ?? [],
    verifyReview: async (t, r, c) => { reviewChecks++; if (c.head !== currentHead) throw new Error('Stale PR head') },
    mergeGate: async () => ({ head: currentHead, base, wait: '' }), merge: async () => {},
    merged: async () => ({ merged: true, commit: merged, head: currentHead, base: 'main' }), syncMain: async () => merged, verifyCloseout: async () => {}, notify: async (id, key) => { reminders.push(`${id}:${key}`); },
  });
  const engine = new Engine(store, adapter, graceMs); engine.profiles = [worker, reviewer, coordinator];
  const current = () => store.task(task.id);
  const run = () => store.run(current().resolution.currentRunId!)!;
  const events = (kind: string) => store.events(task.id).filter(e => e.kind === kind);
  async function report(status: Completion['status'], prNumber = 1, drain = true) {
    const r = run(); idle(r.agentId!, r.workspaceId);
    // Spec 044 (commit 9e2fcea3, 2026-10-06): a reviewer that returns an unresolved
    // outcome names who owns it. `changes_required` is an author defect, so the
    // fixture names the author rather than reporting a bare verdict.
    const input: Completion = { eventId: randomUUID(), taskId: task.id, runId: r.id, status, summary: status, head: r.head, ...(r.role === 'reviewer' ? { reviewCommentId: 1 } : {}), ...(r.role === 'reviewer' && status === 'changes_required' ? { reviewResponsibility: 'author' as const } : {}), ...(r.role === 'closeout' ? { coordinatorGeneration: r.generation } : {}), ...(r.role === 'revision' ? { prNumber } : {}) };
    engine.resolution.complete(input, tokens.get(r.id)!); await (drain ? engine.wake() : stepEngine(engine)); return input;
  }
  /** Plant the task at awaiting_review with an accepted worker completion so review flow tests start there. */
  const plantReview = (changes: Record<string, unknown> = {}) => {
    const t = store.task(task.id);
    return store.update(t.id, { phase: 'awaiting_review', lastObservedAt: new Date().toISOString(), completion: { taskId: t.id, runId: t.runId!, eventId: `initial-${t.id}`, status: 'ready_for_review', summary: 'Ready', prNumber: 1 }, ...changes });
  };
  return { store, engine, adapter, task, add, plantReview, current, run, report, states, idle, tokens, creates, sends, reminders, foundAgents, events, counts: () => ({ reviewChecks }), setHead: (h: string) => { currentHead = h; }, close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }) } };
}

function enableRecovery(f: ReturnType<typeof fixture>) {
  (f.adapter as { supportsCoordinatorRecovery?: boolean }).supportsCoordinatorRecovery = true;
  return f.reminders;
}


import { workerPrompt } from '../core/dispatch/prompts';
import { submissionHash } from '../core/store/store';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { archiveFinishedThreads } from '../core/workspaces/thread-archive';
import { occupiesSlot, capacityFor } from '../core/dispatch/capacity';
import { summarizeTask } from '../shared/contracts';
const old = new Date(Date.now()-3600000).toISOString();
function interactive(f: ReturnType<typeof fixture>, extra: Record<string,unknown> = {}) {
 return f.store.update(f.task.id,{interactive:true,prHead:null,prUrl:null,...extra});
}
test('an idle or live interactive session gets no reminder, stall, PR lookup, recovery or archive, and holds its slot', async()=>{
 const f=fixture();try {
 enableRecovery(f);interactive(f);let lookups=0,archives=0;
 (f.adapter as any).findOpenBranchPr=async()=>{lookups++;throw Error('unexpected PR read')};
 f.adapter.archiveAgent=async()=>{archives++};
 for(const live of [false,true,false]){
 f.states.set('worker',{id:'worker',workspaceId:'workspace',status:live?'running':'idle',active:live,permissions:false,error:'',updatedAt:old,activeTurnId:'turn'});
 await f.engine.wake();
 assert.equal(f.current().phase,'working');
 assert.equal(f.current().resolution.stop?.reason,live?'lifecycle':'interactive');
 assert.equal(f.current().resolution.incident,null);
 assert.equal(f.current().resolution.recovery,null);
 assert.equal(f.current().idleSince,null);
 assert.equal(createTaskDetailCache(f.store)(f.task.id).missingResult,null);
 assert.equal(occupiesSlot(f.current()),true);
 assert.match(capacityFor(f.add({phase:'queued',agentId:null,agentIntent:false,runId:null}),[f.current()],1,1),/limit/);
 assert.equal(f.store.qaScheduleMerges('/repo').length,0);
 assert.equal(await f.engine.settleSupersededIdleRuns(f.task.id,'probe'),0);
 await archiveFinishedThreads(f.store,f.adapter,f.task.id);
 await f.engine.resolution.recovery.pass(f.task.id);
 await f.engine.resolution.recovery.route(f.current());
 }
 assert.equal(lookups,0);assert.equal(archives,0);assert.equal(f.reminders.length,0);assert.equal(f.creates.length,0);
 }finally{await f.close()}
});
test('an interactive worker that resumed after a transient provider error and went idle is back in its session, not missing a result',async()=>{
 const f=fixture();try{
 interactive(f,{transientProviderRetry:{runId:f.current().runId,resumes:1,status:'sent',error:'connection reset',retryAt:null,messageId:'resume',resumedAt:old,observedUpdatedAt:old,sawProgress:true}});
 await f.engine.wake();
 assert.equal(f.current().phase,'working',f.current().reason);
 assert.equal(f.current().resolution.incident,null);
 }finally{await f.close()}
});
test('next offers no move to work or restart that would end a healthy interactive session',async()=>{
 const f=fixture();try{
 interactive(f);await f.engine.scheduleTaskQuantum(f.task.id);
 const next=ownerTaskNext(collectOwnerVerbFacts(f.store,f.current()));
 assert.equal(next.stop?.reason,'interactive');
 assert.equal(next.verbs.find(v=>v.verb==='restart')?.available,false);
 const move=next.verbs.find(v=>v.verb==='move' && v.args?.to==='work');
 if(move?.available){
 const changed=await f.engine.moveToWork({taskId:f.task.id,version:f.current().version,reason:'Continue session'});
 assert.equal(changed.phase,'working',JSON.stringify({phase:changed.phase,prePrResumeInstruction:changed.resolution.prePrResumeInstruction}));
 }
 }finally{await f.close()}
});
test('interactive absent or false keeps submission identity; true is distinct; a replay returns the same task',()=>{
 const f=fixture();try{
 const sub=submissionSchema.parse({submissionId:'replay',title:'Task',repoPath:'/repo',planningCommit:base,handoffPath:'handoff.md',originAgentId:'origin'});
 assert.equal(submissionHash(sub),submissionHash({...sub,interactive:false}));
 assert.notEqual(submissionHash(sub),submissionHash({...sub,interactive:true}));
 const a=f.store.insert({...sub,interactive:true},'host','handoff',base);
 const b=f.store.insert({...sub,interactive:true},'host','handoff',base);
 assert.equal(a.id,b.id);
 const plain=Buffer.byteLength(JSON.stringify(summarizeTask({...a,interactive:undefined})));
 assert.equal(Buffer.byteLength(JSON.stringify(summarizeTask(a)))-plain,19);
 }finally{void f.close()}
});
test('the interactive prompt carries no checkpoint or context-pressure reporting during the session',()=>{
 const f=fixture();try{
 for(const mcp of [false,true]){
 const prompt=workerPrompt(interactive(f),mcp);
 assert.equal(prompt.includes('If context pressure stops the turn, commit and report blocked'),false,'unconditional context-pressure reporting conflicts with the session');
 }
 }finally{void f.close()}
});
test('an accepted blocked or error report during the session leaves the interactive wait for the ordinary flow',async()=>{
 for(const status of ['blocked','error'] as const){
 const f=fixture();try{
 interactive(f);f.store.setCredential(f.current().runId!,'token');
 f.engine.complete({eventId:status,taskId:f.task.id,runId:f.current().runId!,status,summary:'Execution stopped'},'token');
 await f.engine.scheduleTaskQuantum(f.task.id);
 assert.equal(f.current().phase,status);
 assert.notEqual(f.current().resolution.stop?.reason,'interactive');
 }finally{await f.close()}
 }
});

test('a replacement worker after submission and review does not reopen the interactive session',async()=>{
 const f=fixture();try{
 const replacement=profile('replacement');f.engine.profiles.push(replacement);
 f.store.setMeta('pool',[...f.store.pool(),{profileId:replacement.id,enabled:true,group:'replacement',roles:['worker'],weight:1,scopes:['general']}]);
 interactive(f,{phase:'changes_requested',prUrl:'https://github.com/example/repo/pull/1',completion:{taskId:f.task.id,runId:f.current().runId!,eventId:'submitted',status:'ready_for_review',summary:'Operator submitted',prNumber:1}});
 const revision:Run={id:'revision-failover',taskId:f.task.id,role:'revision',generation:1,head,base,workspaceId:'workspace',agentId:'worker',profile:f.current().profile!,profileGroup:'author',status:'running',createdAt:old,lastObservedAt:old,active:false,idleSince:old,completion:null,released:false};
 f.store.putRun(revision);f.store.update(f.task.id,{resolution:{...f.current().resolution,currentRunId:revision.id}});
 f.states.set('worker',{id:'worker',workspaceId:'workspace',status:'error',active:false,permissions:false,error:'usage limit reached'});
 // PR #610: an errored retained revision thread is resumed in place before any failover. The fixture has
 // no delivery channel, so once the scheduled continuation comes due the resume is refused and quota
 // failover arms the replacement; the interactive session still never reopens.
 await (f.engine as any).recoverExhaustedWorkers();
 const scheduled=f.store.run(revision.id)!.transientProviderRetry;
 assert.equal(scheduled?.status,'waiting',f.current().reason);
 f.store.putRun({...f.store.run(revision.id)!,transientProviderRetry:{...scheduled,retryAt:'2000-01-01T00:00:00.000Z'}});
 await (f.engine as any).recoverExhaustedWorkers();
 assert.equal(f.events('worker_replacement').length,1,f.current().reason);
 assert.equal(f.current().resumePrNumber,1);
 await f.engine.scheduleTaskQuantum(f.task.id);
 assert.equal(workerPrompt(f.current()).includes('INTERACTIVE TASK'),false,'replacement after submission must follow ordinary revision flow; stop='+f.current().resolution.stop?.reason);
 }finally{await f.close()}
});
test('a checkpoint report during an interactive session is refused and continues nothing', async()=>{
 const f=fixture();try{
 interactive(f);f.store.setCredential(f.current().runId!,'token');
 (f.adapter as any).verifyCheckpoint=async()=>{};
 (f.adapter as any).preflightWorkerContinuation=async()=>({available:true});
 let delivered='';(f.adapter as any).continueWorker=async(_t:any,_id:any,prompt:string)=>{delivered=prompt};
 await assert.rejects(f.engine.complete({taskId:f.task.id,runId:f.current().runId!,eventId:'checkpoint',status:'progress_checkpoint',summary:'Tranche built',head},'token'),/This task is interactive/);
 await f.engine.wake();
 assert.equal(f.current().completion,null);
 assert.equal(f.current().checkpoints.records.length,0);
 assert.equal(delivered,'');
 }finally{await f.close()}
});

test('a transport outage keeps and then resumes the interactive wait',async()=>{
 const f=fixture();try{
 interactive(f);const observe=f.adapter.observe;let down=true;
 f.adapter.observe=async(id)=>{if(down)throw Error('Paseo transport disconnected');return observe(id)};
 await f.engine.scheduleTaskQuantum(f.task.id);down=false;
 await f.engine.scheduleTaskQuantum(f.task.id);
 assert.equal(f.current().phase,'working');assert.equal(f.current().resolution.stop?.reason,'interactive');
 }finally{await f.close()}
});

test('a quota failover before submission keeps the interactive session',async()=>{
 const f=fixture();try{
 const replacement=profile('replacement');f.engine.profiles.push(replacement);
 f.store.setMeta('pool',[...f.store.pool(),{profileId:replacement.id,enabled:true,group:'replacement',roles:['worker'],weight:1,scopes:['general']}]);
 interactive(f);f.states.set('worker',{id:'worker',workspaceId:'workspace',status:'error',active:false,permissions:false,error:'usage limit reached'});
 await (f.engine as any).recoverExhaustedWorkers();await f.engine.scheduleTaskQuantum(f.task.id);
 assert.equal(f.events('worker_replacement').length,1,f.current().reason);
 assert.equal(f.current().resolution.stop?.reason,'interactive');
 assert.equal(f.current().resumePrNumber,null);
 }finally{await f.close()}
});

test('a replacement after a pre-PR administrative revision receives ordinary reporting instructions',async()=>{
 const f=fixture();try{
 const replacement=profile('replacement');f.engine.profiles.push(replacement);
 f.store.setMeta('pool',[...f.store.pool(),{profileId:replacement.id,enabled:true,group:'replacement',roles:['worker'],weight:1,scopes:['general']}]);
 interactive(f,{phase:'changes_requested',completion:{taskId:f.task.id,runId:f.current().runId!,eventId:'blocked-before-pr',status:'blocked',summary:'Provider quota exhausted'}});
 const revision:Run={id:'revision-failover',taskId:f.task.id,role:'revision',generation:1,head,base,workspaceId:'workspace',agentId:'worker',profile:f.current().profile!,profileGroup:'author',status:'running',createdAt:old,lastObservedAt:old,active:false,idleSince:old,completion:null,released:false};
 f.store.putRun(revision);f.store.update(f.task.id,{resolution:{...f.current().resolution,currentRunId:revision.id}});
 f.states.set('worker',{id:'worker',workspaceId:'workspace',status:'error',active:false,permissions:false,error:'usage limit reached'});
 let receivedPrompt='';const create=f.adapter.createAgent;f.adapter.createAgent=async(...args)=>{receivedPrompt=args[2];return create(...args)};
 // PR #610: the same-thread continuation comes first; the fixture's missing delivery channel refuses it
 // once due, and only then does quota failover replace the worker.
 await (f.engine as any).recoverExhaustedWorkers();
 const scheduled=f.store.run(revision.id)!.transientProviderRetry;
 assert.equal(scheduled?.status,'waiting',f.current().reason);
 f.store.putRun({...f.store.run(revision.id)!,transientProviderRetry:{...scheduled,retryAt:'2000-01-01T00:00:00.000Z'}});
 await (f.engine as any).recoverExhaustedWorkers();
 assert.equal(f.events('worker_replacement').length,1,f.current().reason);
 assert.equal(f.current().resumePrNumber,null);
 await f.engine.scheduleTaskQuantum(f.task.id);
 assert.equal(receivedPrompt.includes('INTERACTIVE TASK'),false,'replacement receives session instructions although reconcile closes it; stop='+f.current().resolution.stop?.reason);
 }finally{await f.close()}
});
