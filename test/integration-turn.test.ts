import { fakeAdapter, profile } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { queueOperationSchema } from '../shared/operations';
import { Engine } from '../core/engine';
import { submissionSchema, type Profile, type Run, type Completion } from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';
import type { ResolutionAdapter } from '../core/resolution';
import { requiredCheckPollMetaKey } from '../core/forge/index';
import { ownerRevisionFixture } from './support/review-entry-fixture';
import { observedParticipantTimeline } from './support/tool-timeline';
import { waitFor } from './support/budgets';
import { readHostUidProcesses } from '../core/machine/host-process-listing';

const head = 'a'.repeat(40), base = 'b'.repeat(40), merged = 'c'.repeat(40);

function fixture(realSource=false, graceMs=0) {
  const source=realSource?ownerRevisionFixture():null;
  const head=source?.oldHead??'a'.repeat(40), base=source?.planningCommit??'b'.repeat(40);
  const dir=source?.root??mkdtempSync(join(tmpdir(),'ns-turn-')), store=source?.store??new Store(join(dir,'queue.sqlite'));
  const worker=profile('author'), reviewer=profile('reviewer'), coordinator=profile('coordinator');
  store.setMeta('paused',false);
  // The fixtures exercise agent closeout on a repository with no manifest; the
  // project override pins it (Spec 022's Queue closeout is the default).
  store.putRepository({origin:source?'example/repo':null,path:source?.repo??'/repo'},'agent','fixture keeps agent closeout');
  store.setMeta('pool',[{profileId:worker.id,enabled:true,group:'author',roles:['worker'],weight:1,scopes:['general']},{profileId:reviewer.id,enabled:true,group:'review',roles:['reviewer'],weight:1,scopes:['general']},{profileId:coordinator.id,enabled:true,group:'coordinate',roles:['coordinator'],weight:1,scopes:['general']}]);
  const states=new Map<string,AgentObservation>();
  const idle=(id: string, workspaceId='workspace')=>states.set(id,{id,workspaceId,status:'idle',active:false,permissions:false,error:'',provider:'test',model:states.get(id)?.model??'author'});
  idle('origin','origin-workspace');
  const tokens=new Map<string,string>(), creates:Run[]=[], sends:Run[]=[];
  const heads=new Map<string,string>();
  const bases=new Map<string,string>();
  const gates=new Map<string,{wait:string;needsRebase?:boolean;checksFailed?:boolean;overdue?:boolean;pendingCheck?:boolean}>();
  const mergedTasks=new Set<string>();
  let merges=0,syncs=0,reviewChecks=0;
  function add(repoPath=source?.repo??'/repo') {
    const submitted=store.insert(submissionSchema.parse({submissionId:randomUUID(),title:'Task',repoPath,planningCommit:base,handoffPath:'handoff.md',originAgentId:'origin'}),'host','handoff',base);
    const workspace=`ws-${submitted.id}`;
    const workerId=`worker-${submitted.id}`;
    idle(workerId,workspace);
    heads.set(submitted.id,head);
    bases.set(submitted.id,base);
    const task=store.update(submitted.id,{phase:'awaiting_review',workspaceIntent:true,agentIntent:true,workspaceId:workspace,directory:source&&heads.size===1?source.workspace:`/worktree/${submitted.id}`,...(source&&heads.size===1?{branch:'feature/external'}:{}),agentId:workerId,runId:`initial-${submitted.id}`,profile:worker,workerModel:worker.model,prHead:head,prUrl:`https://github.com/example/repo/pull/${submitted.id.slice(0,8)}`,agentActive:false,lastAgentStatus:'idle',lastObservedAt:new Date().toISOString(),completion:{taskId:submitted.id,runId:`initial-${submitted.id}`,eventId:`initial-${submitted.id}`,status:'ready_for_review',summary:'Ready',prNumber:Number.parseInt(submitted.id.replace(/\D/g,'').slice(0,6) || '1',10) || 1}});
    return task;
  }
  const adapter: Adapter & ResolutionAdapter = fakeAdapter({
    profiles:async()=>[worker,reviewer,coordinator],validate:async()=>base,verifyWorkspace:async()=>'branch',
    createWorkspace:async()=>{throw new Error('Review must not create workspaces')},createAgent:async()=>{throw new Error('No initial dispatch')},
    observe:async id=>{const s=states.get(id);if(!s)throw new Error('Agent missing');return s},
    agentTimelinePage:observedParticipantTimeline(states),
    verifyPr:async t=>({head:heads.get(t.id)??head,url:t.prUrl!}),
    verifyPrIdentity:async t=>({head:heads.get(t.id)??head,url:t.prUrl!}),
    coveringEvidence: async t => ({ head: t.prHead!, base: t.resolution.mergeBase ?? t.planningBase, wait: '' }),
    createRun:async(t,r,token)=>{creates.push(r);tokens.set(r.id,token);const id=`agent-${r.id}`;states.set(id,{id,workspaceId:r.workspaceId,status:'running',active:true,permissions:false,error:'',provider:r.profile?.provider,model:r.profile?.model});return{id,workspaceId:r.workspaceId}},
    sendRun:async(t,r,token)=>{sends.push(r);tokens.set(r.id,token);states.set(r.agentId!,{...states.get(r.agentId!)!,active:true,status:'running'})},findRunAgents:async()=>[],
    verifyReview:async(t,r,c)=>{reviewChecks++;if(c.head!==(heads.get(t.id)??head))throw new Error('Stale PR head')},
    mergeGate:async t=>{
      const extra=gates.get(t.id);
      return {head:heads.get(t.id)??head,base:bases.get(t.id)??base,wait:extra?.wait??'',needsRebase:extra?.needsRebase,checksFailed:extra?.checksFailed,overdue:extra?.overdue,pendingCheck:extra?.pendingCheck};
    },
    requiredChecks:async t=>{
      const extra=gates.get(t.id);
      return {head:heads.get(t.id)??head,wait:extra?.wait??'',needsRebase:extra?.needsRebase,checksFailed:extra?.checksFailed,overdue:extra?.overdue,pendingCheck:extra?.pendingCheck};
    },
    merge:async t=>{merges++;mergedTasks.add(t.id)},
    merged:async t=>({merged:mergedTasks.has(t.id),commit:merged,head:heads.get(t.id)??head,base:'main'}),syncMain:async()=>{syncs++;return source?.planningCommit??merged},verifyCloseout:async()=>{},notify:async()=>{},
  });
  const engine=new Engine(store,adapter,graceMs);engine.profiles=[worker,reviewer,coordinator];
  const current=(id:string)=>store.task(id);
  const run=(id:string)=>store.run(current(id).resolution.currentRunId!)!;
  async function report(id:string,status:Completion['status']) {
    const r=run(id);idle(r.agentId!,r.workspaceId);
    // A revision reports the pushed PR head the fake forge now shows, while its run
    // keeps the head it was dispatched at: reporting r.head for a revision would
    // claim an unchanged return (#394 review reuse) for a genuinely changed PR.
    // Every other role reports the head it was dispatched at (closeout reports the
    // synced commit, not the PR head).
    const reportedHead=r.role==='revision'?(heads.get(id)??r.head):r.head;
    const input:Completion={eventId:randomUUID(),taskId:id,runId:r.id,status,summary:status,head:reportedHead,...(r.role==='reviewer'?{reviewCommentId:1}:{}),...(r.role==='closeout'?{coordinatorGeneration:r.generation}:{}),...(r.role==='revision'?{prNumber:current(id).completion?.prNumber}: {})};
    engine.resolution.complete(input,tokens.get(r.id)!);await engine.wake();return input;
  }
  const roleCounts=(id:string,role:Run['role'])=>store.runs(id).filter(r=>r.role===role).length;
  const moveHead=(id:string, h:string)=>{const next=source?source.pushRevision(h):h;heads.set(id,next);return next};
  return {states,dir,store,engine,adapter,add,moveHead,current,run,report,idle,tokens,creates,sends,heads,bases,gates,roleCounts,counts:()=>({merges,syncs,reviewChecks}),close:async()=>{await engine.stop();if(source)source.close();else{store.close();rmSync(dir,{recursive:true,force:true})}}};
}

test('a reported participant stray tool is reaped after grace and the merge lease proceeds',async()=>{
 const f=fixture(false,100);let childPid:number|null=null;try{
  const task=f.add();
  const workspace=join(f.dir,'reported-worktree');mkdirSync(workspace);
  f.store.update(task.id,{directory:workspace,phase:'verifying',reason:'Mechanical verification satisfied the merge gates'});
  const orphanScript=join(f.dir,'launch-orphan.mjs'),pidFile=join(f.dir,'orphan.pid');
  writeFileSync(orphanScript,"import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const child=spawn(process.execPath,['-e','setInterval(() => {}, 1000)'],{cwd:process.argv[2],stdio:'ignore',detached:true});child.unref();writeFileSync(process.argv[3],String(child.pid));");
  const launcher=spawn(process.execPath,[orphanScript,workspace,pidFile],{cwd:f.dir,stdio:'ignore'});
  await once(launcher,'exit');
  childPid=Number(readFileSync(pidFile,'utf8'));
  const listing=await readHostUidProcesses();
  const facts=listing.state==='listed'?listing.processes:null;
  const childFact=facts?.find(fact=>fact.pid===childPid);
  assert.ok(childFact,'the host listing sees the started worktree process');
  assert.equal(childFact.cwd,workspace);
  assert.equal(f.current(task.id).directory,workspace);
  f.adapter.hostProcessListing=async()=>facts;
  let checks=0;
  f.engine.resolution.ownedToolHold=async()=>++checks===1
   ? 'an owned tool is still live: observed tool Bash (shell) is running; descendant pid 123 remains under provider pid 45'
   : null;
  const current=f.current(task.id);
  f.store.event(task.id,'owned_tool_hold',JSON.stringify({runId:current.runId,reason:'stray shell'}));
  await new Promise(resolve=>setTimeout(resolve,120));
  f.engine.resolution.assignIntegrationTurn(f.current(task.id));
  assert.equal(await f.engine.resolution.executionLease(f.current(task.id)),true);
  assert.ok(f.store.eventsAll(task.id).some(event=>event.kind==='participant_tool_reaped'), JSON.stringify(f.store.eventsAll(task.id).filter(event=>event.kind.startsWith('participant_tool_'))));
  assert.throws(()=>process.kill(childPid!,0),{code:'ESRCH'});
  assert.equal(f.store.task(task.id).resolution.integrationTurn?.sequence,1);
 }finally{if(childPid){try{process.kill(childPid,'SIGKILL')}catch{}}await f.close()}
});

test('another approved task merges while the first waits on its participant tool',async()=>{
 const f=fixture(false,60_000);try{
  const waiting=f.add(),later=f.add();
  f.store.event(waiting.id,'owned_tool_hold',JSON.stringify({runId:f.current(waiting.id).runId,reason:'stray shell'}));
  f.engine.resolution.ownedToolHold=async(_agentId,options)=>options?.taskId===waiting.id
   ? 'an owned tool is still live: observed tool Bash (shell) is running'
   : null;
  await f.engine.wake();
  await f.report(waiting.id,'ready_to_merge');
  assert.equal(f.current(waiting.id).resolution.integrationTurn,null,'the blocked task yields its FIFO place');
  assert.match(f.current(waiting.id).reason,/stray-tool grace ends at/);
  await f.engine.wake();
  await f.report(later.id,'ready_to_merge');
  await f.engine.wake();await f.engine.wake();
  assert.equal(f.counts().merges,1,'the later reviewed task merges while the first participant wait is open');
  assert.ok(f.current(later.id).resolution.mergedCommit,'the later task records its landed merge');
  assert.equal(f.current(waiting.id).resolution.mergedCommit,null,'the task waiting on its participant has not merged');
 }finally{await f.close()}
});

test('a tool belonging to a live participant turn is never reaped',async()=>{
 const f=fixture();try{
  const task=f.add(),worker=f.current(task.id).agentId!;
  f.states.set(worker,{...f.states.get(worker)!,status:'running',active:true});
  let listings=0;
  f.adapter.hostProcessListing=async()=>{listings++;return[];};
  f.engine.resolution.ownedToolHold=async()=> 'an owned tool is still live: observed tool Bash (shell) is running';
  const current=f.current(task.id);
  f.store.update(task.id,{phase:'verifying',reason:'Mechanical verification satisfied the merge gates'});
  f.engine.resolution.assignIntegrationTurn(f.current(task.id));
  assert.equal(await f.engine.resolution.executionLease(f.current(task.id)),false);
  assert.equal(listings,0,'the host sweep is unreachable while a participant turn is live');
  assert.equal(f.store.eventsAll(task.id).some(event=>event.kind==='participant_tool_reaped'),false);
 }finally{await f.close()}
});

test('a merge-held reviewed task does not keep the integration turn from later tasks',async()=>{
 const f=fixture();try{
  // Live, 2026-09-29 (project-a #1672): a held task with an earlier turn stalled #1686 and #1680,
  // both reviewed and clean, at "Waiting for repository integration turn".
  const first=f.add(),second=f.add();
  await f.engine.performTaskControl({taskId:first.id,version:f.current(first.id).version,action:'hold',reason:'Test hold'});
  await f.engine.wake();await f.report(first.id,'ready_to_merge');
  await f.engine.wake();await f.report(second.id,'ready_to_merge');
  assert.ok(f.current(first.id).resolution.integrationTurn!.sequence < f.current(second.id).resolution.integrationTurn!.sequence);
  await f.engine.wake();await f.engine.wake();
  assert.equal(f.counts().merges,1,'the later task merges while the earlier one is held');
  assert.match(f.current(first.id).reason,/Merge held by operator/);
  assert.equal(f.current(first.id).resolution.mergeIntent,false);
 }finally{await f.close()}
});
test('a reviewed task merges while live agents fill every project slot',async()=>{
 const f=fixture();try{
  const reviewed=f.add();
  await f.engine.wake();
  // Slots count live agents and verification creates none: merging must not wait for one.
  const busy=f.add();
  f.states.set(`worker-${busy.id}`,{...f.states.get(`worker-${busy.id}`)!,status:'running',active:true});
  f.store.update(busy.id,{phase:'working',agentActive:true,lastAgentStatus:'running'},'fixture_live_agent');
  f.store.setMeta('globalLimit',1);f.store.setMeta('projectLimit',1);
  await f.report(reviewed.id,'ready_to_merge');
  await f.engine.wake();
  assert.equal(f.counts().merges,1);
 }finally{await f.close()}
});

test('two reviewed tasks keep FIFO turns; the newer task cannot merge during the older turn',async()=>{
 const f=fixture();try{
  const first=f.add(),second=f.add();
  await f.engine.wake();await f.report(first.id,'ready_to_merge');
  await f.engine.wake();await f.report(second.id,'ready_to_merge');
  assert.ok(f.current(first.id).resolution.integrationTurn);assert.ok(f.current(second.id).resolution.integrationTurn);
  assert.ok(f.current(first.id).resolution.integrationTurn!.sequence < f.current(second.id).resolution.integrationTurn!.sequence);
  await f.engine.wake();
  assert.equal(f.counts().merges,1);
  assert.equal(f.current(second.id).phase,'verifying');
  assert.equal(f.current(second.id).resolution.currentRunId,null);
  assert.match(f.current(second.id).reason,/integration turn/);
  await f.engine.wake();await f.engine.wake();
  await f.report(first.id,'closed');
  assert.equal(f.current(first.id).phase,'done');
  // Commit acdc1380 completes mechanical verify, merge, synchronize and closeout in
  // one drain once the older turn is released, so the newer task lands and dispatches
  // closeout without stopping at a transient `merging` phase.
  await f.engine.wake();
  assert.equal(f.counts().merges,2,'the newer task merges once the older turn is released');
  assert.equal(f.current(second.id).phase,'closing');
 }finally{await f.close()}
});

test('one fresh gate supplies the current base directly to merge intent',async()=>{
 const f=fixture();try{
  const task=f.add();
  // Without a prospective hook there is no earlier candidate base to compare:
  // the one fresh gate supplies the base immediately used for merge intent.
  let observations=0, gateMs=0;
  const attemptStarted=Date.now();
  f.adapter.mergeGate=async t=>{observations++;const started=Date.now();await new Promise(resolve=>setTimeout(resolve,30));gateMs+=Date.now()-started;return {head:f.heads.get(t.id)??head,base:'8'.repeat(40),wait:''}};
  await f.engine.wake();
  await f.report(task.id,'ready_to_merge');
  for(let round=0;round<20&&f.counts().merges===0;round++)await f.engine.wake();
  console.log('merge-attempt fixture',JSON.stringify({gateReads:observations,gateMs,wallMs:Date.now()-attemptStarted,steps:f.store.eventsAll(task.id).filter(event=>/merge_.*duration/.test(event.kind)).map(event=>[event.kind,event.detail])}));
  assert.equal(observations,1,'one full merge gate per successful attempt');
  assert.equal(f.counts().merges,1);
  assert.equal(f.current(task.id).resolution.mechanicalVerification?.base,'8'.repeat(40));
  assert.equal(f.current(task.id).resolution.review?.status,'ready_to_merge','the accepted review stays as evidence');
  // A base-advance refresh never dispatches a new run.
  assert.equal(f.roleCounts(task.id,'reviewer'),1);
  assert.equal(f.roleCounts(task.id,'revision'),0);
  assert.equal(f.roleCounts(task.id,'verification'),0);
 }finally{await f.close()}
});

test('restart preserves turn order and does not duplicate merge intent',async()=>{
 const f=fixture();let reopened:Store|undefined;let successor:Engine|undefined;
 try{
  const first=f.add(),second=f.add();
  await f.engine.wake();await f.report(first.id,'ready_to_merge');await f.engine.wake();await f.report(second.id,'ready_to_merge');
  await f.engine.wake();
  assert.equal(f.current(first.id).resolution.mergeIntent,true);assert.equal(f.counts().merges,1);
  const db=join(f.dir,'queue.sqlite');await f.engine.stop();f.store.close();
  reopened=new Store(db);successor=new Engine(reopened,f.adapter,0);successor.profiles=f.engine.profiles;
  const restoredFirst=reopened.task(first.id),restoredSecond=reopened.task(second.id);
  assert.equal(restoredFirst.resolution.mergeIntent,true);assert.equal(restoredFirst.resolution.mergedCommit,merged);
  assert.ok(restoredFirst.resolution.integrationTurn!.sequence < restoredSecond.resolution.integrationTurn!.sequence);
  await successor.wake();
  assert.equal(reopened.task(second.id).phase,'verifying');
  assert.match(reopened.task(second.id).reason,/integration turn/);
  assert.equal(f.counts().merges,1);
 }finally{await successor?.stop();reopened?.close();try{await f.engine.stop();}catch{} rmSync(f.dir,{recursive:true,force:true})}
});

test('the final gate refuses a changed PR head before intent',async()=>{
 const f=fixture();try{
  const task=f.add();
  f.adapter.mergeGate=async()=>({head:'f'.repeat(40),base,wait:''});
  await f.engine.wake();await f.report(task.id,'ready_to_merge');
  await f.engine.wake();
  assert.equal(f.counts().merges,0);
  assert.equal(f.current(task.id).resolution.mergeIntent,false);
  assert.match(f.current(task.id).reason,/Head changed after review/);
 }finally{await f.close()}
});

test('a stored merging task discards old mechanical proof after restart',async()=>{
 const f=fixture();let reopened:Store|undefined;let successor:Engine|undefined;
 try{
  const task=f.add();
  f.gates.set(task.id,{wait:'Fixture holds the gate'});
  await f.engine.wake();await f.report(task.id,'ready_to_merge');
  f.store.update(task.id,{phase:'merging'});
  assert.equal(f.current(task.id).phase,'merging');
  f.store.update(task.id,{resolution:{...f.current(task.id).resolution,
    mechanicalVerification:{at:new Date().toISOString(),head,base},mergeBase:base}});
  const db=join(f.dir,'queue.sqlite');await f.engine.stop();f.store.close();
  let reads=0;
  f.adapter.mergeGate=async()=>{reads++;return {head,base:'d'.repeat(40),wait:''}};
  reopened=new Store(db);successor=new Engine(reopened,f.adapter,0);successor.profiles=f.engine.profiles;
  await successor.wake();
  assert.equal(reads,1);
  assert.equal(f.counts().merges,1);
  assert.equal(reopened.task(task.id).resolution.mergeBase,'d'.repeat(40));
 }finally{await successor?.stop();reopened?.close();try{await f.engine.stop()}catch{} rmSync(f.dir,{recursive:true,force:true})}
});

test('an overdue required check yields the turn, rechecks on schedule, and reacquires after settlement',async()=>{
 const f=fixture();try{
  const first=f.add(),second=f.add();
  await f.engine.wake();
  const wait="Required check 'build' has been pending past its deadline (1h elapsed, bound 30m); job URL: https://github.com/example/repo/actions/runs/9";
  f.gates.set(first.id,{wait,overdue:true,pendingCheck:true});
  await f.report(first.id,'ready_to_merge');await f.engine.wake();
  assert.equal(f.current(first.id).phase,'verifying');
  assert.equal(f.current(first.id).resolution.attention,true);
  assert.equal(f.current(first.id).reason,wait);
  assert.ok(f.current(first.id).resolution.integrationTurn);
  await f.report(second.id,'ready_to_merge');await f.engine.wake();await f.engine.wake();
  assert.equal(f.counts().merges,1,'a later green task integrates while the external check is pending');
  const laterTurn=f.current(second.id).resolution.integrationTurn!;
  f.gates.delete(first.id);
  f.store.setMeta(requiredCheckPollMetaKey(first.id,head),{head,nextAt:0});
  await f.engine.wake();
  assert.equal(f.current(first.id).resolution.attention,false,'a settled check closes its stale attention episode');
  assert.ok(f.current(first.id).resolution.integrationTurn!.sequence<laterTurn.sequence,'the settled task keeps its place in the FIFO lane');
  assert.ok(f.engine.resolution.integrationActive(f.current(first.id)));
 }finally{await f.close()}
});

test('a failed required check releases the integration turn and returns the same PR to the retained worker',async()=>{
 const f=fixture(true);try{
  const first=f.add(),second=f.add();
  // The report drains through verification to the merge gate, so the gate is
  // in place before the report (engine quiesce waits for follow-ups, #346).
  f.gates.set(first.id,{wait:'PR checks failed: lint (job URL: https://github.com/example/repo/actions/runs/9)',checksFailed:true});
  await f.engine.wake();await f.report(first.id,'ready_to_merge');
  assert.equal(f.current(first.id).phase,'changes_requested');assert.equal(f.current(first.id).resolution.attention,false);
  assert.equal(f.current(first.id).resolution.integrationTurn,null);
  // Lifecycle follow-ups chain only through verifying..closing; the revision
  // launches on the next sweep, as it does in production.
  await f.engine.wake();
  // Commit acdc1380 launches the revision in that sweep's drain, so the task reason has
  // already moved to the running-revision status. The failed check's name and job URL
  // (the action/status split of commit 3b1993c2) travel on the retained worker's
  // immutable run instruction, and the pending instruction is consumed.
  assert.equal(f.run(first.id).role,'revision');
  assert.match(f.run(first.id).instruction!,/job URL: https:\/\/github.com\/example\/repo\/actions\/runs\/9/);
  assert.equal(f.current(first.id).resolution.pendingWorkerInstruction,null);
  await f.report(second.id,'ready_to_merge');await f.engine.wake();await f.engine.wake();
  assert.equal(f.counts().merges,1,'the next reviewed task merges while the first reworks its checks');
  const secondSequence=f.current(second.id).resolution.integrationTurn!.sequence;
  await f.engine.wake();await f.engine.wake();await f.engine.wake();
  assert.ok(f.run(second.id),f.current(second.id).reason);
  assert.equal(f.run(second.id).role,'closeout');
  await f.report(second.id,'closed');
  await f.engine.wake();assert.equal(f.run(first.id).role,'revision');assert.equal(f.run(first.id).agentId,f.current(first.id).agentId);
  f.gates.delete(first.id);
  // The rework is a genuinely new head: the fake forge moves to the pushed head
  // before the revision reports, so this is a changed-head return and never the
  // unchanged return (#394) that may reuse an accepted exact-head review.
  const reworked=f.moveHead(first.id,'f'.repeat(40));
  const accepted=f.current(first.id).resolution.review!;
  await f.report(first.id,'ready_for_review');await f.engine.wake();
  assert.equal(f.current(first.id).resolution.review,null,'a changed head discards the earlier accepted review');
  assert.equal(f.run(first.id).role,'reviewer','the changed head earns its own independent review');
  assert.equal(f.roleCounts(first.id,'reviewer'),2);
  await f.report(first.id,'ready_to_merge');await f.engine.wake();await f.engine.wake();
  // The reworked PR re-queues with a fresh, later turn behind the finished second task.
  assert.equal(f.current(first.id).resolution.review?.head,reworked,'the accepted review covers the pushed head');
  assert.notEqual(f.current(first.id).resolution.review?.eventId,accepted.eventId,'the review of the old head is not reused');
  assert.equal(f.current(first.id).resolution.mergeHead,reworked);
  assert.ok(!f.store.eventsAll(first.id).some(event=>event.kind==='unchanged_check_revision'),'a changed head is never an unchanged-return reuse');
  assert.ok(f.current(first.id).resolution.integrationTurn!.sequence > secondSequence);
  assert.equal(f.counts().merges,2);
  await f.engine.wake();
  assert.equal(f.current(first.id).resolution.mergedCommit,merged);
 }finally{await f.close()}
});

test('an unchanged failed-check return reuses the accepted exact-head review without a second review',async()=>{
 const f=fixture();try{
  const task=f.add();
  const wait='PR checks failed: lint (job URL: https://github.com/example/repo/actions/runs/9)';
  f.gates.set(task.id,{wait,checksFailed:true});
  await f.engine.wake();await f.report(task.id,'ready_to_merge');
  const accepted=f.current(task.id).resolution.review!;
  assert.equal(accepted.status,'ready_to_merge');
  assert.equal(f.current(task.id).phase,'changes_requested');
  await f.engine.wake();
  assert.equal(f.run(task.id).role,'revision');
  assert.equal(f.run(task.id).instruction,wait,'the failed check is the author instruction');
  // The author changes no source: the fake forge still shows the reviewed head and
  // the revision reports exactly that head, so the reviewed bytes are identical.
  await f.report(task.id,'ready_for_review');
  assert.equal(f.current(task.id).resolution.review?.eventId,accepted.eventId,'the accepted exact-head review survives the unchanged return');
  assert.equal(f.roleCounts(task.id,'reviewer'),1,'identical bytes buy no second review');
  assert.ok(f.store.eventsAll(task.id).some(event=>event.kind==='unchanged_check_revision'));
  for(let round=0;round<4&&f.current(task.id).resolution.stop?.reason!=='escalated';round++)await f.engine.wake();
  assert.equal(f.current(task.id).resolution.stop?.reason,'escalated');
  assert.match(f.current(task.id).reason,/Waiting with the planner/);
  assert.ok(f.store.eventsAll(task.id).some(event=>event.kind==='unchanged_check_revision_refused'
    &&/unchanged at the reviewed head/.test(event.detail)&&/actions\/runs\/9/.test(event.detail)),
    'the unchanged check and its job URL stay in the durable refusal');
  assert.equal(f.counts().merges,0,'the failed check still blocks merge');
  assert.equal(f.roleCounts(task.id,'reviewer'),1);
 }finally{await f.close()}
});

test('an unchanged return without accepted exact-head review evidence still requires a fresh review',async()=>{
 for(const loss of ['unpublished','absent'] as const){const f=fixture();try{
  const task=f.add();
  const wait='PR checks failed: lint (job URL: https://github.com/example/repo/actions/runs/9)';
  f.gates.set(task.id,{wait,checksFailed:true});
  await f.engine.wake();await f.report(task.id,'ready_to_merge');
  const accepted=f.current(task.id).resolution.review!;
  await f.engine.wake();
  assert.equal(f.run(task.id).role,'revision');
  // Reuse rests on accepted published exact-head evidence. Without it - the
  // publication id is gone, or no accepted review record stands at this head -
  // the unchanged return goes back through independent review.
  const resolution=f.current(task.id).resolution;
  f.store.update(task.id,{resolution:loss==='unpublished'?{...resolution,review:{...accepted,reviewCommentId:undefined}}:{...resolution,review:null}},'fixture_review_evidence_lost');
  await f.report(task.id,'ready_for_review');
  assert.equal(f.current(task.id).phase,'reviewing',`${loss}: unchanged bytes without accepted evidence return to review`);
  for(let round=0;round<4&&!f.current(task.id).resolution.currentRunId;round++)await f.engine.wake();
  assert.equal(f.run(task.id).role,'reviewer',`${loss}: missing accepted evidence requires a fresh review`);
  assert.equal(f.roleCounts(task.id,'reviewer'),2,loss);
  assert.ok(!f.store.eventsAll(task.id).some(event=>event.kind==='unchanged_check_revision'),`${loss}: no review reuse without accepted evidence`);
  assert.equal(f.counts().merges,0,loss);
 }finally{await f.close()}}
});

test('a behind mergeable head merges with the recorded current base and reviewed head',async()=>{
 const f=fixture();try{
  const task=f.add();const later='d'.repeat(40);
  f.bases.set(task.id,later);
  await f.engine.wake();await f.report(task.id,'ready_to_merge');await f.engine.wake();
  assert.equal(f.current(task.id).resolution.mergeHead,head);
  assert.equal(f.current(task.id).resolution.mergeBase,later);
  assert.equal(f.counts().merges,1);assert.equal(f.roleCounts(task.id,'revision'),0);
 }finally{await f.close()}
});

test('a merge conflict returns the existing PR to the worker and requires a fresh exact-head review',async()=>{
 const f=fixture(true);try{
  const task=f.add();
  f.gates.set(task.id,{wait:'GitHub reports a merge conflict; the worker must update the PR head',needsRebase:true});
  await f.engine.wake();await f.report(task.id,'ready_to_merge');
  assert.equal(f.current(task.id).phase,'changes_requested');
  assert.equal(f.current(task.id).resolution.integrationTurn,null);
  await f.engine.wake();assert.equal(f.run(task.id).role,'revision');assert.equal(f.run(task.id).agentId,f.current(task.id).agentId);
  f.moveHead(task.id,'e'.repeat(40));f.gates.delete(task.id);await f.report(task.id,'ready_for_review');
  await f.engine.wake();assert.equal(f.run(task.id).role,'reviewer');
 }finally{await f.close()}
});

test('an enforced update-branch rule uses the revision path instead of merging a behind head',async()=>{
 const f=fixture();try{
  const task=f.add();
  f.gates.set(task.id,{wait:'Repository requires the PR head to include the current base',needsRebase:true});
  await f.engine.wake();await f.report(task.id,'ready_to_merge');
  assert.equal(f.current(task.id).phase,'changes_requested');
  await f.engine.wake();
  // acdc1380 dispatches the revision in the next sweep's drain; the refusal text is carried
  // on the retained worker's immutable run rather than the transient task reason.
  assert.equal(f.run(task.id).role,'revision');
  assert.match(f.run(task.id).instruction!,/include the current base/);
  assert.equal(f.counts().merges,0);
 }finally{await f.close()}
});

test('a publication-blocked holder yields without renumbering or spinning, then rejoins in order', async () => {
 const f=fixture();try {
  const first=f.add(),second=f.add();
  await f.engine.wake();
  const key=`reviewPublication:${first.runId}`;
  f.store.setMeta(key,{status:'uncertain'});
  await f.report(first.id,'ready_to_merge');
  const sequence=f.current(first.id).resolution.integrationTurn!.sequence;
  assert.equal(f.engine.resolution.integrationActive(f.current(first.id)),false);
  await f.report(second.id,'ready_to_merge');await f.engine.wake();
  assert.equal(f.counts().merges,1,'the able successor merges while publication is unresolved');
  const before=f.store.eventsAll(first.id).length;
  for(let i=0;i<3;i++)await f.engine.wakeTask(first.id);
  assert.equal(f.store.eventsAll(first.id).length,before,'repeated yields do not schedule a polling loop or rewrite waits');
  assert.equal(f.current(first.id).resolution.integrationTurn!.sequence,sequence);
  f.bases.set(first.id,'d'.repeat(40));
  f.store.deleteMeta(key);
  assert.equal(f.engine.resolution.holdsIntegrationTurn(f.current(first.id)),true,'the original sequence rejoins ahead of later idle work');
  await f.engine.wakeTask(first.id);await f.engine.quiesce();
  assert.equal(f.counts().merges,2);
  assert.equal(f.current(first.id).resolution.mechanicalVerification?.base,'d'.repeat(40),'the returning task verifies the advanced base');
 }finally{await f.close()}
});

test('an uncertain merge holds the turn through attention, escalation, holds and pause', async () => {
 const f=fixture();try {
  const first=f.add(),second=f.add();
  f.engine.resolution.assignIntegrationTurn(first);f.engine.resolution.assignIntegrationTurn(second);
  const resolution=f.current(first.id).resolution;
  f.store.update(first.id,{phase:'needs_attention',held:true,resolution:{...resolution,mergeIntent:true,mergeResponseOutcome:'uncertain',attention:true}});
  f.store.update(second.id,{phase:'verifying'});
  f.store.setMeta('paused',true);
  assert.equal(f.engine.resolution.integrationActive(f.current(first.id)),true);
  assert.equal(f.engine.resolution.holdsIntegrationTurn(f.current(second.id)),false);
 }finally{await f.close()}
});

test('a rejoining earlier task cannot preempt a successor awaiting integration work', async () => {
 const f=fixture();try {
  const first=f.add(),second=f.add();
  for(const task of [first,second]) {
   f.store.update(task.id,{phase:'verifying'});f.engine.resolution.assignIntegrationTurn(f.current(task.id));
  }
  const key=`reviewPublication:${first.runId}`;f.store.setMeta(key,{status:'uncertain'});
  await f.engine.resolution.integrationQuantum(second.id,async()=>{
   assert.equal(f.engine.resolution.claimIntegrationTurn(f.current(second.id)),true);
   f.store.deleteMeta(key);
   await Promise.resolve();
   assert.equal(f.engine.resolution.holdsIntegrationTurn(f.current(second.id)),true);
   assert.equal(f.engine.resolution.claimIntegrationTurn(f.current(first.id)),false);
  });
  assert.equal(f.engine.resolution.holdsIntegrationTurn(f.current(first.id)),true);
 }finally{await f.close()}
});

test('a recovered earlier task cannot race a successor whose merge request is awaiting GitHub', async () => {
 const f=fixture();let release=()=>{};
 try {
  const first=f.add(),second=f.add();await f.engine.wake();
  const key=`reviewPublication:${first.runId}`;f.store.setMeta(key,{status:'uncertain'});
  await f.report(first.id,'ready_to_merge');
  const entered=new Promise<void>(resolve=>{
   const merge=f.adapter.merge!;
   const pending=new Promise<void>(done=>{release=done});
   f.adapter.merge=async(t,allowed)=>{
    if(t.id===second.id){resolve();await pending;}
    await merge(t,allowed);
   };
  });
  const reporting=f.report(second.id,'ready_to_merge');
  await entered;
  f.store.deleteMeta(key);
  assert.equal(f.engine.resolution.holdsIntegrationTurn(f.current(first.id)),false);
  await f.engine.wakeTask(first.id);
  assert.equal(f.counts().merges,0,'the earlier task cannot send while the successor awaits its response');
  release();await reporting;await f.engine.wake();
  if(f.current(second.id).phase==='closing')await f.report(second.id,'closed');
  await f.engine.wake();
  assert.equal(f.counts().merges,2,'both tasks integrate serially after the response settles');
 }finally{release();await f.close()}
});

test('a landed holder with an unresolved operation yields until the operation settles', async () => {
 const f=fixture();try {
  const first=f.add(),second=f.add();
  for(const task of [first,second])f.engine.resolution.assignIntegrationTurn(task);
  f.store.update(first.id,{phase:'closing',resolution:{...f.current(first.id).resolution,mergedCommit:merged,syncedCommit:merged}});
  f.store.update(second.id,{phase:'verifying'});
  const operation=queueOperationSchema.parse({id:'c'.repeat(64),key:'pending-closeout',kind:'task_control',inputHash:'a'.repeat(64),state:'needs_attention',taskId:first.id,expectedVersion:null,repoPath:first.repoPath,submissionId:null,createdAt:new Date().toISOString(),startedAt:null,settledAt:null,attempts:1,diagnostic:'unresolved',result:null,effect:null});
  f.store.putOperation(operation);
  assert.equal(f.engine.resolution.holdsIntegrationTurn(f.current(first.id)),false);
  assert.equal(f.engine.resolution.holdsIntegrationTurn(f.current(second.id)),true);
  f.store.putOperation({...operation,state:'failed',settledAt:new Date().toISOString()});
  assert.equal(f.engine.resolution.holdsIntegrationTurn(f.current(first.id)),true);
 }finally{await f.close()}
});

test('checking who holds the integration turn does not rescan every task',async()=>{
 const f=fixture();try{
  const first=f.add(),second=f.add();
  await f.engine.wake();await f.report(first.id,'ready_to_merge');
  await f.engine.wake();await f.report(second.id,'ready_to_merge');
  const resolution=f.engine.resolution, store=f.engine.store, original=store.tasks.bind(store);
  let scans=0;
  store.tasks=()=>{scans++;return original();};
  try{
   assert.equal(resolution.holdsIntegrationTurn(f.current(first.id)),true);
   assert.equal(resolution.holdsIntegrationTurn(f.current(second.id)),false);
   assert.equal(scans,0);
  }finally{store.tasks=original;}
  assert.deepEqual(store.integrationTasks(f.current(first.id).repoPath).map(task=>task.id).sort(),[first.id,second.id].sort());
  assert.deepEqual(store.integrationTasks('/elsewhere'),[]);
 }finally{await f.close()}
});

test('a removed task in a quantum does not fence another task in the same repository', async () => {
 const f=fixture();try{
  const first=f.add(),second=f.add();
  for (const task of [first, second]) {
   f.store.update(task.id, { phase: 'verifying' });
   f.engine.resolution.assignIntegrationTurn(f.current(task.id));
  }
  await f.engine.resolution.integrationQuantum(first.id, async () => {
   assert.equal(f.engine.resolution.claimIntegrationTurn(f.current(first.id)), true);
   f.store.update(first.id, { removedAt: new Date().toISOString() });
   assert.equal(f.engine.resolution.hasEarlierIntegrationTurn(f.current(second.id)), false);
   assert.equal(f.engine.resolution.holdsIntegrationTurn(f.current(second.id)), true);
  });
 }finally{await f.close()}
});

test('a terminal task a quantum makes active is named as the integration-turn holder', async () => {
 const f=fixture();try{
  const first=f.add(),second=f.add();
  for (const task of [first, second]) {
   f.store.update(task.id, { phase: 'verifying' });
   f.engine.resolution.assignIntegrationTurn(f.current(task.id));
  }
  await f.engine.resolution.integrationQuantum(first.id, async () => {
   assert.equal(f.engine.resolution.claimIntegrationTurn(f.current(first.id)), true);
   f.store.update(first.id, { phase: 'done' });
   assert.equal(f.store.integrationTasks(first.repoPath).some(task => task.id === first.id), false);
   assert.equal(f.engine.resolution.holdsIntegrationTurn(f.current(first.id)), true);
   assert.equal(f.engine.resolution.claimIntegrationTurn(f.current(second.id)), false);
   assert.match(f.current(second.id).reason, new RegExp(`${first.title} \\(${first.id}\\) holds it`));
  });
 }finally{await f.close()}
});

test('a closed-out task with a synchronized merge stops holding the turn while its quantum runs', async () => {
 // Live, 2026-11-05 (project-a-accelerator): a task that wrote closed_out kept the
 // turn for the ~90 s its thread and workspace archive still needed, so the next
 // verified task waited on a task that had already finished. Queue #705.
 const f=fixture();try{
  const first=f.add(),second=f.add();
  for (const task of [first, second]) {
   f.store.update(task.id, { phase: 'verifying' });
   f.engine.resolution.assignIntegrationTurn(f.current(task.id));
  }
  await f.engine.resolution.integrationQuantum(first.id, async () => {
   assert.equal(f.engine.resolution.claimIntegrationTurn(f.current(first.id)), true);
   f.store.update(first.id, { phase: 'done', resolution: { ...f.current(first.id).resolution, mergedCommit: merged, syncedCommit: merged } }, 'closed_out', 'fixture closeout');
   assert.equal(f.engine.resolution.integrationActive(f.current(first.id)), false, 'a closed-out synchronized task owes no integration');
   assert.equal(f.engine.resolution.hasEarlierIntegrationTurn(f.current(second.id)), false);
   assert.equal(f.engine.resolution.holdsIntegrationTurn(f.current(second.id)), true);
   assert.equal(f.engine.resolution.claimIntegrationTurn(f.current(second.id)), true, 'the next task takes the turn while the closed-out task is still in its quantum');
  });
 }finally{await f.close()}
});

test('a merge intent without a merged commit still holds the turn after closeout-shaped cleanup', async () => {
 const f=fixture();try{
  const first=f.add(),second=f.add();
  for (const task of [first, second]) {
   f.store.update(task.id, { phase: 'verifying' });
   f.engine.resolution.assignIntegrationTurn(f.current(task.id));
  }
  await f.engine.resolution.integrationQuantum(first.id, async () => {
   assert.equal(f.engine.resolution.claimIntegrationTurn(f.current(first.id)), true);
   f.store.update(first.id, { phase: 'merging', resolution: { ...f.current(first.id).resolution, mergeIntent: true, mergedCommit: null } });
   assert.equal(f.engine.resolution.holdsIntegrationTurn(f.current(first.id)), true, 'unknown merge delivery is not proof of a merge');
   assert.equal(f.engine.resolution.holdsIntegrationTurn(f.current(second.id)), false);
   assert.equal(f.engine.resolution.claimIntegrationTurn(f.current(second.id)), false);
   assert.match(f.current(second.id).reason, new RegExp(`${first.title} \\(${first.id}\\) holds it`));
  });
 }finally{await f.close()}
});

test('a merged but unsynchronized task still holds the turn', async () => {
 const f=fixture();try{
  const first=f.add(),second=f.add();
  for (const task of [first, second]) {
   f.store.update(task.id, { phase: 'verifying' });
   f.engine.resolution.assignIntegrationTurn(f.current(task.id));
  }
  await f.engine.resolution.integrationQuantum(first.id, async () => {
   assert.equal(f.engine.resolution.claimIntegrationTurn(f.current(first.id)), true);
   f.store.update(first.id, { phase: 'syncing', resolution: { ...f.current(first.id).resolution, mergeIntent: true, mergedCommit: merged, syncedCommit: null } });
   assert.equal(f.engine.resolution.holdsIntegrationTurn(f.current(first.id)), true, 'an unsynchronized merge still owns the turn');
   assert.equal(f.engine.resolution.holdsIntegrationTurn(f.current(second.id)), false);
   assert.equal(f.engine.resolution.claimIntegrationTurn(f.current(second.id)), false);
  });
 }finally{await f.close()}
});

test('a released closeout hands the turn to the earliest waiting verification, in FIFO order', async () => {
 const f=fixture();try{
  const first=f.add(),second=f.add(),third=f.add();
  for (const task of [first, second, third]) {
   f.store.update(task.id, { phase: 'verifying' });
   f.engine.resolution.assignIntegrationTurn(f.current(task.id));
  }
  await f.engine.resolution.integrationQuantum(first.id, async () => {
   assert.equal(f.engine.resolution.claimIntegrationTurn(f.current(first.id)), true);
   f.store.update(first.id, { phase: 'done', resolution: { ...f.current(first.id).resolution, mergedCommit: merged, syncedCommit: merged } }, 'closed_out', 'fixture closeout');
   assert.equal(f.engine.resolution.holdsIntegrationTurn(f.current(second.id)), true);
   assert.equal(f.engine.resolution.holdsIntegrationTurn(f.current(third.id)), false, 'the later task keeps waiting for the earlier one');
   assert.equal(f.engine.resolution.claimIntegrationTurn(f.current(third.id)), false);
   assert.match(f.current(third.id).reason, new RegExp(`${second.title} \\(${second.id}\\) holds it`));
   assert.equal(f.engine.resolution.claimIntegrationTurn(f.current(second.id)), true);
  });
 }finally{await f.close()}
});

test('a closed-out task hands the turn to the next verification before its quantum ends', async () => {
 const f=fixture();let releaseArchive=()=>{};let closed:Promise<unknown>|undefined;
 try{
  const first=f.add(),second=f.add();
  await f.engine.wake();await f.report(first.id,'ready_to_merge');
  await f.engine.wake();await f.report(second.id,'ready_to_merge');
  assert.equal(f.current(first.id).phase,'closing');
  assert.equal(f.current(second.id).phase,'verifying');
  // Stand in for the thread and workspace archive that ran for ~90 s after
  // closeout on project-a-accelerator: it holds the task's quantum open.
  const archive=new Promise<void>(resolve=>{releaseArchive=resolve});
  const original=f.engine.resolution.integrationQuantum.bind(f.engine.resolution);
  (f.engine.resolution as any).integrationQuantum=async(id:string,work:()=>Promise<void>)=>{
   if(id!==first.id)return original(id,work);
   return original(id,async()=>{await work();if(f.current(first.id).phase==='done')await archive;});
  };
  closed=f.report(first.id,'closed');
  await waitFor(()=>f.current(first.id).phase==='done',undefined,'the first task closes out');
  const closedAt=Date.now();
  // No sweep: the released turn wakes the next verification itself, while the
  // closed-out task is still inside its quantum.
  await waitFor(()=>f.current(second.id).resolution.mergeIntent===true,undefined,'the next verification takes the turn');
  assert.ok(Date.now()-closedAt<5000,`closed_out to the next merge intent took ${Date.now()-closedAt} ms while cleanup was still running`);
  assert.equal(f.counts().merges,2);
 }finally{releaseArchive();await closed;await f.close()}
});

test('an integration-turn index populated inside a rolled-back transaction is not served afterwards', async () => {
 const f=fixture();try{
  const first=f.add();
  assert.deepEqual(f.store.integrationTasks(first.repoPath), []);
  assert.throws(() => f.store.transaction(() => {
   f.engine.resolution.assignIntegrationTurn(f.current(first.id));
   assert.equal(f.store.integrationTasks(first.repoPath).some(task => task.id === first.id), true);
   throw new Error('rollback');
  }), /rollback/);
  assert.equal(f.current(first.id).resolution.integrationTurn, null);
  assert.deepEqual(f.store.integrationTasks(first.repoPath), []);
 }finally{await f.close()}
});

test('a stale workspace recovery cannot strand an accepted review or let a later turn pass', async () => {
 const f=fixture();try {
  const first=f.add(),second=f.add();
  await f.engine.wake();
  f.engine.resolution.recovery.escalate(f.current(first.id),'Workspace creation was still running');
  const review=f.run(first.id); f.idle(review.agentId!,review.workspaceId);
  f.engine.resolution.complete({eventId:randomUUID(),taskId:first.id,runId:review.id,status:'ready_to_merge',summary:'Approved',head:review.head,reviewCommentId:1},f.tokens.get(review.id)!);
  // The callback did not schedule its task; only the existing periodic sweep runs.
  await f.engine.sweepOnce(); await f.engine.quiesce();
  await f.engine.sweepOnce(); await f.engine.quiesce();
  assert.equal(f.current(first.id).resolution.recovery?.status,'resolved');
  assert.equal(f.counts().merges,1,'the accepted review advances without an owner move');
  await f.report(second.id,'ready_to_merge');
  assert.ok(f.current(first.id).resolution.integrationTurn!.sequence < f.current(second.id).resolution.integrationTurn!.sequence);
  assert.equal(f.counts().merges,1,'the later task waits for the earlier integration turn');
 }finally{await f.close()}
});
