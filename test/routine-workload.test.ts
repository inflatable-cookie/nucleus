import {test} from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {Store} from '../core/store/store';
import {submissionSchema} from '../shared/contracts';
import {createUiSnapshotFactsCache} from '../core/telemetry/ui-snapshot';
import {Admission} from '../core/host/admission';
import {capacityFor} from '../core/engine';
import {buildTelemetryBase} from '../core/telemetry/telemetry';

const add=(store:Store,id:string,initial:Parameters<Store['insert']>[4]={})=>store.insert(submissionSchema.parse({submissionId:id,title:id,repoPath:'/fixture',planningCommit:'a'.repeat(40),handoffPath:`${id}.md`,originAgentId:'origin'}),'host','handoff','a'.repeat(40),initial);

test('routine projections exclude settled history and preserve terminal obligations',()=>{
 const store=new Store(':memory:');
 try{
  const live=add(store,'live',{phase:'working',agentIntent:true,agentId:'agent-live',agentActive:true}),done=add(store,'done',{phase:'done',originWorkspaceId:'remembered'}),cancelled=add(store,'cancelled',{phase:'cancelled'});
  const cleanup=add(store,'cleanup',{phase:'done',workspaceId:'workspace'});
  const recovery=add(store,'recovery',{phase:'done'});store.update(recovery.id,{resolution:{...recovery.resolution,recoveryActive:true}});
  const notify=add(store,'notify',{notifyOriginOnCloseout:true,originWorkspaceId:'notify-workspace'});store.update(notify.id,{phase:'done'});
  assert.deepEqual(store.liveTasks().map(t=>t.id),[live.id]);
  assert.deepEqual(new Set(store.lifecycleTasks().map(t=>t.id)),new Set([live.id,cleanup.id]));
  assert.deepEqual(new Set(store.originRoutingTasks().map(t=>t.id)),new Set([live.id,notify.id]));
  assert.equal(store.originWorkspaces().get('origin'),'notify-workspace');
  assert.equal(store.pendingNotices().length,1);
  store.putNotice({...store.pendingNotices()[0],status:'delivered'});
  assert.equal(store.originRoutingTasks().some(t=>t.id===notify.id),false);
  store.update(cleanup.id,{resolution:{...cleanup.resolution,archivedWorkspaceIds:['workspace']}});
  assert.deepEqual(store.lifecycleTasks().map(t=>t.id),[live.id]);
  // PR 824 (task 578): terminal tasks never hold a slot, so the refusal needs an
 // in-flight occupant — the working task itself holds the only slot.
 assert.equal(capacityFor(live,store.admissionCandidates(),1),'Global concurrent task-slot limit reached');
  assert.equal(store.admissionCandidates().some(t=>t.id===done.id||t.id===cancelled.id),false);
  store.update(cancelled.id,{reason:'No eligible coordinator',resolution:{...cancelled.resolution,roleReplacements:1}});
  assert.equal(store.maintenanceTasks().some(t=>t.id===cancelled.id),true,'terminal attention remains owned');
 }finally{store.close();}
});

test('health count is cached across unrelated writes and remains correct after rollback',()=>{
 const store=new Store(':memory:');
 try{
  const task=add(store,'one');let scans=0;const prepare=store.db.prepare.bind(store.db);
  store.db.prepare=((sql:string)=>{if(sql.includes('COUNT(*) AS n FROM tasks'))scans++;return prepare(sql);}) as typeof store.db.prepare;
  assert.equal(store.countTasks(),1);store.event(task.id,'fixture','history');assert.equal(store.countTasks(),1);assert.equal(scans,1);
  assert.throws(()=>store.transaction(()=>{store.update(task.id,{removedAt:new Date().toISOString()});assert.equal(store.countTasks(),0);throw Error('rollback');}),/rollback/);
  assert.equal(store.countTasks(),1);
  const two=add(store,'two');assert.equal(store.countTasks(),2);store.update(two.id,{removedAt:new Date().toISOString()});assert.equal(store.countTasks(),1);
 }finally{store.close();}
});

test('history-heavy fixture bounds routine materialization and board rebuilds',async t=>{
 const store=new Store(':memory:');
 try{
  for(let i=0;i<2;i++)add(store,`history-${i}`,{phase:'done'});
  for(let i=0;i<2;i++)add(store,`live-${i}`);
  const timed=<T>(read:()=>T)=>{const start=performance.now();const result=read();return{result,ms:performance.now()-start};};
  const all=timed(()=>store.tasks()),live=timed(()=>store.liveTasks());
  assert.equal(all.result.length,4);assert.equal(live.result.length,2);
  assert.equal(store.lifecycleTasks().length,2);assert.equal(store.originRoutingTasks().length,2);assert.equal(store.maintenanceTasks().length,2);
  let rebuilds=0;const ui=store.boardTasks.bind(store);store.boardTasks=limit=>{rebuilds++;return ui(limit);};
  const read=createUiSnapshotFactsCache(store);const initial=read();const revision=store.telemetryRevision();
  for(let i=0;i<2;i++){store.event(all.result.at(-1)!.id,'history_only','fixture');assert.strictEqual(read(),initial);}
  assert.ok(store.telemetryRevision()>revision);assert.equal(rebuilds,1);
  store.update(live.result[0].id,{reason:'visible change'});assert.notStrictEqual(read(),initial);assert.equal(rebuilds,2);
  store.advanceRevision();assert.notStrictEqual(read(),initial);assert.equal(rebuilds,3);
  const coldStart=performance.now();const telemetry=await buildTelemetryBase(store);const coldTelemetryMs=performance.now()-coldStart;assert.equal(telemetry.items.length,4);
  t.diagnostic(JSON.stringify({retained:4,live:2,fullTaskReadMs:all.ms,liveTaskReadMs:live.ms,coldTelemetryMs,boardRebuilds:rebuilds,historyEvents:2,oldestQueuedAt:live.result.at(-1)!.createdAt}));
 }finally{store.close();}
});

test('workspace lifecycle invalidates the positive availability cache',async()=>{
 const admission=new Admission();let calls=0;
 const lookup=async()=>{calls++;return calls===1;};
 assert.equal(await admission.observeWorkspace('workspace',lookup),true);
 assert.equal(await admission.observeWorkspace('workspace',lookup),true);assert.equal(calls,1);
 admission.noteLifecycleSignal({workspaceId:'workspace'});
 assert.equal(await admission.observeWorkspace('workspace',lookup),false);assert.equal(calls,2);
});

test('a signal during a workspace read prevents stale cache repopulation',async()=>{
 const admission=new Admission();let release!:(value:boolean)=>void;
 const pending=admission.observeWorkspace('workspace',()=>new Promise<boolean>(resolve=>{release=resolve;}));
 while(!release)await new Promise(resolve=>setImmediate(resolve));
 admission.noteLifecycleSignal({workspaceId:'workspace'});release(true);await pending;
 let calls=0;assert.equal(await admission.observeWorkspace('workspace',async()=>{calls++;return false;}),false);assert.equal(calls,1);
});

test('pending run reads preserve all lease candidates without parsing settled evidence', t=>{
 const store=new Store(':memory:');
 try{
  const live=add(store,'run-live'),terminal=add(store,'run-terminal',{phase:'done'}),removed=add(store,'run-removed',{removedAt:new Date().toISOString()});
  const insert=store.db.prepare('INSERT INTO runs VALUES(?,?,?)');
  for(let i=0;i<6;i++){
   const taskId=i===5?removed.id:i%2?live.id:terminal.id;
   const run={id:`run-${i}`,taskId,role:i%5===0?'recovery':'reviewer',generation:1,head:'a'.repeat(40),base:'b'.repeat(40),agentId:`agent-${i}`,workspaceId:'workspace',profile:null,status:i%2===0?'superseded':'finished',createdAt:new Date().toISOString(),lastObservedAt:null,active:false,idleSince:null,completion:{summary:'evidence'},released:i!==0};
   insert.run(run.id,taskId,JSON.stringify(run));
  }
  let start=performance.now();const all=store.runs();const allMs=performance.now()-start;
  const expected=all.filter(r=>!r.released||r.status==='superseded');
  start=performance.now();const candidates=store.pendingRuns();const pendingMs=performance.now()-start;
  assert.deepEqual(candidates,expected,'same candidates and row order, including terminal and recovery leases');
  assert.ok(candidates.some(r=>r.taskId===terminal.id&&!r.released));
  assert.ok(candidates.some(r=>r.released&&r.status==='superseded'));
  assert.ok(candidates.length<40);assert.equal(all.length,5);
  store.db.prepare("UPDATE runs SET data=json_set(data,'$.released',0) WHERE id='run-1'").run();
  assert.ok(store.pendingRuns().some(r=>r.id==='run-1'),'lease changes are read fresh');
  t.diagnostic(JSON.stringify({retainedRuns:all.length,candidates:candidates.length,allMs,pendingMs}));
 }finally{store.close();}
});

/**
 * Task 434 (performance audit 2026-10-25, item A9): the origin pass used to read
 * its two task sets with full SQL scans over every stored task. Both are now
 * filters over the in-memory projection, with the one notice fact the projection
 * cannot answer read per finished candidate. The parent query is kept here so
 * the equivalence is proved against the shape that was replaced, not asserted.
 */
test('the origin pass reads its task sets from the projection, with the same members as the full scan', async t => {
 const store=new Store(':memory:');
 try{
  for(let i=0;i<2;i++)add(store,`history-${i}`,{phase:'done'});
  for(let i=0;i<2;i++)add(store,`live-${i}`,{originWorkspaceId:`ws-${i}`});
  const owing=add(store,'owing',{notifyOriginOnCloseout:true,originWorkspaceId:'ows'});store.update(owing.id,{phase:'done'});
  const settled=add(store,'settled',{notifyOriginOnCloseout:true,originWorkspaceId:'sws'});store.update(settled.id,{phase:'done'});
  store.putNotice({...store.pendingNotices().find(notice=>notice.taskId===settled.id)!,status:'delivered'});
  const cancelled=add(store,'cancelled-error',{phase:'cancelled'});store.update(cancelled.id,{originError:'Origin thread is missing'});
  const removed=add(store,'removed',{removedAt:new Date().toISOString(),originWorkspaceId:'gone'});
  // The origin identity is fixed at insert, so the operator task is inserted as one.
  const operator=store.insert(submissionSchema.parse({submissionId:'operator-origin',title:'Operator origin',repoPath:'/fixture',planningCommit:'a'.repeat(40),handoffPath:'operator.md',originAgentId:'operator'}),'host','handoff','a'.repeat(40),{originWorkspaceId:'ops'});

  const parentTasks=()=>store.db.prepare(`SELECT data FROM tasks WHERE json_extract(data,'$.removedAt') IS NULL AND (
    json_extract(data,'$.phase') NOT IN ('done','cancelled') OR (json_extract(data,'$.phase')='done'
      AND EXISTS (SELECT 1 FROM json_each(json_extract(data,'$.completionNotificationCohort')) WHERE json_extract(value,'$.originEntry')=1)
      AND NOT EXISTS (SELECT 1 FROM notices n WHERE n.taskId=tasks.id AND json_extract(n.data,'$.kind')='completion'
        AND json_extract(n.data,'$.originEntry')=1 AND json_extract(n.data,'$.status')='delivered'))
    OR (json_extract(data,'$.phase') IN ('done','cancelled') AND (COALESCE(json_extract(data,'$.originError'),'')<>'' OR COALESCE(json_extract(data,'$.originLookupError'),'')<>''))
    ) ORDER BY rowid DESC`).all().map(row=>JSON.parse(String(row.data)).id as string);
  const parentWorkspaces=()=>{const result=new Map<string,string>();
    for(const row of store.db.prepare("SELECT json_extract(data,'$.originAgentId') AS agent, json_extract(data,'$.originWorkspaceId') AS workspace FROM tasks WHERE json_extract(data,'$.removedAt') IS NULL AND json_extract(data,'$.originWorkspaceId') IS NOT NULL ORDER BY rowid DESC").all())
      if(row.workspace&&!String(row.agent).startsWith('operator')&&!result.has(String(row.agent)))result.set(String(row.agent),String(row.workspace));
    return result;};

  assert.equal(store.tasks().length,8,'the retained fixture is complete (one task is removed)');
  // Same members, same newest-first order.
  assert.deepEqual(store.originRoutingTasks().map(task=>task.id),parentTasks());
  assert.deepEqual([...store.originWorkspaces()],[...parentWorkspaces()]);
  assert.equal(store.originRoutingTasks().some(task=>task.id===settled.id),false,'a delivered origin notice settles the debt');
  assert.equal(store.originRoutingTasks().some(task=>task.id===cancelled.id),true,'a terminal origin error is still visited once');
  assert.equal(store.originWorkspaces().has('operator'),false,'an operator identity never seeds a workspace');
  assert.equal(store.originWorkspaces().get('origin'),'sws','the newest task of one origin thread wins');
  assert.equal(store.originWorkspaces().has('gone'),false,'a removed task seeds nothing');

  const timed=<T>(read:()=>T)=>{const start=performance.now();const result=read();return{result,ms:performance.now()-start};};
  // Warm the projection so both readers pay only their own read.
  store.tasks();
  const parentRouting=timed(parentTasks),childRouting=timed(()=>store.originRoutingTasks());
  const parentWorkspaceRead=timed(parentWorkspaces),childWorkspaceRead=timed(()=>store.originWorkspaces());
  assert.deepEqual(childRouting.result.map(task=>task.id),parentRouting.result);
  assert.deepEqual([...childWorkspaceRead.result],[...parentWorkspaceRead.result]);

  // The child read prepares no statement against the task table at all: only the
  // one notice read the finished task owing its origin needs.
  const prepared:string[]=[];const prepare=store.db.prepare.bind(store.db);
  store.db.prepare=((sql:string)=>{prepared.push(sql);return prepare(sql);}) as typeof store.db.prepare;
  const routing=store.originRoutingTasks();
  store.db.prepare=prepare;
  assert.deepEqual(prepared.filter(sql=>/FROM tasks/i.test(sql)),[],'the routing read prepares no task scan');
  const noticeReads=prepared.filter(sql=>/FROM notices/i.test(sql)).length;
  const owingFinished=store.tasks().filter(task=>task.phase==='done'&&task.completionNotificationCohort?.some(member=>member.originEntry)).length;
  assert.equal(owingFinished,2,'the fixture has one finished task that owes and one already settled');
  assert.equal(noticeReads,owingFinished,'one notice read per finished task that owes its origin, and none for stored history');
  t.diagnostic(JSON.stringify({retained:9,live:2,parentRoutingMs:parentRouting.ms,childRoutingMs:childRouting.ms,
    parentWorkspaceMs:parentWorkspaceRead.ms,childWorkspaceMs:childWorkspaceRead.ms,noticeReads,owingFinished}));
 }finally{store.close();}
});
