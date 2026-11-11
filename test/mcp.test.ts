import { observeIdle } from './support/fakes';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,chmodSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Store} from '../core/store/store';
import {Engine} from '../core/engine';
import {submissionSchema} from '../shared/contracts';
import {startCallbacks} from '../service/callbacks/callback';
import {reportSchema} from '../core/intake/report';
import {createServer} from 'node:http';
import type {Adapter} from '../core/host';

for(const scope of ['legacy','report'])test(`real MCP ${scope} launch exposes only the Nucleus tools, reports safely and fences retained assignments`,async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'ns-mcp-'))),store=new Store(join(dir,'queue.sqlite'));
 const engine=new Engine(store,{observe:observeIdle('ws', 'worker')} as unknown as Adapter,60000);
 const socket=join(dir,'callback.sock'),binding=join(dir,'binding.json');
 let stop:undefined|(()=>Promise<void>);const client=new Client({name:'acceptance',version:'1'});
 try{
  const t=store.insert(submissionSchema.parse({submissionId:'mcp',title:'MCP fixture',repoPath:'/fixture',planningCommit:'a'.repeat(40),handoffPath:'handoff.md',originAgentId:'origin'}),'host','handoff','a'.repeat(40));
  const prerequisite=store.insert(submissionSchema.parse({submissionId:'prerequisite',title:'Prerequisite',repoPath:'/fixture',planningCommit:'a'.repeat(40),handoffPath:'prerequisite.md',originAgentId:'origin'}),'host','handoff','a'.repeat(40));
  const target=store.insert(submissionSchema.parse({submissionId:'target',title:'Queued target',repoPath:'/fixture',planningCommit:'a'.repeat(40),handoffPath:'target.md',originAgentId:'origin'}),'host','handoff','a'.repeat(40));
  const bulkOne=store.insert(submissionSchema.parse({submissionId:'bulk-one',title:'Bulk one',repoPath:'/fixture',planningCommit:'a'.repeat(40),handoffPath:'bulk-one.md',originAgentId:'origin'}),'host','handoff','a'.repeat(40));
  const bulkTwo=store.insert(submissionSchema.parse({submissionId:'bulk-two',title:'Bulk two',repoPath:'/fixture',planningCommit:'a'.repeat(40),handoffPath:'bulk-two.md',originAgentId:'origin'}),'host','handoff','a'.repeat(40));
  store.update(t.id,{phase:'working',runId:'run-1',agentId:'worker',workspaceId:'ws'});store.setCredential('run-1','private-test-token');
  writeFileSync(binding,JSON.stringify({socketPath:socket,taskId:t.id,runId:'run-1',token:'private-test-token'}),{mode:0o600});
  stop=await startCallbacks(socket,join(dir,'helper.mjs'),engine);
  await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../mcp-report.mjs',import.meta.url)),binding,...(scope==='report'?['report']:[])],stderr:'pipe',env:{...process.env,NUCLEUS_DATA_HOME:dir}}));
  const catalog=await client.listTools();
  const reportProperties=catalog.tools.find(tool=>tool.name==='nucleus_report')!.inputSchema.properties as Record<string,{enum?:string[]}>;
  assert.deepEqual(reportProperties.reviewResponsibility.enum,['author','reviewer','environment']);
  // Lead 3fd53754: the advertised report fields are exactly the canonical report fields the bridge
  // does not supply itself, so the SDK never strips a field Queue accepts.
  assert.deepEqual(Object.keys(reportProperties).sort(),Object.keys(reportSchema.shape).filter(key=>!['eventId','taskId'].includes(key)).sort());
  // Spec 050: the narrow recoveryAction shape is retired from the catalog; coordinators report coordinatorAction.
  assert.equal(reportProperties.recoveryAction,undefined);
  assert.ok(reportProperties.coordinatorAction);
  assert.ok(reportProperties.headline,'the report catalog requires the one-line headline (task 538)');
  assert.ok(reportProperties.reviewedInputs,'the reviewer report catalog accepts the authenticated input-closure receipt');
  {
   // Spec 058 (task 550): the ask tool rides the same per-run binding as the report tool.
   // Spec 058 rollout step 3 (task 621): so does nucleus_message. The retired
   // `northstar_*` names are neither advertised nor accepted by a live session.
   assert.deepEqual(catalog.tools.map(tool=>tool.name),['nucleus_report','nucleus_ask','nucleus_message']);
   for(const retired of ['northstar_report','northstar_ask','northstar_message']) assert.equal((await client.callTool({name:retired,arguments:{}})).isError,true,`${retired} is not an exposed tool`);
   const askProperties=catalog.tools.find(tool=>tool.name==='nucleus_ask')!.inputSchema.properties as Record<string,{enum?:string[]}>;
   assert.deepEqual(askProperties.kind.enum,['proof_acceptance','budget','review','scope','release','process']);
   const foreignRunAsk=await client.callTool({name:'nucleus_ask',arguments:{runId:'run-1-typo',question:'Which approach?'}});assert.equal(foreignRunAsk.isError,true);
   assert.match(String((foreignRunAsk.content as {text:string}[])[0].text),/bound to run run-1; the ask named run run-1-typo/);
   assert.equal(store.events(t.id).filter(event=>event.kind==='agent_ask').length,0,'a mistyped runId asks nothing');
   assert.equal((await client.callTool({name:'nucleus_ask',arguments:{question:'Which approach?',kind:'inventing'}})).isError,true,'an unknown kind hint is refused by the catalog');
   assert.equal(store.events(t.id).filter(event=>event.kind==='agent_ask').length,0);
   const foreignRunMessage=await client.callTool({name:'nucleus_message',arguments:{runId:'run-1-typo',to:'other#1',text:'hello'}});assert.equal(foreignRunMessage.isError,true);
   assert.match(String((foreignRunMessage.content as {text:string}[])[0].text),/bound to run run-1; the message named run run-1-typo/);
   assert.equal(store.events(t.id).filter(event=>event.kind.startsWith('agent_message')).length,0,'a mistyped runId sends nothing');
   const oversize=await client.callTool({name:'nucleus_message',arguments:{to:'other#1',text:'x'.repeat(4001)}});assert.equal(oversize.isError,true,'the message size bound rides the catalog');
   assert.equal((await client.callTool({name:'nucleus_message',arguments:{to:'other#1',text:'hello',role:'owner'}})).isError,true,'an unknown role is refused by the catalog');
   assert.equal(store.events(t.id).filter(event=>event.kind.startsWith('agent_message')).length,0);
   assert.equal((await client.callTool({name:'nucleus_dispose_task',arguments:{taskId:target.id,version:target.version,action:'cancel',reason:'Not exposed'}})).isError,true);
   assert.equal(store.task(target.id).phase,'queued');
  }
  const reviewedInputs=[{directory:'plans'}, {digest:'b'.repeat(64),count:1000}];
  const args={runId:'run-1',status:'blocked',headline:'Blocked on the fixture',summary:'Acceptance result',...{reviewedInputs}};
  {
   const tooMany=await client.callTool({name:'nucleus_report',arguments:{...args,reviewedInputs:Array.from({length:1000},(_,i)=>({path:`plans/${i}.md`,sha256:'b'.repeat(64)}))}});
   assert.equal(tooMany.isError,true); assert.match(JSON.stringify(tooMany),/Summarise reviewedInputs as directories or a digest/);
   const invalid=await client.callTool({name:'nucleus_report',arguments:{...args,reviewedInputs:[{path:'../outside.ts',sha256:'b'.repeat(64)}]}});
   assert.equal(invalid.isError,true,'non-normalized reviewed input paths are rejected');
   assert.equal(store.task(t.id).completion,null,'invalid receipts do not complete the task');
   const typo={runId:'run-1-typo',status:args.status,headline:args.headline,summary:args.summary};
   const rejected=await client.callTool({name:'nucleus_report',arguments:typo});assert.equal(rejected.isError,true);
   // Queue #535 (papercut 5ac8ffb0): the session is bound to one run, so a typed runId that names any
   // other run is refused with the bound run named and nothing recorded. effigy#528's reviewer typed
   // one wrong character, read its own report as accepted, and Queue had no receipt.
   assert.equal(String((rejected.content as {text:string}[])[0].text),`This nucleus_report session is bound to run run-1; the report named run run-1-typo, so nothing was reported. Resend the same report with runId run-1, or omit runId.`);
   assert.equal(store.task(t.id).completion,null,'a mismatched runId records no result');
   assert.equal(store.events(t.id).filter(e=>e.kind==='completion_received').length,0);
   const another=store.insert(submissionSchema.parse({submissionId:'same-agent',title:'Another active report',repoPath:'/fixture',planningCommit:'a'.repeat(40),handoffPath:'same-agent.md',originAgentId:'origin'}),'host','handoff','a'.repeat(40));
   store.update(another.id,{phase:'working',runId:'run-2-active',agentId:'another-worker',workspaceId:'ws'});store.setCredential('run-2-active','another-worker-token');
   // A second live run elsewhere changes nothing: the refusal still answers from this session's own binding.
   const repeated=await client.callTool({name:'nucleus_report',arguments:typo});assert.equal(repeated.isError,true);
   assert.equal(String((repeated.content as {text:string}[])[0].text),String((rejected.content as {text:string}[])[0].text));
   assert.equal(store.task(another.id).completion,null,'another run is never reported by this binding');
  }
  const first=await client.callTool({name:'nucleus_report',arguments:args});assert.ok(!first.isError);assert.equal(store.task(t.id).completion?.summary,args.summary);
  // The retired alias reaches nothing: no tool is registered under it, so no
  // second accepted receipt and no second stored completion can be produced.
  assert.equal((await client.callTool({name:'northstar_report',arguments:args})).isError,true);
  assert.equal(store.task(t.id).completion?.summary,args.summary);
  assert.equal(store.task(t.id).completion?.headline,args.headline,'the accepted report keeps the headline it carried');
  assert.deepEqual(store.task(t.id).completion?.reviewedInputs,reviewedInputs,'the authenticated completion retains exactly the submitted receipt');
  {
   const omitted=await client.callTool({name:'nucleus_report',arguments:{status:args.status,headline:args.headline,summary:args.summary,reviewedInputs}});assert.deepEqual(omitted,first,'the bridge supplies its bound runId when omitted');
   const staleReporter=store.insert(submissionSchema.parse({submissionId:'stale-reporter',title:'Stale reporter',repoPath:'/fixture',planningCommit:'a'.repeat(40),handoffPath:'stale-reporter.md',originAgentId:'origin'}),'host','handoff','a'.repeat(40));
   store.update(staleReporter.id,{phase:'blocked',runId:'stale-agent-run',agentId:'agent-a',workspaceId:'ws'});store.setCredential('stale-agent-run','stale-agent-token');
   const foreign=store.insert(submissionSchema.parse({submissionId:'foreign-active',title:'Foreign active',repoPath:'/fixture',planningCommit:'a'.repeat(40),handoffPath:'foreign-active.md',originAgentId:'origin'}),'host','handoff','a'.repeat(40));
   store.update(foreign.id,{phase:'working',runId:'other-agent-live-run',agentId:'agent-b',workspaceId:'ws'});
   writeFileSync(binding,JSON.stringify({socketPath:socket,taskId:staleReporter.id,runId:'stale-agent-run',token:'stale-agent-token'}));
   const foreignMismatch=await client.callTool({name:'nucleus_report',arguments:{runId:'foreign-current-typo',status:'blocked',headline:'Do not disclose another agent',summary:'Do not disclose another agent'}});assert.equal(foreignMismatch.isError,true);
   const foreignMessage=String((foreignMismatch.content as {text:string}[])[0].text);assert.match(foreignMessage,/bound to run stale-agent-run/);assert.ok(!foreignMessage.includes('other-agent-live-run'),'another agent\'s active run is never disclosed');
   writeFileSync(binding,JSON.stringify({socketPath:socket,taskId:t.id,runId:'run-1',token:'private-test-token'}));
  }
  const currentTarget=store.task(target.id);assert.equal((await client.callTool({name:'nucleus_set_dependencies',arguments:{taskId:target.id,version:currentTarget.version,dependsOn:[]}})).isError,true);
  assert.equal((await client.callTool({name:'nucleus_task_dependencies',arguments:{taskId:target.id}})).isError,true);
  assert.equal((await client.callTool({name:'nucleus_project_queue',arguments:{taskId:target.id}})).isError,true);
  // Simulate interruption after durable completion but before the report response is recorded.
  const eventId=store.task(t.id).completion!.eventId;store.db.prepare('UPDATE receipts SET report_response=NULL WHERE id=?').run(eventId);
  assert.deepEqual(await client.callTool({name:'nucleus_report',arguments:args}),first);
  assert.equal(store.events(t.id).filter(e=>e.kind==='completion_received').length,1);
  // nucleus#937: a fresh store opens paused, and pause now applies the stored
  // result. Wait for that drain, then restore a live replacement assignment.
  // The retained-assignment fence is unchanged: a bound run-2 report is
  // accepted; a run-1 report on that binding is still refused.
  await engine.quiesce();
  assert.equal(store.task(t.id).phase,'blocked','pause applies the stored blocked result');
  store.update(t.id,{phase:'working',runId:'run-2',completion:null,reason:'Replacement worker'});store.setCredential('run-2','replacement-secret');
  writeFileSync(binding,JSON.stringify({socketPath:socket,taskId:t.id,runId:'run-2',token:'replacement-secret'}));
  assert.equal((await client.callTool({name:'nucleus_report',arguments:args})).isError,true);
  const next=await client.callTool({name:'nucleus_report',arguments:{runId:'run-2',status:'blocked',headline:'Resumed',summary:'Resumed'}});
  assert.ok(!next.isError,String((next.content as {text:string}[])[0]?.text??'report failed'));
  assert.equal(store.task(t.id).completion?.runId,'run-2');
  assert.equal(Object.hasOwn(store.task(t.id).completion??{},'reviewedInputs'),false,'omitting the optional receipt remains compatible and does not fabricate one');
 }finally{await client.close();await engine.stop();await stop?.();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('real MCP report forwards typed coordinator actions and reviewer responsibility unchanged',async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'ns-mcp-fields-'))),socket=join(dir,'callback.sock'),binding=join(dir,'binding.json');
 const bodies:any[]=[];
 const server=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;bodies.push({path:req.url,body:JSON.parse(text)});res.end('{"accepted":true}');});
 await new Promise<void>(resolve=>server.listen(socket,resolve));
 writeFileSync(binding,JSON.stringify({socketPath:socket,taskId:'task',runId:'run',token:'private-test-token'}),{mode:0o600});
 const client=new Client({name:'acceptance',version:'1'});
 try{
  await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../mcp-report.mjs',import.meta.url)),binding,'report'],stderr:'pipe'}));
  const coordinatorAction={verb:'route',role:'worker',profileId:'sol',reason:'GLM looped three rounds'};
  // A typed runId that names no bound run never reaches the callback channel at all.
  assert.equal((await client.callTool({name:'nucleus_report',arguments:{runId:'run-typo',status:'recovered',headline:'Wrong run',summary:'Wrong run'}})).isError,true);
  assert.equal(bodies.length,0);
  assert.ok(!(await client.callTool({name:'nucleus_report',arguments:{status:'recovered',headline:'Routing the worker to a fresh profile',summary:'Route the worker',coordinatorAction}})).isError);
  assert.ok(!(await client.callTool({name:'nucleus_report',arguments:{status:'changes_required',headline:'Author defect in the parser',summary:'Author defect',reviewText:'Findings',reviewResponsibility:'author'}})).isError);
  assert.deepEqual(bodies.map(item=>item.path),['/report','/report']);
  assert.deepEqual(bodies[0].body.coordinatorAction,coordinatorAction);
  assert.equal(bodies[1].body.reviewResponsibility,'author');
  // Every forwarded body parses under the canonical report contract.
  for(const item of bodies)reportSchema.parse(item.body);
 }finally{await client.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});

test('a runId mismatch through a ticket outside the current data home refuses without a resend',async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'ns-mcp-outside-')));
 const home=join(dir,'data-home');
 mkdirSync(home);
 const binding=join(dir,'tickets','mcp-run.json');
 mkdirSync(join(dir,'tickets'));
 writeFileSync(binding,JSON.stringify({socketPath:join(dir,'callback.sock'),taskId:'task',runId:'run-1',token:'token'}),{mode:0o600});
 const client=new Client({name:'acceptance',version:'1'});
 try{
  await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../mcp-report.mjs',import.meta.url)),binding,'report'],stderr:'pipe',env:{...process.env,NUCLEUS_DATA_HOME:home}}));
  const rejected=await client.callTool({name:'nucleus_report',arguments:{runId:'run-1-typo',status:'blocked',headline:'Stale binding',summary:'Stale binding'}});
  assert.equal(rejected.isError,true);
  const text=String((rejected.content as {text:string}[])[0].text);
  assert.equal(text,'This nucleus_report session is bound to run run-1 through a ticket outside the current data home; the report named run run-1-typo, so nothing was reported. Do not resend through this callback. Nucleus will relaunch this role on a fresh thread that can report.');
  assert.equal(text.includes('Resend'),false);
  const ask=await client.callTool({name:'nucleus_ask',arguments:{runId:'run-1-typo',question:'Which approach?'}});
  assert.equal(ask.isError,true);
  assert.match(String((ask.content as {text:string}[])[0].text),/Do not resend through this callback/);
 }finally{await client.close();rmSync(dir,{recursive:true,force:true});}
});
