import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CURRENT_SCHEMA,Store} from '../core/store/store';
import {submissionSchema,type Run} from '../shared/contracts';

const add=(s:Store,id:string,host='host')=>s.insert(submissionSchema.parse({submissionId:id,title:id,repoPath:'/fixture',planningCommit:'a'.repeat(40),handoffPath:`${id}.md`,originAgentId:'origin'}),host,'h'.repeat(12000),'a'.repeat(40));
const run=(taskId:string):Run=>({id:'run',taskId,role:'reviewer',generation:1,head:'a'.repeat(40),base:'b'.repeat(40),agentId:'run-agent',workspaceId:'run-workspace',profile:null,status:'superseded',released:true,createdAt:new Date().toISOString(),lastObservedAt:null,active:false,idleSince:null,completion:null});

test('equal native identities on different hosts require proven context',()=>{
 const s=new Store(':memory:');try{
  const a=add(s,'a','host-a'), b=add(s,'b','host-b');
  s.update(a.id,{agentId:'same'});
  s.update(b.id,{agentId:'same'});
  assert.deepEqual(s.taskIdsForIdentities({agentId:'same'}),[]);
  assert.deepEqual(s.taskIdsForIdentities({agentId:'same',hostId:'host-a'}),[a.id]);
  assert.deepEqual(s.taskIdsForIdentities({agentId:'same',hostId:'host-b'}),[b.id]);
 }finally{s.close();}
});

test('indexed lifecycle identities retain every role, terminal history and exact deduplication',()=>{
 const s=new Store(':memory:');try{
  const t=add(s,'task');
  const retired={agentId:'retired',runId:'retired-run',reason:'replaced',profile:{id:'profile',name:'profile',provider:'test',model:'test',notes:'',available:true,problem:'',supportedThinking:[]}};
  s.update(t.id,{phase:'done',agentId:'worker',coordinatorAgentId:'coordinator',workspaceId:'worker-workspace',retiredWorkers:[retired],resolution:{...t.resolution,reviewerAgentId:'reviewer',coordinatorWorkspaceId:'coordinator-workspace',closeoutWorkspaceId:'closeout-workspace'}});
  s.putRun(run(t.id));
  for(const agentId of ['worker','coordinator','reviewer','retired','run-agent'])assert.deepEqual(s.taskIdsForIdentities({agentId}),[t.id]);
  for(const workspaceId of ['worker-workspace','coordinator-workspace','closeout-workspace','run-workspace'])assert.deepEqual(s.taskIdsForIdentities({workspaceId}),[t.id]);
  assert.deepEqual(s.taskIdsForIdentities({agentId:'worker',workspaceId:'run-workspace'}),[t.id]);
  assert.deepEqual(s.taskIdsForIdentities({agentId:'unknown',workspaceId:'unknown'}),[]);
  assert.deepEqual(s.taskIdsForIdentities({agentId:'',workspaceId:null}),[]);
  s.update(t.id,{phase:'cancelled',agentId:null});
  assert.deepEqual(s.taskIdsForIdentities({agentId:'retired'}),[t.id]);
  assert.deepEqual(s.taskIdsForIdentities({agentId:'worker'}),[]);
  s.update(t.id,{removedAt:new Date().toISOString()});
  for(const agentId of ['coordinator','reviewer','retired','run-agent'])assert.deepEqual(s.taskIdsForIdentities({agentId}),[]);
  assert.deepEqual(s.taskIdsForIdentities({workspaceId:'run-workspace'}),[]);
 }finally{s.close();}
});

test('identity index updates and rollback are visible immediately',()=>{
 const s=new Store(':memory:');try{
  const t=add(s,'task');s.update(t.id,{agentId:'old'});s.putRun(run(t.id));
  assert.throws(()=>s.transaction(()=>{
   s.update(t.id,{agentId:'new'});s.putRun({...run(t.id),agentId:'new-run',workspaceId:'new-workspace'});
   assert.deepEqual(s.taskIdsForIdentities({agentId:'old'}),[]);
   assert.deepEqual(s.taskIdsForIdentities({agentId:'new'}),[t.id]);
   assert.deepEqual(s.taskIdsForIdentities({workspaceId:'new-workspace'}),[t.id]);
   throw Error('rollback');
  }),/rollback/);
  assert.deepEqual(s.taskIdsForIdentities({agentId:'old'}),[t.id]);
  assert.deepEqual(s.taskIdsForIdentities({agentId:'new-run',workspaceId:'new-workspace'}),[]);
  assert.deepEqual(s.taskIdsForIdentities({agentId:'run-agent'}),[t.id]);
 }finally{s.close();}
});

test('identity indexes install on existing schema 12 and query plans use exact searches',()=>{
 const dir=mkdtempSync(join(tmpdir(),'queue-identities-'));let s=new Store(join(dir,'queue.db'));
 try{
  const t=add(s,'task');s.update(t.id,{agentId:'agent'});s.putRun(run(t.id));
  const before=s.task(t.id);
  for(const row of s.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%identity%'").all())s.db.exec(`DROP INDEX ${row.name}`);
  s.close();s=new Store(join(dir,'queue.db'));
  assert.equal(s.getMeta('schema'), CURRENT_SCHEMA);assert.deepEqual(s.task(t.id),before);
  const plans:string[]=[];const prepare=s.db.prepare.bind(s.db);
  s.db.prepare=((sql:string)=>{
   if(sql.startsWith('SELECT id FROM tasks WHERE rowid IN')||sql.startsWith('SELECT r.taskId')){
    const params=Array(sql.split('?').length-1).fill('agent');
    plans.push(JSON.stringify(prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params)));
   }
   return prepare(sql);
  }) as typeof s.db.prepare;
  assert.deepEqual(s.taskIdsForIdentities({agentId:'agent',workspaceId:'unknown'}),[t.id]);
  const plan=plans.join('\n');
  for(const name of ['agent','coordinator','reviewer','workspace','coordinator_workspace','closeout_workspace'])assert.match(plan,new RegExp(`SEARCH tasks USING INDEX tasks_identity_${name}`));
  for(const name of ['agent','workspace'])assert.match(plan,new RegExp(`SEARCH r USING COVERING INDEX runs_identity_${name}_host`));
  assert.match(plan,/SCAN tasks USING INDEX tasks_retired_identity/);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

// Pre-index query shape, retained only as the comparison oracle.
function legacyLookup(s: Store, input: { agentId?: string | null; workspaceId?: string | null }): string[] {
    const ids = new Set<string>();
    const agentId = input.agentId ?? "";
    const workspaceId = input.workspaceId ?? "";
    if (agentId) {
      for (const row of s.db.prepare(`SELECT id FROM tasks WHERE json_extract(data,'$.removedAt') IS NULL AND (
        json_extract(data,'$.agentId')=? OR json_extract(data,'$.coordinatorAgentId')=? OR json_extract(data,'$.resolution.reviewerAgentId')=?
        OR EXISTS (SELECT 1 FROM json_each(json_extract(data,'$.retiredWorkers')) WHERE json_extract(value,'$.agentId')=?)
      )`).all(agentId, agentId, agentId, agentId)) ids.add(String(row.id));
      for (const row of s.db.prepare(`SELECT r.taskId AS taskId FROM runs r JOIN tasks t ON t.id=r.taskId
        WHERE json_extract(t.data,'$.removedAt') IS NULL AND json_extract(r.data,'$.agentId')=?`).all(agentId)) ids.add(String(row.taskId));
    }
    if (workspaceId) {
      for (const row of s.db.prepare(`SELECT id FROM tasks WHERE json_extract(data,'$.removedAt') IS NULL AND (
        json_extract(data,'$.workspaceId')=? OR json_extract(data,'$.resolution.coordinatorWorkspaceId')=? OR json_extract(data,'$.resolution.closeoutWorkspaceId')=?
      )`).all(workspaceId, workspaceId, workspaceId)) ids.add(String(row.id));
      for (const row of s.db.prepare(`SELECT r.taskId AS taskId FROM runs r JOIN tasks t ON t.id=r.taskId
        WHERE json_extract(t.data,'$.removedAt') IS NULL AND json_extract(r.data,'$.workspaceId')=?`).all(workspaceId)) ids.add(String(row.taskId));
    }
    return [...ids];
  }

test('identity reads reduce history work with measured write overhead',t=>{
 const dir=mkdtempSync(join(tmpdir(),'queue-identity-perf-'));const path=join(dir,'queue.db');let s=new Store(path);
 try{
  const seed=add(s,'seed');const insert=s.db.prepare('INSERT INTO tasks VALUES(?,?,?,?)');
  s.transaction(()=>{for(let i=0;i<4;i++){
   const task={...seed,id:`task-${i}`,submissionId:`task-${i}`,phase:i<3?'done':'working',agentId:`agent-${i}`,workspaceId:`ws-${i}`,retiredWorkers:i%100?[]:[{agentId:`retired-${i}`}],completion:{summary:'s'}};
   insert.run(task.id,task.submissionId,'fixture',JSON.stringify(task));
   s.putRun({...run(task.id),id:`run-${i}`,agentId:`run-agent-${i}`,workspaceId:`run-ws-${i}`});
  }});
  const indexes=s.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%identity%'").all();
  for(const row of indexes)s.db.exec(`DROP INDEX ${row.name}`);
  const cases=[{agentId:'unknown',workspaceId:'unknown'},{agentId:'retired-0',workspaceId:'ws-0'},{agentId:'run-agent-1',workspaceId:'run-ws-1'},{agentId:'agent-3',workspaceId:'ws-3'}];
  const expected=cases.map(input=>legacyLookup(s,input));
  const reads=(lookup:(input:typeof cases[number])=>string[])=>{const start=performance.now();for(let i=0;i<4;i++)assert.deepEqual(lookup(cases[i%4]),expected[i%4]);return performance.now()-start;};
  let writePass=0;
  const writes=()=>{const stmt=s.db.prepare('UPDATE tasks SET data=? WHERE id=?');const rows=s.db.prepare('SELECT id,data FROM tasks LIMIT 4').all();writePass++;const start=performance.now();s.transaction(()=>{for(const row of rows)stmt.run(JSON.stringify({...JSON.parse(String(row.data)),reason:`update-${writePass}`}),row.id);});return performance.now()-start;};
  const beforeReadMs=reads(input=>legacyLookup(s,input)),beforeWriteMs=writes();
  s.close();const openStart=performance.now();s=new Store(path);const indexOpenMs=performance.now()-openStart;
  const afterReadMs=reads(input=>s.taskIdsForIdentities(input)),afterWriteMs=writes();
  t.diagnostic(JSON.stringify({tasks:5,runs:4,reads:4,writes:4,beforeReadMs,afterReadMs,beforeWriteMs,afterWriteMs,indexOpenMs}));
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
