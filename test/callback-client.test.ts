import { observeIdle } from './support/fakes';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {workerHelper} from '../service/callbacks/callback';
import {Store} from '../core/store/store';
import {Engine} from '../core/engine';
import {completionSchema, submissionSchema} from '../shared/contracts';
import {createHash} from 'node:crypto';
import {startCallbacks} from '../service/callbacks/callback';
import type {Adapter} from '../core/host';

test('shared callback transport rejects malformed responses and timeouts without replay',async()=>{
 const {callbackRequest}=await import(new URL('../shared/service/callback-client.mjs',import.meta.url).href);
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'ns-callback-'))),socketPath=join(dir,'s');
 let calls=0;
 const server=createServer((req,res)=>{calls++;req.resume();if(req.url==='/invalid')res.end('not json');});
 await new Promise<void>(resolve=>server.listen(socketPath,resolve));
 try{
  await assert.rejects(callbackRequest({socketPath,token:'fixture'},'/invalid',{}),/Invalid Queue response/);
  // The server never answers /slow, so the budget only has to outlast delivery; 30 ms lost the request itself under load.
  await assert.rejects(callbackRequest({socketPath,token:'fixture'},'/slow',{}, {timeoutMs:2_000}),/inspect current state/);
  assert.equal(calls,2);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});

test('generated CLI helper remains standalone and preserves callback identity and credentials',async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'ns-helper-'))),socketPath=join(dir,'s');
 const requests:{path:string|undefined;auth:string|undefined;body:any}[]=[];
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests.push({path:req.url,auth:req.headers.authorization,body:JSON.parse(body)});res.end('{"ok":true}');});
 await new Promise<void>(resolve=>server.listen(socketPath,resolve));
 const helper=join(dir,'worker-report.mjs'),ticket=join(dir,'ticket.json');
 writeFileSync(helper,workerHelper);writeFileSync(ticket,JSON.stringify({socketPath,token:'fixture-secret',taskId:'t',runId:'r'}));
 const run=()=>new Promise<string>((resolve,reject)=>{
  const child=spawn(process.execPath,[helper,ticket],{stdio:['pipe','pipe','pipe']});let output='',error='';
  child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>error+=c);child.on('error',reject);child.on('close',code=>code===0?resolve(output):reject(Error(error)));
  child.stdin.end(JSON.stringify({status:'blocked',summary:'fixture'}));
 });
 try{
  assert.deepEqual(JSON.parse(await run()),{ok:true});await run();
  assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);
  assert.equal(requests[0].path,'/complete');assert.equal(requests[0].auth,'Bearer fixture-secret');
  assert.equal(requests[0].body.taskId,'t');assert.equal(requests[0].body.runId,'r');assert.match(requests[0].body.eventId,/^[a-f0-9]{64}$/);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});

test('T3 report helper prefers the current continuation ticket and refuses a stale one', async () => {
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'ns-helper-continuation-'))),socketPath=join(dir,'s');
 const requests:{body:any}[]=[];
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests.push({body:JSON.parse(body)});res.end('{"ok":true}');});
 await new Promise<void>(resolve=>server.listen(socketPath,resolve));
 const helper=join(dir,'worker-report.mjs'),stale=join(dir,'stale.json'),current=join(dir,'current.json');
 writeFileSync(helper,workerHelper);
 writeFileSync(stale,JSON.stringify({socketPath,token:'stale-secret',taskId:'task',runId:'old-run'}));
 writeFileSync(current,JSON.stringify({socketPath,token:'current-secret',taskId:'task',runId:'new-run'}));
 const run=(ticket:string,currentRun:string)=>new Promise<{code:number|null;err:string}>((resolve,reject)=>{
  const child=spawn(process.execPath,[helper],{stdio:['pipe','ignore','pipe'],env:{...process.env,NUCLEUS_TICKET:stale,NUCLEUS_CONTINUATION_TICKET:ticket,NUCLEUS_CONTINUATION_RUN_ID:currentRun,NUCLEUS_RUN_ID:'old-run'}});
  let err='';child.stderr.on('data',chunk=>err+=chunk);child.on('error',reject);child.on('close',code=>resolve({code,err}));
  child.stdin.end(JSON.stringify({status:'blocked',summary:'Current retained run'}));
 });
 try {
  const accepted=await run(current,'new-run');
  assert.equal(accepted.code,0,accepted.err);
  assert.equal(requests.length,1);
  assert.equal(requests[0]!.body.runId,'new-run');
  assert.equal(requests[0]!.body.taskId,'task');
  const refused=await run(stale,'new-run');
  assert.notEqual(refused.code,0);
  assert.match(refused.err,/Continuation ticket does not match the current run/);
  assert.equal(requests.length,1,'the stale continuation ticket sent no report');
 } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});

test('rotated continuation ticket is written before delivery and authenticates the helper as the current run', async () => {
 const { ReviewPolicy } = await import('../core/review/review-policy');
 const { writeMcpBinding, writeRunTicket } = await import('../core/dispatch/agent-creation');
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'ns-helper-rotated-continuation-'))),socketPath=join(dir,'s');
 const requests:{path:string|undefined;auth:string|undefined;body:any}[]=[];
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests.push({path:req.url,auth:req.headers.authorization,body:JSON.parse(body)});res.end('{"ok":true}');});
 await new Promise<void>(resolve=>server.listen(socketPath,resolve));
 const helper=join(dir,'worker-report.mjs'),paths={socketPath,helperPath:helper};
 writeFileSync(helper,workerHelper);
 const staleTicket=join(dir,'stale.json');
 writeFileSync(staleTicket,JSON.stringify({socketPath,token:'stale-secret',taskId:'task',runId:'old-run'}));
 let continuation='';
 const host={
  helperPath:helper,
  preflightWorkerContinuation:async()=>({available:true as const}),
  messageHost:{retainedAgentRef:()=>({workspaceId:'ws',archivedAt:null,refresh:async()=>{},current:()=>({labels:{'nucleus.mcpBinding':'old-run'}}),send:async(text:string)=>{continuation=text;}})},
  writeWorkerTicket:(task:any,runId:string,token:string)=>writeRunTicket(paths,task,{id:runId,role:'worker',generation:0},token),
  binding:(key:string,task:any,runId:string,token:string)=>writeMcpBinding(paths,key,task,runId,token),
 };
 try {
  await new ReviewPolicy(host as any).continueWorker({id:'task',agentId:'worker',workspaceId:'ws',runId:'new-run'} as any,'checkpoint','Continue',()=>({runId:'new-run',token:'fresh-secret'}));
  const ticketPath=continuation.match(/NUCLEUS_CONTINUATION_TICKET='([^']+)'/)?.[1];
  assert.ok(ticketPath,'the delivered prompt names its continuation ticket');
  assert.deepEqual(JSON.parse(readFileSync(ticketPath,'utf8')),{socketPath,taskId:'task',runId:'new-run',token:'fresh-secret'});
  assert.deepEqual(JSON.parse(readFileSync(join(dir,'tickets','mcp-old-run.json'),'utf8')),{socketPath,taskId:'task',runId:'new-run',token:'fresh-secret'});
  const child=spawn(process.execPath,[helper],{stdio:['pipe','ignore','pipe'],env:{...process.env,NUCLEUS_TICKET:staleTicket,NUCLEUS_CONTINUATION_TICKET:ticketPath,NUCLEUS_CONTINUATION_RUN_ID:'new-run',NUCLEUS_RUN_ID:'old-run'}});
  let error='';child.stderr.on('data',chunk=>error+=chunk);
  const exit=new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  child.stdin.end(JSON.stringify({status:'blocked',summary:'Continued under the current run'}));
  assert.equal(await exit,0,error);
  assert.equal(requests.length,1);
  assert.equal(requests[0]!.auth,'Bearer fresh-secret');
  assert.equal(requests[0]!.body.taskId,'task');
  assert.equal(requests[0]!.body.runId,'new-run');
 } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});

test('generated CLI helper carries reviewedInputs through authenticated completion and leaves omitted or invalid receipts alone',async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'ns-helper-reviewed-inputs-'))),store=new Store(join(dir,'queue.sqlite'));
 const engine=new Engine(store,{observe:observeIdle('ws', 'worker')} as unknown as Adapter);
 const socketPath=join(dir,'s'),helper=join(dir,'worker-report.mjs'),ticket=join(dir,'ticket.json');
 let stop:undefined|(()=>Promise<void>);
 const run=(payload:unknown)=>new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{
  const child=spawn(process.execPath,[helper,ticket],{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',reject);
  child.on('close',code=>resolve({code,stdout,stderr}));child.stdin.end(JSON.stringify(payload));
 });
 const addTask=(submissionId:string,runId:string)=>{
  const task=store.insert(submissionSchema.parse({submissionId,title:submissionId,repoPath:'/fixture',planningCommit:'a'.repeat(40),handoffPath:`${submissionId}.md`,originAgentId:'origin'}),'host','handoff','a'.repeat(40));
  store.update(task.id,{phase:'working',runId,agentId:'worker',workspaceId:'ws'});store.setCredential(runId,'fixture-secret');
  writeFileSync(ticket,JSON.stringify({socketPath,token:'fixture-secret',taskId:task.id,runId}),{mode:0o600});
  return task;
 };
 try{
  stop=await startCallbacks(socketPath,helper,engine);
  const reviewedInputs=[{path:'src/reviewed.ts',sha256:'c'.repeat(64)}];
  const acceptedTask=addTask('fallback-reviewed-inputs','run-reviewed-inputs');
  const accepted=await run({status:'blocked',summary:'Receipt accepted',reviewedInputs});
  assert.equal(accepted.code,0,accepted.stderr);assert.deepEqual(store.task(acceptedTask.id).completion?.reviewedInputs,reviewedInputs);

  const absentTask=addTask('fallback-absent-inputs','run-absent-inputs');
  const absent=await run({status:'blocked',summary:'No receipt'});
  assert.equal(absent.code,0,absent.stderr);assert.equal(Object.hasOwn(store.task(absentTask.id).completion??{},'reviewedInputs'),false);

  const invalidTask=addTask('fallback-invalid-inputs','run-invalid-inputs');
  const invalid=await run({status:'blocked',summary:'Invalid receipt',reviewedInputs:[{path:'../outside.ts',sha256:'c'.repeat(64)}]});
  assert.notEqual(invalid.code,0,'the authenticated Queue completion schema rejects the malformed receipt');
  assert.match(invalid.stderr,/reviewedInputs\[0\] path must be a normalized repository-relative path/,'the refusal names the exact entry and field');
  assert.equal(store.task(invalidTask.id).completion,null,'invalid input closure is not stored as an accepted callback');
 }finally{await engine.stop();await stop?.();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('generated CLI helper binds the ticket coordinator generation unless the payload supplies one',async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'ns-helper-generation-'))),socketPath=join(dir,'s');
 const bodies:any[]=[];
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;bodies.push(JSON.parse(body));res.end('{"ok":true}');});
 await new Promise<void>(resolve=>server.listen(socketPath,resolve));
 const helper=join(dir,'worker-report.mjs'),ticket=join(dir,'ticket.json');
 writeFileSync(helper,workerHelper);writeFileSync(ticket,JSON.stringify({socketPath,token:'fixture-secret',taskId:'t',runId:'r',coordinatorGeneration:3}));
 const run=(payload:unknown)=>new Promise<string>((resolve,reject)=>{
  const child=spawn(process.execPath,[helper,ticket],{stdio:['pipe','pipe','pipe']});let output='',error='';
  child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>error+=c);child.on('error',reject);child.on('close',code=>code===0?resolve(output):reject(Error(error)));
  child.stdin.end(JSON.stringify(payload));
 });
 try{
  await run({status:'recovered',summary:'Retry the check',recoveryAction:'retry'});
  assert.equal(bodies[0].coordinatorGeneration,3,'a payload without a generation carries the ticket binding');
  await run({status:'recovered',summary:'Retry the check',recoveryAction:'retry',coordinatorGeneration:4});
  assert.equal(bodies[1].coordinatorGeneration,4,'an explicit payload generation always wins');
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});

test('generated CLI helper forwards a full stage matrix beyond the former callback limit',async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'ns-helper-matrix-'))),socketPath=join(dir,'s');
 let body:any,path:string|undefined;
 const server=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;path=req.url;body=JSON.parse(text);res.end('{"ok":true}');});
 await new Promise<void>(resolve=>server.listen(socketPath,resolve));
 const helper=join(dir,'worker-report.mjs'),ticket=join(dir,'ticket.json');
 writeFileSync(helper,workerHelper);writeFileSync(ticket,JSON.stringify({socketPath,token:'fixture-secret',taskId:'t',runId:'r'}));
 const verdicts=Array.from({length:436},(_,index)=>{const id=`subject-${String(index).padStart(3,'0')}`;return{id,subject:id,verdict:'pass',evidence:'e'.repeat(1000)};});
 const payload={status:'ready_to_merge',summary:'Complete stage review',reviewText:'Findings',verdicts};
 assert.ok(Buffer.byteLength(JSON.stringify(payload))>60_000,'the report exceeds the former 60,000-character stdin bound');
 try{
  const result=await new Promise<string>((resolve,reject)=>{
   const child=spawn(process.execPath,[helper,ticket],{stdio:['pipe','pipe','pipe']});let output='',error='';
   child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>error+=chunk);child.on('error',reject);child.on('close',code=>code===0?resolve(output):reject(Error(error)));
   child.stdin.end(JSON.stringify(payload));
  });
  assert.deepEqual(JSON.parse(result),{ok:true});
  assert.equal(path,'/complete');
  assert.equal(body.taskId,'t');assert.equal(body.runId,'r');assert.equal(body.verdicts.length,436);
  assert.equal(body.verdicts[0].id,body.verdicts[0].subject);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});

test('generated CLI helper forwards every completion field, keeps legacy event IDs and is side-effect free on import',async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'ns-helper-fields-'))),socketPath=join(dir,'s');
 const bodies:any[]=[];
 const server=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;bodies.push(JSON.parse(text));res.end('{"ok":true}');});
 await new Promise<void>(resolve=>server.listen(socketPath,resolve));
 const helper=join(dir,'worker-report.mjs'),ticket=join(dir,'ticket.json');
 writeFileSync(helper,workerHelper);writeFileSync(ticket,JSON.stringify({socketPath,token:'fixture-secret',taskId:'t',runId:'r'}));
 const run=(args:string[],payload?:unknown)=>new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{
  const child=spawn(process.execPath,args,{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',reject);
  child.on('close',code=>resolve({code,stdout,stderr}));child.stdin.end(payload===undefined?'':JSON.stringify(payload));
 });
 try{
  // Lead 3fd53754: fields the canonical contract accepts reach /complete unchanged.
  const coordinatorAction={verb:'move',to:'review',reason:'The PR head is pushed and unreviewed'};
  assert.equal((await run([helper,ticket],{status:'recovered',summary:'Move to review',coordinatorAction})).code,0);
  assert.equal((await run([helper,ticket],{status:'changes_required',summary:'Author defect',reviewText:'Findings',reviewResponsibility:'author'})).code,0);
  assert.deepEqual(bodies[0].coordinatorAction,coordinatorAction);
  assert.equal(bodies[1].reviewResponsibility,'author');
  for(const body of bodies)completionSchema.parse(body);
  // A payload of historical fields keeps its historical event ID, so a retry across the upgrade is identical.
  assert.equal((await run([helper,ticket],{summary:'fixture',status:'blocked',prNumber:7})).code,0);
  const legacy={taskId:'t',runId:'r',status:'blocked',summary:'fixture',prNumber:7};
  assert.equal(bodies[2].eventId,createHash('sha256').update(JSON.stringify(legacy)).digest('hex'));
  // Importing the helper for its transport sends nothing and returns the pure callbackRequest.
  const imported=await run(['--input-type=module','-e',`const m=await import(${JSON.stringify(new URL(`file://${helper}`).href)});console.log(typeof m.callbackRequest)`]);
  assert.equal(imported.code,0,imported.stderr);assert.equal(imported.stdout.trim(),'function');
  assert.equal(bodies.length,3,'importing the helper sent no request');
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});

test('generated CLI helper reads the recovery task plan with its run credential and sends no report',async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'ns-helper-next-'))),socketPath=join(dir,'s');
 const requests:{path:string|undefined;auth:string|undefined;body:any}[]=[];
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests.push({path:req.url,auth:req.headers.authorization,body:JSON.parse(body)});res.end('{"taskId":"t","verbs":[]}');});
 await new Promise<void>(resolve=>server.listen(socketPath,resolve));
 const helper=join(dir,'worker-report.mjs'),ticket=join(dir,'ticket.json');
 writeFileSync(helper,workerHelper);writeFileSync(ticket,JSON.stringify({socketPath,token:'fixture-secret',taskId:'t',runId:'r'}));
 try{
  const output=await new Promise<string>((resolve,reject)=>{
   const child=spawn(process.execPath,[helper,ticket,'next'],{stdio:['ignore','pipe','pipe']});let out='',error='';
   child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>error+=c);child.on('error',reject);child.on('close',code=>code===0?resolve(out):reject(Error(error)));
  });
  assert.deepEqual(JSON.parse(output),{taskId:'t',verbs:[]});
  assert.deepEqual(requests,[{path:'/task-next',auth:'Bearer fixture-secret',body:{callerTaskId:'t',callerRunId:'r'}}]);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});


test('the callback environment reads the Nucleus names only', async () => {
 const {callbackEnvValue}=await import(new URL('../shared/service/callback-client.mjs',import.meta.url).href);
 assert.equal(callbackEnvValue('RUN_ID', {NUCLEUS_RUN_ID:'new'}), 'new');
 assert.equal(callbackEnvValue('RUN_ID', {NORTHSTAR_RUN_ID:'old'}), undefined, 'a retained old name is never read as a live credential');
 assert.equal(callbackEnvValue('RUN_ID', {NUCLEUS_RUN_ID:'new',NORTHSTAR_RUN_ID:'old'}), 'new');
});

test('the ticket environment reports to the authenticated run under the Nucleus names only', async () => {
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'ns-retained-ticket-'))),store=new Store(join(dir,'queue.sqlite'));
 const engine=new Engine(store,{observe:observeIdle('ws', 'worker')} as unknown as Adapter);
 const socketPath=join(dir,'s'),helper=join(dir,'helper.mjs'),ticket=join(dir,'ticket.json');
 const task=store.insert(submissionSchema.parse({submissionId:'retained-ticket',title:'Retained',repoPath:'/fixture',planningCommit:'a'.repeat(40),handoffPath:'handoff.md',originAgentId:'origin'}),'host','handoff','a'.repeat(40));
 store.update(task.id,{phase:'working',runId:'run-old',agentId:'worker',workspaceId:'ws'});store.setCredential('run-old','fixture-secret');
 writeFileSync(ticket,JSON.stringify({socketPath,token:'fixture-secret',taskId:task.id,runId:'run-old'}),{mode:0o600});
 const stop=await startCallbacks(socketPath,helper,engine);
 const run=(key:string)=>new Promise<{code:number|null;out:string;err:string}>((resolve,reject)=>{
  // Strip both callback families from the ambient environment first: a test run
  // inside a Nucleus worker inherits real run credentials, and a helper must
  // never be able to report to that live run from a fixture.
  const env={...process.env};
  for(const name of Object.keys(env)) if(name.startsWith('NUCLEUS_')||name.startsWith('NORTHSTAR_')) delete env[name];
  env[key]=ticket;
  const child=spawn(process.execPath,[helper],{env,stdio:['pipe','pipe','pipe']});let out='',err='';
  child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);child.on('error',reject);child.on('close',code=>resolve({code,out,err}));
  child.stdin.end(JSON.stringify({status:'blocked',summary:'Retained session'}));
 });
 try {
  const current=await run('NUCLEUS_TICKET');
  assert.equal(current.code,0,current.err);
  assert.equal(store.task(task.id).completion?.runId,'run-old');
  assert.equal(store.task(task.id).completion?.summary,'Retained session');
  // The retired environment name reaches no callback: a retained session must
  // not be able to report through it any more.
  const retired=await run('NORTHSTAR_TICKET');
  assert.notEqual(retired.code,0,'a NORTHSTAR_TICKET-only environment reports nothing');
  assert.match(retired.err,/Cannot find module|Error|Invalid|missing|Missing/);
 } finally {await engine.stop();await stop();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('a foreign ticket cannot overwrite the identity carried in a helper report', async () => {
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'ns-helper-identity-'))), helper=join(dir,'helper.mjs'),ticket=join(dir,'foreign.json');
 writeFileSync(helper,workerHelper); writeFileSync(ticket,JSON.stringify({socketPath:join(dir,'socket'),token:'foreign',taskId:'other-task',runId:'other-run'}));
 const result=await new Promise<{code:number|null;err:string}>((resolve,reject)=>{
  const child=spawn(process.execPath,[helper,ticket],{stdio:['pipe','pipe','pipe']});let err='';child.stderr.on('data',c=>err+=c);child.on('error',reject);child.on('close',code=>resolve({code,err}));
  child.stdin.end(JSON.stringify({taskId:'own-task',runId:'own-run',status:'ready_for_review',prNumber:867,summary:'Ready'}));
 });
 assert.notEqual(result.code,0);assert.match(result.err,/Report taskId does not match the callback ticket/);
});

test('foreign PR or branch is refused before worker completion is recorded', async () => {
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'ns-intake-identity-'))), store=new Store(join(dir,'queue.sqlite'));
 const engine=new Engine(store,{verifyPrIdentity:async (_task:unknown,number:number)=>{if(number===867)throw Error('PR branch does not match the task');return {url:'https://github.com/a/b/pull/1',head:'a'.repeat(40),repository:'a/b',headRepository:'a/b'};}} as unknown as Adapter);
 const task=store.insert(submissionSchema.parse({submissionId:'identity-intake',title:'Fixture',repoPath:'/fixture',planningCommit:'a'.repeat(40),handoffPath:'handoff.md',originAgentId:'origin'}),'host','handoff','a'.repeat(40));
 store.update(task.id,{phase:'working',runId:'own-run',agentId:'worker',workspaceId:'ws'});store.setCredential('own-run','token');
 try {
  const base={taskId:task.id,runId:'own-run',status:'ready_for_review' as const,summary:'Ready',prNumber:867};
  await assert.rejects(engine.complete({...base,eventId:'foreign-pr'},'token'),/PR branch does not match/);
  await assert.rejects(engine.complete({...base,eventId:'foreign-branch',prNumber:1,summary:'pushed ns-e01885a1-91bb-4ecd-a01a-615524d15c28'},'token'),/another task branch/);
  assert.equal(store.task(task.id).completion,null);assert.equal(store.events(task.id).filter(e=>e.kind==='completion_received').length,0);
 } finally {await engine.stop();store.close();}
});

test('a foreign ticket and the incident report cannot create a completion', async () => {
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'ns-foreign-report-'))),store=new Store(join(dir,'queue.sqlite'));
 const engine=new Engine(store,{verifyPrIdentity:async()=>{throw Error('PR branch does not match the task');}} as unknown as Adapter);
 const socketPath=join(dir,'s'),helper=join(dir,'helper.mjs'),ticket=join(dir,'other.json');
 const task=store.insert(submissionSchema.parse({submissionId:'foreign-ticket',title:'Other task',repoPath:'/fixture',planningCommit:'a'.repeat(40),handoffPath:'handoff.md',originAgentId:'origin'}),'host','handoff','a'.repeat(40));
 store.update(task.id,{phase:'working',runId:'other-run',agentId:'worker',workspaceId:'ws'});store.setCredential('other-run','secret');
 writeFileSync(ticket,JSON.stringify({socketPath,token:'secret',taskId:task.id,runId:'other-run'}));
 const stop=await startCallbacks(socketPath,helper,engine);
 try {
  const result=await new Promise<{code:number|null;err:string}>((resolve,reject)=>{
   const child=spawn(process.execPath,[helper,ticket],{stdio:['pipe','pipe','pipe']});let err='';child.stderr.on('data',c=>err+=c);child.on('error',reject);child.on('close',code=>resolve({code,err}));
   child.stdin.end(JSON.stringify({status:'ready_for_review',prNumber:867,summary:'pushed on ns-e01885a1-91bb-4ecd-a01a-615524d15c28'}));
  });
  assert.notEqual(result.code,0);assert.match(result.err,/another task branch/);assert.equal(store.task(task.id).completion,null);
  assert.equal(store.events(task.id).filter(e=>e.kind==='completion_received').length,0);
 } finally {await engine.stop();await stop();store.close();}
});
