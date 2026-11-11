import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store, digest, qualifiedThreadArchiveEffectKey} from '../core/store/store';
import {Reports} from '../core/intake/report';
import {submissionSchema} from '../shared/contracts';
import type {Engine} from '../core/engine';

function setup() {
  const dir=mkdtempSync(join(tmpdir(),'lean-store-')), path=join(dir,'db.sqlite');
  const store=new Store(path);
  const task=store.insert(submissionSchema.parse({submissionId:'task',title:'Task',repoPath:'/repo',planningCommit:'a'.repeat(40),handoffPath:'handoff',originAgentId:'origin'}),'host','brief','a'.repeat(40));
  store.update(task.id,{phase:'working',runId:'run',agentId:'worker'});store.setCredential('run','token');
  return {dir,path,store,task};
}

test('schema migration preserves live archive state and report intents',()=>{
 const f=setup();
 f.store.setMeta('hostId','host');f.store.setMeta('hostRegistry',[{id:'host',endpoint:'fixture'}]);
 f.store.setMeta('threadArchive:worker',{status:'archived',at:'then'});f.store.setMeta('threadArchive:orphan',{status:'archived'});
 f.store.setMeta('mcpReportIntent:event',{hash:'report-hash',taskId:f.task.id});
 f.store.setMeta('mcpReport:event',{hash:'report-hash',response:{accepted:true,eventId:'event'}});
 f.store.setMeta('mcpReportIntent:pending',{hash:'pending-hash',taskId:f.task.id});
 f.store.setMeta('schema',52);f.store.close();
 const store=new Store(f.path,join(f.dir,'backups'));
 try {
  assert.deepEqual(store.getMeta(qualifiedThreadArchiveEffectKey('host','worker')),{status:'archived',at:'then'});
  assert.equal(store.getMeta('threadArchive:orphan'),undefined);assert.equal(store.getMeta('hostId'),undefined);
  assert.equal(store.db.prepare("SELECT report_hash FROM receipts WHERE id='pending'").get()?.report_hash,'pending-hash');
  assert.equal(store.db.prepare("SELECT report_response FROM receipts WHERE id='event'").get()?.report_response,JSON.stringify({hash:'report-hash',response:{accepted:true,eventId:'event'}}));
  assert.equal(store.getMeta('mcpReportIntent:pending'),undefined);
 } finally {store.close();}
});

test('report repeats, unfinished intent and restart after completion preserve idempotency',async()=>{
 const f=setup();let calls=0;
 const input={taskId:f.task.id,runId:'run',eventId:'event',status:'blocked' as const,summary:'Blocked'};
 const engine={store:f.store,complete:async()=>{calls++;throw Error('interrupted')}} as unknown as Engine;
 await assert.rejects(new Reports(engine).report(input,'token'),/interrupted/);
 await assert.rejects(new Reports(engine).report({...input,summary:'different'},'token'),/Report event ID conflict/);
 f.store.close();const store=new Store(f.path);
 try {
  const response={accepted:true,eventId:'event'};
  const engine2={store,complete:async()=>{calls++;store.db.prepare("UPDATE receipts SET hash=?,response=? WHERE id=?").run('completion-hash',JSON.stringify(response),'event');return response}} as unknown as Engine;
  assert.deepEqual(await new Reports(engine2).report(input,'token'),response);
  assert.deepEqual(await new Reports(engine2).report(input,'token'),response);assert.equal(calls,2);
  store.db.prepare("UPDATE receipts SET report_response=NULL WHERE id='event'").run();
  assert.deepEqual(await new Reports(engine2).report(input,'token'),response);assert.equal(calls,2);
  assert.equal(store.db.prepare("SELECT report_hash FROM receipts WHERE id='event'").get()?.report_hash,digest(JSON.stringify(input)));
 } finally {store.close();}
});

test('migration preserves distinct intent and stored report conflict checks',async()=>{
 const f=setup();const input={taskId:f.task.id,runId:'run',eventId:'conflict',status:'blocked' as const,summary:'Blocked'};
 f.store.setMeta('mcpReportIntent:conflict',{hash:digest(JSON.stringify(input)),taskId:f.task.id});
 f.store.setMeta('mcpReport:conflict',{hash:'different',response:{accepted:true,eventId:'conflict'}});
 f.store.setMeta('schema',52);f.store.close();const store=new Store(f.path,join(f.dir,'backups'));
 try { await assert.rejects(new Reports({store} as Engine).report(input,'token'),/Report event ID conflict/); }
 finally {store.close();}
});

test('a legacy host without a registry keeps its identity until an endpoint is authenticated',async()=>{
 const f=setup();f.store.setMeta('hostId','host');f.store.setMeta('schema',52);f.store.close();
 const store=new Store(f.path,join(f.dir,'backups'));
 try {
  const {HostRegistry}=await import('../core/host/host-registry');
  const registry=new HostRegistry({read:()=>store.getMeta<{id:string;endpoint:string}[]>('hostRegistry') ?? [],write:hosts=>store.setMeta('hostRegistry',hosts),transaction:fn=>store.transaction(fn)});
  assert.deepEqual(registry.known(),[{id:'host',endpoint:''}]);
  registry.connect('host','endpoint',{});assert.deepEqual(registry.known(),[{id:'host',endpoint:'endpoint'}]);
 } finally {store.close();}
});
