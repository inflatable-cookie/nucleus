import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,qualifiedThreadArchiveEffectKey} from '../core/store/store';
import {submissionSchema} from '../shared/contracts';
import {prerequisiteCannotComplete} from '../shared/wait-state';

const day=86400000;
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'ns-retention-')),path=join(dir,'queue.sqlite');let store=new Store(path);
 const input=(id:string,dependsOn:string[]=[])=>submissionSchema.parse({submissionId:id,title:id,repoPath:'/repo',planningCommit:'a'.repeat(40),handoffPath:'handoff.md',originAgentId:'origin',dependsOn});
 const add=(id:string,dependsOn:string[]=[])=>store.insert(input(id,dependsOn),'host','handoff','a'.repeat(40));
 return {dir,get store(){return store},input,add,reopen(){store.close();store=new Store(path)},close(){store.close();rmSync(dir,{recursive:true,force:true})}};
}
test('retention removes old finished history but preserves dependency and submission identity across restart',()=>{
 const f=fixture();try{
  const done=f.add('done'),child=f.add('child',[done.id]),cancel=f.add('cancel'),blocked=f.add('blocked'),removed=f.add('removed');
  f.store.update(done.id,{phase:'done',runId:'worker-run'});f.store.update(cancel.id,{phase:'cancelled'});f.store.update(blocked.id,{phase:'blocked'});f.store.update(removed.id,{removedAt:new Date().toISOString()});
  f.store.setCredential('worker-run','secret');
  f.store.db.prepare('INSERT INTO receipts(id,task,run,hash,response,report_hash) VALUES(?,?,?,?,?,?)').run('event',done.id,'worker-run','hash','{}','report');
  f.store.update(done.id,{agentId:'purged-agent'});f.store.update(blocked.id,{agentId:'live-agent'});
  f.store.setMeta(qualifiedThreadArchiveEffectKey('host','purged-agent'),{status:'archived'});f.store.setMeta(qualifiedThreadArchiveEffectKey('host','live-agent'),{status:'archived'});
  const probe=qualifiedThreadArchiveEffectKey('host','purged-agent').replace('threadArchiveQualified:','threadArchiveQualifiedProbe:');f.store.setMeta(probe,'waiting');f.store.setMeta('reviewPublication:worker-run',{id:1});
  f.store.setMeta(`workspaceTitle:${done.id}`,{desired:'Done: done',confirmed:'Done: done',requestId:'title',intent:false,error:''});
  const cleaned:string[]=[];
  assert.deepEqual(new Set(f.store.purgeOldTasks(Date.now()+15*day,id=>cleaned.push(id))),new Set([done.id,cancel.id,removed.id]));
  assert.equal(cleaned.length,3);assert.equal(f.store.events(done.id).length,0);assert.equal(f.store.db.prepare('SELECT * FROM receipts').all().length,0);
  assert.equal(f.store.getMeta(qualifiedThreadArchiveEffectKey('host','purged-agent')),undefined);assert.equal(f.store.getMeta(probe),undefined);assert.ok(f.store.getMeta(qualifiedThreadArchiveEffectKey('host','live-agent')));assert.equal(f.store.getMeta('reviewPublication:worker-run'),undefined);assert.equal(f.store.getMeta(`workspaceTitle:${done.id}`),undefined);assert.throws(()=>f.store.authenticate('worker-run','secret'),/Unauthorized/);
  f.reopen();assert.equal(f.store.dependencyWait(child),'');assert.ok(f.store.taskReference(done.id).purgedAt);assert.throws(()=>f.store.task(done.id),/purged/);assert.throws(()=>f.store.existing(f.input('done')),/not be dispatched again/);
  assert.equal(f.store.task(blocked.id).phase,'blocked');assert.ok(f.add('new-dependent',[done.id]));assert.throws(()=>f.add('removed-dependent',[removed.id]),/removed before completion/);
 }finally{f.close()}
});
test('retention ages completion, preserves unfinished cleanup and unsettled runs/notices',()=>{
 const f=fixture();try{
  const recent=f.add('recent'),cleanup=f.add('cleanup'),lease=f.add('lease'),notice=f.add('notice'),uncertain=f.add('uncertain'),legacy=f.add('legacy');
  f.store.update(recent.id,{phase:'done'});
  f.store.update(cleanup.id,{phase:'done',workspaceId:'workspace'});f.store.update(lease.id,{phase:'done'});f.store.update(notice.id,{phase:'cancelled'});f.store.update(uncertain.id,{phase:'cancelled'});f.store.update(legacy.id,{phase:'done'});
  const old=new Date(Date.now()-15*day).toISOString();
  for(const task of [cleanup,lease,notice,uncertain])f.store.db.prepare("UPDATE tasks SET data=json_set(data,'$.finishedAt',?) WHERE id=?").run(old,task.id);
  f.store.db.prepare("UPDATE tasks SET data=json_set(data,'$.createdAt',?) WHERE id=?").run(old,recent.id);
  f.store.db.prepare("UPDATE tasks SET data=json_remove(data,'$.finishedAt') WHERE id=?").run(legacy.id);f.store.event(legacy.id,'closed_out','Closed');f.store.db.prepare("UPDATE events SET at=? WHERE taskId=? AND kind='closed_out'").run(old,legacy.id);
  f.store.db.prepare('INSERT INTO runs VALUES(?,?,?)').run('lease',lease.id,JSON.stringify({id:'lease',released:false}));
  const storedNotice=(id:string,taskId:string,status:'pending'|'uncertain')=>({id,taskId,agentId:'origin',text:'notice',status,error:''});
  f.store.db.prepare('INSERT INTO notices VALUES(?,?,?)').run('notice',notice.id,JSON.stringify(storedNotice('notice',notice.id,'pending')));
  f.store.db.prepare('INSERT INTO notices VALUES(?,?,?)').run('uncertain',uncertain.id,JSON.stringify(storedNotice('uncertain',uncertain.id,'uncertain')));
  assert.deepEqual(f.store.purgeOldTasks(),[legacy.id]);
  assert.equal(f.store.task(recent.id).phase,'done');assert.equal(f.store.task(cleanup.id).workspaceId,'workspace');assert.equal(f.store.task(lease.id).phase,'done');assert.equal(f.store.task(notice.id).phase,'cancelled');assert.equal(f.store.task(uncertain.id).phase,'cancelled');
 }finally{f.close()}
});
test('a goal-unmet done task stays unmet through the retention purge (moved from the retired stage-engine suite)',()=>{
 // Declared-stage execution is gone, so no code writes resolution.goalUnmet any
 // more; the store and dependency gate still read it, including from the
 // retention tombstone, so a historical unmet goal never becomes ordinary done.
 const f=fixture();try{
  const source=f.add('goal-unmet-source');
  const goalUnmet='Goal verdict spec is insufficient, not pass';
  f.store.update(source.id,{
    phase:'done',workspaceId:null,
    resolution:{...f.store.task(source.id).resolution,goalUnmet},
  },'closed_out','goal unmet');
  // update stamps finishedAt to now; move it into the past directly so the task
  // falls outside retention with removedAt still null, as an ordinary done task does.
  const old=new Date(Date.now()-20*day).toISOString();
  f.store.db.prepare("UPDATE tasks SET data=json_set(data,'$.finishedAt',?) WHERE id=?").run(old,source.id);
  // Retain the task: the live row is gone, only the tombstone remains.
  assert.deepEqual(f.store.purgeOldTasks(Date.now()),[source.id]);
  assert.throws(()=>f.store.task(source.id),/purged/);
  assert.equal(f.store.taskReference(source.id).phase,'done');
  // A dependent created after the purge still sees the unmet goal, not an ordinary done.
  const dependent=f.add('goal-unmet-dependent',[source.id]);
  const reason=f.store.dependencyWait(f.store.task(dependent.id));
  assert.match(reason,/goal unmet/,`expected a durable goal-unmet wait, got ${reason}`);
  assert.equal(prerequisiteCannotComplete(reason),true);
 }finally{f.close()}
});
test('reporting-file purge preserves a retained binding reassigned to another task',async()=>{
 const {PaseoAdapter}=await import('../service/paseo-composition');const f=fixture();try{
  mkdirSync(join(f.dir,'tickets'));const owned=join(f.dir,'tickets','run.json'),shared=join(f.dir,'tickets','mcp-run.json');
  writeFileSync(owned,JSON.stringify({taskId:'old'}));writeFileSync(shared,JSON.stringify({taskId:'new'}));
  const adapter=Object.create(PaseoAdapter.prototype) as InstanceType<typeof PaseoAdapter>;Object.defineProperty(adapter,'helperPath',{value:join(f.dir,'worker-report.mjs')});
  adapter.purgeReportingFiles('old',['run']);assert.equal(existsSync(owned),false);assert.equal(existsSync(shared),true);
 }finally{f.close()}
});

test('finished task history is kept 4 days, then purged (Tom, 2026-10-20: "4 days for queue")',()=>{
  const f=fixture();try{
    const recent=f.add('recent-done'),aged=f.add('aged-done');
    for(const task of [recent,aged])f.store.update(task.id,{phase:'done'});
    const at=(days:number)=>new Date(Date.now()-days*day).toISOString();
    f.store.db.prepare("UPDATE tasks SET data=json_set(data,'$.finishedAt',?) WHERE id=?").run(at(3),recent.id);
    f.store.db.prepare("UPDATE tasks SET data=json_set(data,'$.finishedAt',?) WHERE id=?").run(at(5),aged.id);
    const purged=f.store.purgeOldTasks(Date.now());
    assert.ok(purged.includes(aged.id),'five days old is purged');
    assert.ok(!purged.includes(recent.id),'three days old is kept');
  }finally{f.close();}
});
