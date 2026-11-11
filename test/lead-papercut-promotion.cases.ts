import { test, weighted } from './support/sharded-test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {QueueRuntime} from '../service/runtime-owner';
import {git} from '../core/git/index';
import {parseNorthstarDocument} from '../core/planning/handoff';
import {workerPrompt} from '../core/dispatch/prompts';
import {briefDigest} from '../core/planning/brief';
import {buildOutcomeRecord, digest as storeDigest, operationInputHash, Store} from '../core/store/store';
import {leadCheck,leadApprove,sourcePromotionOperationPayloadSchema} from '../shared/contracts';
import {readFileSync} from 'node:fs';
import { boardSource } from './support/board-source';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import type {Adapter} from '../core/host';

const text = `---\ntitle: Draft fixture\nqueue:\n  complexity: medium\n  scope: mechanical\n---\n\n## Outcome\n\nBuild the fixture.\n`;
async function fixture(t: any) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'nsq-drafts-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const repo=join(root,'repo');
  await git(root,'init','--bare','--initial-branch=main',join(root,'origin.git'));
  await git(root,'clone',join(root,'origin.git'),repo);
  await git(repo,'config','user.name','Queue test'); await git(repo,'config','user.email','queue@example.invalid');
  const publish=async(manifest='paseo.queue.control.v5')=>{
    await mkdir(join(repo,'.paseo'),{recursive:true});
    await writeFile(join(repo,'.paseo','queue.json'),JSON.stringify({schema:manifest,closeout:'queue',hooks:[]}));
    await git(repo,'add','.'); await git(repo,'commit','-m','fixture'); await git(repo,'push','origin','main');
  };
  await publish();
  const adapter={client:{isConnected:true},hostId:'fixture-host',socketPath:join(root,'callback.sock'),helperPath:join(root,'helper.mjs'),
    connect:async()=>{},close:async()=>{},catalog:async()=>({providers:[]}),originAgent:async(id:string)=>({id,workspaceId:'origin-ws',archived:false})} as unknown as Adapter;
  const dataDir=join(root,'data');
  const runtime=new QueueRuntime({dataDir,adapterFactory:()=>adapter,timers:false});
  t.after(()=>runtime.drain()); await runtime.started; await runtime.bootstrap;
  runtime.store.setMeta('paused',true);
  return {runtime,repo,root,dataDir,adapter,publish};
}
weighted(1)('proof-only lead check warns that a worker preference binds the GO-gate reviewer only',async t=>{
  const f=await fixture(t),head=await git(f.repo,'rev-parse','HEAD');
  const preferred={id:'preferred-worker',name:'Preferred worker',provider:'test',model:'preferred-model',notes:'',available:true,problem:'',supportedThinking:[]};
  f.runtime.engine.profiles=[preferred];
  const body=`---\ntitle: Proof preference check\nqueue:\n  complexity: medium\n  preferredProfileId: preferred-worker\n  requirePreferred: true\n  proofOnly:\n    commit: ${head}\n  proofExecution:\n    selector: effigy check\n    inputs: []\n  requiresOperatorGo: release approval\n---\n\n## Outcome\n\nQualify the merged source.\n`;
  const lead=await f.runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'Proof preference check',body,lanes:[],author:'planner'});
  assert.equal(lead.check?.ok,true,lead.check?.message);
  assert.match(lead.check?.message??'',/Warning: On proof-only tasks, preferredProfileId\/requirePreferred bind only the GO-gate reviewer when requiresOperatorGo is set/);
  assert.match(lead.check?.message??'',/executor is always selected independently/);
});
async function promotedTask(runtime:QueueRuntime,result:Awaited<ReturnType<QueueRuntime['promoteLeadToTask']>>) {
  if ('taskId' in result) return result;
  if ('backpressured' in result) throw new Error(result.reason);
  const operation=await runtime.engine.awaitOperation(result.operation.id,8_000);
  if (operation.state!=='succeeded'||!operation.result?.taskId||!operation.result.reference)
    throw new Error(operation.diagnostic||'Promotion did not produce a task');
  return {taskId:operation.result.taskId,reference:operation.result.reference};
}

weighted(3)('a promoted report-only lead gets the report-only prompt and can report_ready',async t=>{
  const f=await fixture(t);
  f.runtime.store.upsertLane({key:'web-health',title:'Web health',aim:'Report web health',repositories:[{origin:'acme/fixture',path:f.repo}]});
  f.runtime.store.upsertLane({key:'other-notes',title:'Other notes',aim:'Side notes',repositories:[{origin:'acme/fixture',path:f.repo}]});
  const first=f.runtime.store.editLaneDocument({key:'web-health',version:0,text:'## Findings\nObserved.\n',author:'planner'});
  const body=`---\ntitle: Report the web health\nqueue:\n  complexity: low\n  lanes: [web-health, other-notes]\n  reportOnly: true\n  reportLane: web-health\n---\n\n## Outcome\nWrite the report to web-health.\n`;
  assert.throws(()=>parseNorthstarDocument(body,'brief'),/queue_approval/);
  const lead=await f.runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'Report the web health',body,lanes:['web-health'],author:'planner'});
  assert.equal(lead.check?.ok,true,lead.check?.message);
  f.runtime.approveLead({id:lead.id,version:lead.version,digest:lead.digest!,approver:'operator (board)',note:'',relayed:false});
  const promoted=await promotedTask(f.runtime,await f.runtime.promoteLeadToTask({id:lead.id,note:'',board:true}));
  const task=f.runtime.store.task(promoted.taskId);
  assert.doesNotMatch(task.brief!.text,/queue_approval/);
  const prompt=workerPrompt(task,true);
  assert.match(prompt,/Allowed statuses: report_ready, blocked, error/);
  assert.match(prompt,/This brief opts into report-only delivery/);
  const runId='report-ready-run';
  f.runtime.store.update(task.id,{phase:'working',completion:null,runId,reason:'Worker is writing the report'});
  f.runtime.store.setCredential(runId,'report-ready-token');
  const base={taskId:task.id,runId,status:'report_ready' as const,summary:'Report delivered',headline:'Report ready'};
  await assert.rejects(f.runtime.engine.complete({...base,eventId:'wrong-lane',artifact:{key:'other-notes',version:first.version,digest:first.digest}},'report-ready-token'),/report lane web-health/);
  const latest=f.runtime.store.editLaneDocument({key:'web-health',version:first.version,text:'## Findings\nObserved, then updated.\n',author:'planner'});
  await assert.rejects(f.runtime.engine.complete({...base,eventId:'stale-artifact',artifact:{key:first.key,version:first.version,digest:first.digest}},'report-ready-token'),/latest exact Nucleus lane document/);
  const accepted=await f.runtime.engine.complete({...base,eventId:'report-ready-event',artifact:{key:latest.key,version:latest.version,digest:latest.digest}},'report-ready-token');
  assert.equal(accepted.accepted,true);
});

weighted(2)('a report-only lead with no attached lane fails lead.check',async t=>{
  const f=await fixture(t);
  const body=`---\ntitle: Report nowhere\nqueue:\n  complexity: low\n  reportOnly: true\n---\n\n## Outcome\nWrite a report.\n`;
  const lead=await f.runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'Report nowhere',body,lanes:[],author:'planner'});
  assert.equal(lead.check?.ok,false);
  assert.match(lead.check?.message??'',/queue\.reportOnly requires an attached lane/);
});

weighted(2)('a promoted lead carries its lanes onto the task even when the brief frontmatter names none',async t=>{
  // consumer-b #321, #324, #325 (2026-10-04): leads added with lanes produced unlaned tasks.
  const f=await fixture(t);
  f.runtime.store.upsertLane({key:'workspace-fixes',title:'Workspace fixes',aim:'Fix the workspace.',repositories:[{origin:'acme/fixture',path:f.repo}]});
  const lead=await f.runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'Laned lead',body:text,lanes:['workspace-fixes'],author:'planner'});
  assert.equal(lead.check?.ok,true,lead.check?.message);
  f.runtime.approveLead({id:lead.id,version:lead.version,digest:lead.digest!,approver:'operator (board)',note:'',relayed:false});
  const promoted=await promotedTask(f.runtime,await f.runtime.promoteLeadToTask({id:lead.id,note:'',board:true}));
  assert.deepEqual(f.runtime.store.task(promoted.taskId).lanes,['workspace-fixes']);
});

weighted(2)('proof-only promotion refuses a commit that is not an ancestor of the selected base',async t=>{
  const f=await fixture(t);
  await git(f.repo,'switch','-c','qualification-candidate');
  await writeFile(join(f.repo,'candidate.txt'),'not merged\n');
  await git(f.repo,'add','candidate.txt');await git(f.repo,'commit','-m','Unmerged qualification candidate');
  const candidate=await git(f.repo,'rev-parse','HEAD');
  await git(f.repo,'switch','main');
  const body=`---\ntitle: Proof-only qualification\nqueue:\n  complexity: medium\n  proofOnly:\n    commit: ${candidate}\n  proofExecution:\n    selector: "effigy test unit -- test/proof-fixture.test.ts"\n    inputs: ["sha256:${'e'.repeat(64)}"]\n---\n\n## Outcome\n\nQualify an already merged commit.\n`;
  const lead=await f.runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'Proof-only qualification',body,lanes:[],author:'planner'});
  assert.equal(lead.check?.ok,true,lead.check?.message);
  f.runtime.approveLead({id:lead.id,version:lead.version,digest:briefDigest(body),approver:'operator (board)',note:'',relayed:false});
  await assert.rejects(f.runtime.promoteLeadToTask({id:lead.id,note:'',board:true}),/not proved as an ancestor of origin\/main; promotion refused/);
  assert.equal(f.runtime.store.tasks().length,0,'an unmerged source commit never becomes a task');

  const merged=await git(f.repo,'rev-parse','main');
  const mergedBody=body.replace(candidate,merged);
  const mergedLead=await f.runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'Merged proof-only qualification',body:mergedBody,lanes:[],author:'planner'});
  assert.equal(mergedLead.check?.ok,true,mergedLead.check?.message);
  f.runtime.approveLead({id:mergedLead.id,version:mergedLead.version,digest:briefDigest(mergedBody),approver:'operator (board)',note:'',relayed:false});
  const promoted=await promotedTask(f.runtime,await f.runtime.promoteLeadToTask({id:mergedLead.id,note:'',board:true}));
  const task=f.runtime.store.task(promoted.taskId);
  assert.equal(task.entrypoint,'proof'); assert.equal(task.proofOnly?.commit,merged); assert.equal(task.branch,'');
});

weighted(2)('a later lead version can correct the brief author used by checks',async t=>{
  const f=await fixture(t);
  const origins:string[]=[];
  const preview=f.runtime.engine.hooks.previewPreDispatch.bind(f.runtime.engine.hooks);
  f.runtime.engine.hooks.previewPreDispatch=async(submission,handoffText,planningBase)=>{
    origins.push(submission.originAgentId);
    if(submission.originAgentId!=='planner-agent-id')throw new Error(`Agent not found: ${submission.originAgentId}`);
    await preview(submission,handoffText,planningBase);
  };
  const lead=await f.runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'Correctable author',body:text,lanes:[],author:'Planner Display Name'});
  assert.equal(lead.check?.ok,false);
  assert.match(lead.check?.message??'',/Agent not found: Planner Display Name/);

  const edited=await f.runtime.editLead({id:lead.id,version:lead.version,body:`${text}\n`,author:'planner-agent-id'});
  assert.equal(edited.check?.ok,true,edited.check?.message);
  assert.deepEqual(origins,['Planner Display Name','planner-agent-id']);
  assert.deepEqual(f.runtime.getLead({id:lead.id}).versions.map(version=>version.author),['Planner Display Name','planner-agent-id']);
});

weighted(2)('Spec 043 retired: a lead whose brief declares stages refuses check with the retirement refusal',async t=>{
  const f=await fixture(t);
  const stageFields=`  stages:
    - id: final-review
      kind: review
      subject: {head: candidate, digests: []}
      role: reviewer
      independence: []
      gate: {pass: [source-check], insufficient: []}
      actions: [comment]
      wait: []`;
  const validText=text.replace('  scope: mechanical',`  scope: mechanical\n${stageFields}`);
  const valid=await f.runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'Stage brief',body:validText,lanes:[],author:'planner'});
  const validCheck=await f.runtime.checkLead({id:valid.id,repository:f.repo});
  assert.equal(validCheck.check?.ok,false);
  assert.match(validCheck.check?.message??'',/Declared steps are retired/);

  // An invalid declaration still reports its own frontmatter error.
  const invalidText=text.replace('  scope: mechanical',`  scope: mechanical\n${stageFields.replace('kind: review','kind: work')}`);
  const invalid=await f.runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'Invalid stage brief',body:invalidText,lanes:[],author:'planner'});
  const invalidCheck=await f.runtime.checkLead({id:invalid.id,repository:f.repo});
  assert.equal(invalidCheck.check?.ok,false);
  assert.equal(invalidCheck.check?.message,'Invalid draft frontmatter: queue.stages.0.kind: The last stage must be review or verify');
});

weighted(3)('Spec 043 retired: a declared stage profile is refused at brief check before any profile preflight',async t=>{
  const f=await fixture(t);
  const reviewer={id:'deepseek',name:'deepseek',provider:'test',model:'deepseek/deepseek-v3',notes:'',available:true,problem:'',supportedThinking:[]};
  f.runtime.engine.profiles=[reviewer];
  f.runtime.store.setMeta('pool',[{profileId:'deepseek',enabled:true,group:'review',roles:['reviewer'],weight:1,scopes:['mechanical']}]);
  const stageFields=`  stages:
    - id: final-verify
      kind: verify
      subject: {head: candidate, digests: []}
      role: reviewer
      independence: []
      gate: {pass: [source-check], insufficient: []}
      actions: [comment]
      profile: {id: deepseek, reason: "Fresh verifier on a different model"}
      wait: []`;
  // Retired (Spec 043, 2026-10-06): any declared plan refuses with the retirement
  // refusal, so the catalog, role and availability distinctions no longer apply.
  for (const body of [
    text.replace('  scope: mechanical',`  scope: mechanical\n${stageFields}`),
    text.replace('  scope: mechanical',`  scope: mechanical\n${stageFields.replace('id: deepseek, reason','id: not-in-catalog, reason')}`),
  ]) {
    const lead=await f.runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'Verifier brief',body,lanes:[],author:'planner'});
    const check=await f.runtime.checkLead({id:lead.id,repository:f.repo});
    assert.equal(check.check?.ok,false);
    assert.match(check.check?.message??'',/Declared steps are retired/);
  }
});

weighted(3)('Spec 026 row 7: an approved lead and a papercut promote directly to tasks',async t=>{
  const f=await fixture(t);
  const lead=await f.runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'Draft fixture',body:text,lanes:[],author:'planner'});
  assert.equal(lead.check?.ok,true,lead.check?.message);
  const approved=f.runtime.approveLead({id:lead.id,version:1,digest:lead.digest!,approver:'operator (board)',note:'',relayed:false});
  assert.equal(approved.approval?.digest,briefDigest(text));
  const first=await promotedTask(f.runtime,await f.runtime.promoteLeadToTask({id:lead.id,note:'',board:true}));
  const task=f.runtime.store.task(first.taskId);
  assert.equal(task.brief?.text,text);
  assert.deepEqual(task.planningSource,{kind:'lead',id:lead.id});
  assert.equal(task.leadProvenance?.approval.digest,briefDigest(text));
  assert.deepEqual(f.runtime.getLead({id:lead.id}).targets.map(target=>target.reference),[task.id]);
  const outcome=buildOutcomeRecord({...task,phase:'done'},[],[],false);
  assert.deepEqual(outcome.planningSource,{kind:'lead',id:lead.id});
  assert.equal(outcome.brief.approval?.digest,briefDigest(text));
  const cut=f.runtime.addPapercut({repository:{origin:f.repo,path:f.repo},title:'Cut',happened:'It failed.',impact:'A user waited.',fix:'Repair it.',filedBy:'agent'});
  const promoted=await promotedTask(f.runtime,await f.runtime.promotePapercutToTask({complexity:'medium',id:cut.id,agent:'planner',note:'Tom authorized',board:false}));
  assert.equal(f.runtime.getPapercut({id:cut.id}).taskId,promoted.taskId);
  assert.equal(f.runtime.store.lead(cut.id).targets[0]?.reference,promoted.taskId);
  assert.equal(f.runtime.getPapercut({id:cut.id}).draftId,null);
  const papercutTask=f.runtime.store.task(promoted.taskId);
  assert.equal(parseNorthstarDocument(papercutTask.brief!.text,'brief').queue_approval,'planner: Tom authorized');
  assert.match(papercutTask.brief!.text,/## Happened\n\nIt failed/);
  const amended=await f.runtime.engine.performTaskControl({taskId:papercutTask.id,version:papercutTask.version,action:'amend_brief',
    brief:`${papercutTask.brief!.text}\nClarify the papercut fix.\n`,reason:'Clarified the fix'});
  assert.equal(amended.briefVersions.length,2);
});

weighted(4)('a lead branch-only edit clears approval and promotion stays bound to the pushed base head',async t=>{
  const f=await fixture(t);
  const lead=await f.runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'Release-line lead',body:text,lanes:[],author:'planner'});
  assert.equal(lead.baseBranch,'main');
  f.runtime.approveLead({id:lead.id,version:lead.version,digest:lead.digest!,approver:'operator (board)',note:'',relayed:false});

  await git(f.repo,'checkout','-b','release/v0.5');
  await git(f.repo,'push','-u','origin','release/v0.5');
  await git(f.repo,'checkout','main');
  const edited=await f.runtime.editLead({id:lead.id,version:lead.version,baseBranch:'release/v0.5',author:'operator'});
  assert.equal(edited.version,2);
  assert.equal(edited.baseBranch,'release/v0.5');
  assert.equal(edited.check,null);
  assert.equal(edited.approval,null);
  await assert.rejects(f.runtime.checkLead({id:lead.id,baseBranch:'main'}),/Edit the lead's baseBranch/);

  const checked=await f.runtime.checkLead({id:lead.id,repository:f.repo,baseBranch:'release/v0.5'});
  const firstHead=await git(f.repo,'rev-parse','refs/remotes/origin/release/v0.5');
  assert.equal(checked.check?.ok,true,checked.check?.message);
  assert.equal(checked.check?.baseBranch,'release/v0.5');
  assert.equal(checked.check?.planningCommit,firstHead);
  f.runtime.approveLead({id:lead.id,version:edited.version,digest:checked.digest!,approver:'operator (board)',note:'',relayed:false});
  const approval=f.runtime.store.lead(lead.id).approval!;
  assert.equal(approval.baseBranch,'release/v0.5');
  assert.equal(approval.planningCommit,firstHead);
  await assert.rejects(f.runtime.promoteLeadToTask({id:lead.id,repository:f.repo,baseBranch:'main',note:'',board:true}),/Edit the lead's baseBranch before promotion/);

  await git(f.repo,'checkout','release/v0.5');
  await writeFile(join(f.repo,'release.txt'),'advance release head');
  await git(f.repo,'add','release.txt');
  await git(f.repo,'commit','-m','advance release base');
  await git(f.repo,'push','origin','release/v0.5');
  const secondHead=await git(f.repo,'rev-parse','HEAD');
  await git(f.repo,'checkout','main');
  assert.notEqual(secondHead,firstHead);
  await assert.rejects(f.runtime.promoteLeadToTask({id:lead.id,repository:f.repo,baseBranch:'release/v0.5',note:'',board:true}),/base branch and head|Approve this lead/);
  assert.equal(f.runtime.store.lead(lead.id).approval,null);
  assert.equal(f.runtime.store.lead(lead.id).check?.planningCommit,secondHead);
  assert.equal(f.runtime.store.lead(lead.id).targets.length,0);

  const fresh=f.runtime.approveLead({id:lead.id,version:edited.version,digest:checked.digest!,approver:'operator (board)',note:'',relayed:false});
  assert.equal(fresh.approval?.planningCommit,secondHead);
  const promoted=await promotedTask(f.runtime,await f.runtime.promoteLeadToTask({id:lead.id,repository:f.repo,baseBranch:'release/v0.5',note:'',board:true}));
  const task=f.runtime.store.task(promoted.taskId);
  assert.equal(task.baseBranch,'release/v0.5');
  assert.equal(task.planningCommit,secondHead);
  assert.equal(await git(f.repo,'branch','--show-current'),'main','checking and promoting the release base leaves the clean main checkout in place');
  assert.equal(await git(f.repo,'status','--porcelain'),'');
});

test('a local lead base that is absent from origin cannot pass its pushed-head check',async t=>{
  const f=await fixture(t);
  await git(f.repo,'checkout','-b','release/unpushed');
  const lead=await f.runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'Unpushed base',body:text,baseBranch:'release/unpushed',lanes:[],author:'planner'});
  assert.equal(lead.check?.ok,false);
  assert.match(lead.check?.message??'',/pushed origin\/release\/unpushed head/);
  assert.equal(f.runtime.store.lead(lead.id).approval,null);
});

weighted(2)('papercut promotion uses its registered checkout after the filing worktree is archived',async t=>{
  const f=await fixture(t);
  f.runtime.store.putRepository({origin:null,path:f.repo},'queue','Registered main checkout');
  const cut=f.runtime.addPapercut({repository:{origin:f.repo,path:f.repo},title:'Archived worker cut',
    happened:'Filed from a worker.',impact:'Promotion must survive cleanup.',filedBy:'worker'});
  const archived=join(f.root,'archived-worker');
  await mkdir(archived); await rm(archived,{recursive:true});
  f.runtime.store.updatePapercut({...cut,repository:{origin:f.repo,path:archived}});
  const request={id:cut.id,agent:'planner',note:'Tom authorized',board:false,complexity:'medium' as const};
  const promoted=await promotedTask(f.runtime,await f.runtime.promotePapercutToTask(request));
  assert.equal(f.runtime.store.task(promoted.taskId).repoPath,f.repo);
  assert.deepEqual(f.runtime.getPapercut({id:cut.id}).repository,{origin:f.repo,path:archived});
  assert.deepEqual(await f.runtime.promotePapercutToTask(request),promoted);
});

weighted(3)('papercut promotion defaults to the saved plan current lane and preserves assigned lanes',async t=>{
  const f=await fixture(t);
  const unassigned=f.runtime.addPapercut({repository:{origin:f.repo,path:f.repo},title:'Unassigned cut',happened:'It failed.',impact:'A user waited.',filedBy:'agent'});
  const assigned=f.runtime.addPapercut({repository:{origin:f.repo,path:f.repo},title:'Assigned cut',happened:'It failed.',impact:'A user waited.',filedBy:'agent'});
  for (const key of ['planned-now','planned-next','papercut-owned']) f.runtime.store.upsertLane({key,title:key,aim:'Fix papercuts.',repositories:[{origin:'acme/fixture',path:f.repo}]});
  f.runtime.store.setPlan({repository:f.repo,version:0,author:'planner',entries:[
    {lane:'planned-now',note:'',horizon:'now'},
    {lane:'planned-next',note:'',horizon:'next'},
  ]});
  f.runtime.setPapercutLanes({id:assigned.id,lanes:['papercut-owned']});

  const inferred=await promotedTask(f.runtime,await f.runtime.promotePapercutToTask({complexity:'medium',id:unassigned.id,note:'',board:true}));
  const explicit=await promotedTask(f.runtime,await f.runtime.promotePapercutToTask({complexity:'medium',id:assigned.id,note:'',board:true}));
  assert.deepEqual(f.runtime.store.task(inferred.taskId).lanes,['planned-now']);
  assert.deepEqual(f.runtime.store.task(explicit.taskId).lanes,['papercut-owned']);
});

test('brief and promoted source task titles over 200 characters are refused',async t=>{
  const f=await fixture(t),longTitle='x'.repeat(201),overlongBrief=text.replace('title: Draft fixture',`title: ${longTitle}`);
  assert.throws(()=>parseNorthstarDocument(overlongBrief,'draft'),/Invalid draft frontmatter: title: Title must be 200 characters or fewer/);
  const lead=await f.runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'Short lead',body:overlongBrief,lanes:[],author:'planner'});
  await assert.rejects(f.runtime.promoteLeadToTask({id:lead.id,note:'',board:true}),/Invalid draft frontmatter: title: Title must be 200 characters or fewer/);
  const cut=f.runtime.addPapercut({repository:{origin:f.repo,path:f.repo},title:longTitle,happened:'It failed.',impact:'A user waited.',filedBy:'planner'});
  await assert.rejects(f.runtime.promotePapercutToTask({complexity:'medium',id:cut.id,note:'',board:true}),/Task title must be 200 characters or fewer/);
  assert.equal(f.runtime.store.tasks().length,0);
});

weighted(2)('Spec 026 row 8: promotion retry and lost response keep one task',async t=>{
  const f=await fixture(t);
  const lead=await f.runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'Draft fixture',body:text,lanes:[],author:'planner'});
  f.runtime.approveLead({id:lead.id,version:1,digest:lead.digest!,approver:'operator (board)',note:'',relayed:false});
  const input={id:lead.id,note:'',board:true};
  const first=await promotedTask(f.runtime,await f.runtime.promoteLeadToTask(input)),again=await promotedTask(f.runtime,await f.runtime.promoteLeadToTask(input));
  assert.equal(first.taskId,again.taskId);
  assert.equal(f.runtime.store.tasks().length,1);
});

weighted(3)('lead and papercut promotion return the same durable operation while their recheck is slow',async t=>{
  const f=await fixture(t),engine=f.runtime.engine,hooks=engine.hooks;
  const lead=await f.runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'Draft fixture',body:text,lanes:[],author:'planner'});
  f.runtime.approveLead({id:lead.id,version:1,digest:lead.digest!,approver:'operator (board)',note:'',relayed:false});
  const originalPreview=hooks.previewPreDispatch.bind(hooks),originalWait=engine.awaitOperation.bind(engine);
  const gatePreview=()=>{
    let enter!:()=>void,release!:()=>void;
    const entered=new Promise<void>(resolve=>{enter=resolve}),gate=new Promise<void>(resolve=>{release=resolve});
    hooks.previewPreDispatch=async (...args)=>{enter();await gate;return originalPreview(...args)};
    engine.awaitOperation=async id=>{await entered;return engine.operationStatus(id)};
    return {entered,release};
  };
  try {
    const leadGate=gatePreview();
    const leadInput={id:lead.id,note:'',board:true};
    const firstLead=await f.runtime.promoteLeadToTask(leadInput);
    assert.ok('accepted' in firstLead);
    assert.equal(firstLead.operation.state,'running');
    const repeatedLead=await f.runtime.promoteLeadToTask(leadInput);
    assert.ok('accepted' in repeatedLead);
    assert.equal(repeatedLead.operation.id,firstLead.operation.id);
    leadGate.release();
    engine.awaitOperation=originalWait;
    const settledLead=await originalWait(firstLead.operation.id,8_000);
    assert.equal(settledLead.state,'succeeded');
    assert.equal(f.runtime.getLeadSummary({id:lead.id}).promotedTaskId,settledLead.result?.taskId);

    const cut=f.runtime.addPapercut({repository:{origin:f.repo,path:f.repo},title:'Cut',happened:'It failed.',impact:'A user waited.',filedBy:'agent'});
    const papercutGate=gatePreview();
    const cutInput={id:cut.id,note:'',board:true,complexity:'medium' as const};
    const firstCut=await f.runtime.promotePapercutToTask(cutInput);
    assert.ok('accepted' in firstCut);
    assert.equal(firstCut.operation.state,'running');
    const repeatedCut=await f.runtime.promotePapercutToTask(cutInput);
    assert.ok('accepted' in repeatedCut);
    assert.equal(repeatedCut.operation.id,firstCut.operation.id);
    papercutGate.release();
    engine.awaitOperation=originalWait;
    assert.equal((await originalWait(firstCut.operation.id,8_000)).state,'succeeded');
    assert.equal(f.runtime.store.tasks().length,2);
  } finally {
    hooks.previewPreDispatch=originalPreview;
    engine.awaitOperation=originalWait;
  }
});

weighted(2)('lead add and edit return the lead with its check operation while a brief check is slow',async t=>{
  const f=await fixture(t),engine=f.runtime.engine,hooks=engine.hooks;
  const originalPreview=hooks.previewPreDispatch.bind(hooks),originalWait=engine.awaitOperation.bind(engine);
  const gates:Array<{entered:Promise<void>;gate:Promise<void>;enter:()=>void;release:()=>void}> = [];
  const makeGate=()=>{
    let enter!:()=>void,release!:()=>void;
    const entered=new Promise<void>(resolve=>{enter=resolve}),gate=new Promise<void>(resolve=>{release=resolve});
    const value={entered,gate,enter,release};gates.push(value);return value;
  };
  let activeGate=makeGate();
  hooks.previewPreDispatch=async(...args)=>{const gate=activeGate;gate.enter();await gate.gate;return originalPreview(...args)};
  engine.awaitOperation=async id=>{const gate=activeGate;await gate.entered;return engine.operationStatus(id)};
  try {
    const adding=f.runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'Slow checked lead',body:text,lanes:[],author:'planner'});
    await activeGate.entered;
    const lead=await adding;
    assert.equal(lead.check,null);
    assert.ok(lead.checkOperationId);
    assert.equal(f.runtime.getLeadSummary({id:lead.id}).checkOperationId,lead.checkOperationId);
    assert.equal(engine.operationStatus(lead.checkOperationId!).state,'running');
    activeGate.release();
    assert.equal((await originalWait(lead.checkOperationId!)).state,'succeeded');
    assert.equal(f.runtime.getLeadSummary({id:lead.id}).check?.ok,true);
    assert.equal(f.runtime.getLeadSummary({id:lead.id}).checkOperationId,null);

    activeGate=makeGate();
    const editing=f.runtime.editLead({id:lead.id,version:lead.version,body:`${text}\n`,author:'planner-2'});
    await activeGate.entered;
    const edited=await editing;
    assert.equal(edited.version,2);
    assert.equal(edited.check,null);
    assert.ok(edited.checkOperationId);
    assert.notEqual(edited.checkOperationId,lead.checkOperationId);
    assert.equal(engine.operationStatus(edited.checkOperationId!).state,'running');
    activeGate.release();
    assert.equal((await originalWait(edited.checkOperationId!)).state,'succeeded');
    const latest=f.runtime.getLeadSummary({id:lead.id});
    assert.equal(latest.check?.ok,true,latest.check?.message);
    assert.equal(latest.checkOperationId,null);
  } finally {
    for(const gate of gates)gate.release();
    hooks.previewPreDispatch=originalPreview;
    engine.awaitOperation=originalWait;
  }
});

test('Spec 026 row 8: a papercut edit during recheck cannot admit stale text',async t=>{
  const f=await fixture(t);
  const cut=f.runtime.addPapercut({repository:{origin:f.repo,path:f.repo},title:'Cut',happened:'Old failure.',impact:'Old impact.',filedBy:'agent'});
  const hooks=f.runtime.engine.hooks,preview=hooks.previewPreDispatch.bind(hooks);
  let entered!:()=>void,release!:()=>void;
  const waiting=new Promise<void>(resolve=>{entered=resolve});
  const gate=new Promise<void>(resolve=>{release=resolve});
  hooks.previewPreDispatch=async (...args)=>{entered();await gate;return preview(...args)};
  t.after(()=>{hooks.previewPreDispatch=preview;release()});
  const pending=f.runtime.promotePapercutToTask({complexity:'medium',id:cut.id,agent:'planner',note:'Tom authorized',board:false});
  await waiting;
  f.runtime.store.updatePapercut({...f.runtime.store.papercut(cut.id),impact:'New impact.'});
  release();
  await assert.rejects(pending,/Papercut changed during promotion/);
  assert.equal(f.runtime.store.tasks().length,0);
});

weighted(2)('Spec 026 row 8a: relayed promotion needs an authorization note; board approval is direct',async t=>{
  const f=await fixture(t);
  const lead=await f.runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'Draft fixture',body:text,lanes:[],author:'planner'});
  await assert.rejects(f.runtime.promoteLeadToTask({id:lead.id,agent:'planner',note:'',board:false}),/authorization note/);
  assert.throws(()=>f.runtime.approveLead({id:lead.id,version:1,digest:lead.digest!,approver:'planner',note:'',relayed:true}),/authorization note/);
  const result=await promotedTask(f.runtime,await f.runtime.promoteLeadToTask({id:lead.id,agent:'planner',note:'Tom authorized',board:false}));
  assert.equal(f.runtime.store.task(result.taskId).leadProvenance?.approval.approver,'planner');
  assert.equal(f.runtime.store.task(result.taskId).leadProvenance?.approval.note,'Tom authorized');
  assert.equal(f.runtime.store.task(result.taskId).leadProvenance?.approval.relayed,true);
  const input=join(f.root,'approval.json');
  await writeFile(input,JSON.stringify({id:'lead',version:1,digest:'sha256:'+ 'a'.repeat(64),approver:'operator (board)',relayed:false}));
  const cli=spawnSync(process.execPath,[new URL('../bin/queue-cli.mjs',import.meta.url).pathname,'lead.approve',input],{encoding:'utf8'});
  assert.notEqual(cli.status,0);assert.match(cli.stderr,/CLI lead approval/);
});

weighted(4)('Spec 026 row 8b: a lead with two repositories needs a target and links each task',async t=>{
  const f=await fixture(t),second=join(f.root,'second');
  await git(f.root,'init','--bare','--initial-branch=main',join(f.root,'second.git'));
  await git(f.root,'clone',join(f.root,'second.git'),second);
  await git(second,'config','user.name','Queue test');await git(second,'config','user.email','queue@example.invalid');
  await mkdir(join(second,'.paseo'),{recursive:true});
  await writeFile(join(second,'.paseo','queue.json'),JSON.stringify({schema:'paseo.queue.control.v5',closeout:'queue',hooks:[]}));
  // A distinct message keeps this head from matching the first repo's identical fixture commit when both land in one clock second.
  await git(second,'add','.');await git(second,'commit','-m','second repository fixture');await git(second,'push','origin','main');
  const lead=await f.runtime.addLead({repositories:[{origin:f.repo,path:f.repo},{origin:second,path:second}],title:'Draft fixture',body:text,lanes:[],author:'planner'});
  f.runtime.approveLead({id:lead.id,version:1,digest:lead.digest!,approver:'operator (board)',note:'',relayed:false});
  await assert.rejects(f.runtime.promoteLeadToTask({id:lead.id,note:'',board:true}),/Select one repository/);
  const a=await promotedTask(f.runtime,await f.runtime.promoteLeadToTask({id:lead.id,repository:f.repo,note:'',board:true}));
  const secondCheck=await f.runtime.checkLead({id:lead.id,repository:second,baseBranch:'main'});
  assert.equal(secondCheck.check?.ok,true,secondCheck.check?.message);
  assert.equal(secondCheck.approval,null,'a different repository head invalidates the first repository approval');
  f.runtime.approveLead({id:lead.id,version:lead.version,digest:secondCheck.digest!,approver:'operator (board)',note:'',relayed:false});
  const b=await promotedTask(f.runtime,await f.runtime.promoteLeadToTask({id:lead.id,repository:second,note:'',board:true}));
  assert.notEqual(a.taskId,b.taskId);
  assert.deepEqual(await f.runtime.promoteLeadToTask({id:lead.id,repository:f.repo,note:'',board:true}),a,'the second repository approval cannot change the first admitted result');
  assert.equal(f.runtime.getLead({id:lead.id}).targets.length,2);
  assert.equal(f.runtime.getLeadSummary({id:lead.id}).promotedTaskId,null);
});

weighted(2)('Spec 026 row 9: failed promotion recheck records refusal and admits nothing',async t=>{
  const f=await fixture(t);
  const lead=await f.runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'Draft fixture',body:text,lanes:[],author:'planner'});
  f.runtime.approveLead({id:lead.id,version:1,digest:lead.digest!,approver:'operator (board)',note:'',relayed:false});
  await f.publish('paseo.queue.control.v4');
  await assert.rejects(f.runtime.promoteLeadToTask({id:lead.id,note:'',board:true}),/Promotion check failed/);
  const current=f.runtime.getLead({id:lead.id});
  assert.equal(current.state,'open');assert.equal(current.check?.ok,false);
  assert.ok(current.approval);assert.equal(f.runtime.store.tasks().length,0);
});

weighted(2)('Spec 026 row 10: failing and new lead versions cannot inherit approval',async t=>{
  const f=await fixture(t);
  const bad=await f.runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'Bad',body:'---\ntitle: Bad\n---\n',lanes:[],author:'planner'});
  assert.equal(bad.check?.ok,false);
  assert.throws(()=>f.runtime.approveLead({id:bad.id,version:1,digest:bad.digest!,approver:'operator (board)',note:'',relayed:false}),/check failed/);
  const fixed=await f.runtime.editLead({id:bad.id,version:1,body:text,author:'planner'});
  assert.equal(fixed.check?.ok,true);
  f.runtime.approveLead({id:bad.id,version:2,digest:fixed.digest!,approver:'operator (board)',note:'',relayed:false});
  const newer=await f.runtime.editLead({id:bad.id,version:2,body:text+'New text.\n',author:'planner-2'});
  assert.equal(newer.approval,null);
  assert.deepEqual(f.runtime.getLead({id:bad.id}).versions.map(v=>v.author),['planner','planner','planner-2']);
});

test('Board keeps brief-bearing leads in Triage and no Drafts view',()=>{
  const ui=boardSource();
  // #868 (20582d59): the lead's Check, Approve and Promote controls live in the shared lead screen.
  const screen=readFileSync(new URL('../client/lead-screen.tsx',import.meta.url),'utf8');
  assert.ok(!ui.includes('text="Drafts"'));
  assert.ok(screen.includes('label="Approve the checked version"'));
  assert.ok(screen.includes('label="Check the brief"'));
  assert.ok(ui.includes('label="Lead detail"'));
  assert.ok(!ui.includes('Lead brief text'));
});


function promotionPayload(runtime: QueueRuntime, id: string, repository: string) {
  const lead=runtime.store.lead(id);
  return sourcePromotionOperationPayloadSchema.parse({type:'source_promote',
    source:{kind:'lead',id,repository,version:lead.version,digest:operationInputHash([lead.version,briefDigest(lead.body)]),approval:lead.approval},
    request:{id,repository,board:true,note:''}});
}
async function replayPromotion(runtime: QueueRuntime, payload: ReturnType<typeof promotionPayload>) {
  const accepted=await runtime.engine.startOperation({key:`fixture-promotion:${randomUUID()}`,kind:'source_promote',payload});
  assert.ok('accepted' in accepted);
  return runtime.engine.awaitOperation(accepted.operation.id,8_000);
}
function approveCurrent(runtime: QueueRuntime, id: string, note='') {
  const lead=runtime.store.lead(id);
  return runtime.approveLead({id,version:lead.version,digest:briefDigest(lead.body),approver:'operator (board)',note,relayed:false});
}

weighted(7)('versioned promotion retains cancelled work and selects each admitted version through every seam',async t=>{
  const f=await fixture(t),runtime=f.runtime,store=runtime.store;
  const lead=await runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'First',body:text,lanes:[],author:'planner'});
  approveCurrent(runtime,lead.id);
  const firstPayload=promotionPayload(runtime,lead.id,f.repo);
  const original=store.promoteSource.bind(store);
  const admissions: Parameters<Store['promoteSource']>[]=[];
  store.promoteSource=(...args)=>{admissions.push(args);return original(...args)};
  const input={id:lead.id,board:true,note:''};
  const first=await promotedTask(runtime,await runtime.promoteLeadToTask(input));
  store.update(first.taskId,{phase:'cancelled',finishedAt:new Date().toISOString(),reason:'Earlier scope cancelled'});
  const oldTask=store.task(first.taskId),oldOutcome=store.outcome(first.taskId),oldTarget=store.lead(lead.id).targets[0];

  await runtime.editLead({id:lead.id,version:1,body:text+'\nNew approved scope.\n',author:'planner'});
  await assert.rejects(runtime.promoteLeadToTask(input),/Approve this lead/);
  assert.equal(store.tasks().length,1);
  approveCurrent(runtime,lead.id);
  const secondPayload=promotionPayload(runtime,lead.id,f.repo);
  const results=await Promise.all(Array.from({length:4},async()=>promotedTask(runtime,await runtime.promoteLeadToTask(input))));
  const second=results[0];
  assert.notEqual(second.taskId,first.taskId);
  assert.ok(results.every(result=>result.taskId===second.taskId));
  assert.equal(store.tasks().length,2);
  assert.deepEqual(store.task(first.taskId),oldTask);
  assert.deepEqual(store.outcome(first.taskId),oldOutcome);
  assert.deepEqual(store.lead(lead.id).targets[0],oldTarget);
  assert.equal(runtime.getLeadSummary({id:lead.id}).promotedTaskId,null);

  // The title advances the source version even when the brief digest is unchanged.
  await runtime.editLead({id:lead.id,version:2,title:'Third version',author:'planner'});
  const third=await promotedTask(runtime,await runtime.promoteLeadToTask({id:lead.id,board:false,agent:'planner',note:'Tom authorized version three'}));
  assert.notEqual(third.taskId,second.taskId);
  assert.notEqual(store.task(third.taskId).submissionId,store.task(second.taskId).submissionId);
  assert.equal(store.task(third.taskId).leadProvenance?.version,3);
  assert.equal(store.task(third.taskId).leadProvenance?.approval.relayed,true);
  assert.equal(store.lead(lead.id).targets.length,3);

  // A lost reply to a historical operation observes its own result, including old payloads.
  delete firstPayload.source.approval;
  for (const [payload,result] of [[firstPayload,first],[secondPayload,second]] as const) {
    const operation=await replayPromotion(runtime,payload);
    assert.equal(operation.state,'succeeded',operation.diagnostic);
    assert.equal(operation.result?.taskId,result.taskId);
  }
  const beforeRetry=store.task(third.taskId);
  for (const [index,result] of [first,second,third].entries()) {
    const repeated=original(...admissions[index]);
    assert.ok('taskId' in repeated);
    assert.equal(repeated.taskId,result.taskId,'atomic admission resolves its selected version before stale mutable source checks');
  }
  assert.deepEqual(store.task(third.taskId),beforeRetry);
  assert.equal(store.tasks().length,3);

  // Rechecking against a new pushed head clears approval but cannot admit v3 twice.
  await writeFile(join(f.repo,'new-head.txt'),'new head');await f.publish();
  await runtime.checkLead({id:lead.id,repository:f.repo});
  assert.equal(store.lead(lead.id).approval,null);
  runtime.setLeadTags({id:lead.id,tags:['checked-again']});
  assert.deepEqual(await runtime.promoteLeadToTask(input),third);
  assert.deepEqual(store.task(third.taskId),beforeRetry);

  // Retention removes live history, but outcome approval still proves v1 without rewriting it.
  assert.ok(store.purgeOldTasks(Date.now()+15*86400000).includes(first.taskId));
  assert.throws(()=>store.task(first.taskId),/purged/);
  const recovered=await replayPromotion(runtime,firstPayload);
  assert.equal(recovered.result?.taskId,first.taskId);
  assert.deepEqual(store.outcome(first.taskId),oldOutcome);
  const atomic=original(...admissions[0]);assert.ok('taskId' in atomic);assert.equal(atomic.taskId,first.taskId);
  assert.deepEqual(store.lead(lead.id).targets[0],oldTarget);
});

weighted(3)('unknown historical target binding refuses narrowly without replacing or rewriting history',async t=>{
  const f=await fixture(t),runtime=f.runtime,store=runtime.store;
  const lead=await runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'Old lead',body:text,lanes:[],author:'planner'});
  approveCurrent(runtime,lead.id);
  const first=await promotedTask(runtime,await runtime.promoteLeadToTask({id:lead.id,board:true,note:''}));
  // Older records may lack the admitted approval. Current version text alone is not proof.
  store.update(first.taskId,{leadProvenance:null});
  await runtime.editLead({id:lead.id,version:1,body:text+'\nNew scope.\n',author:'planner'});
  approveCurrent(runtime,lead.id);
  const before=store.lead(lead.id),task=store.task(first.taskId),versions=store.leadVersions(lead.id);
  await assert.rejects(runtime.promoteLeadToTask({id:lead.id,board:true,note:''}),/Cannot establish admitted lead version/);
  const operation=await replayPromotion(runtime,promotionPayload(runtime,lead.id,f.repo));
  assert.equal(operation.state,'failed');assert.match(operation.diagnostic,/Cannot establish admitted lead version/);
  assert.deepEqual(store.lead(lead.id),before);assert.deepEqual(store.leadVersions(lead.id),versions);
  assert.deepEqual(store.task(first.taskId),task);assert.equal(store.tasks().length,1);
});

weighted(10)('queued promotion refuses changed source, digest or approval without returning an earlier task',async t=>{
  for (const change of ['version','approval','digest'] as const) await t.test(change,async t=>{
    const f=await fixture(t),runtime=f.runtime,store=runtime.store;
    const lead=await runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'Queued',body:text,lanes:[],author:'planner'});
    approveCurrent(runtime,lead.id);
    const first=await promotedTask(runtime,await runtime.promoteLeadToTask({id:lead.id,board:true,note:''}));
    await runtime.editLead({id:lead.id,version:1,body:text+'\nSecond scope.\n',author:'planner'});
    approveCurrent(runtime,lead.id);
    const payload=promotionPayload(runtime,lead.id,f.repo);
    if (change==='digest') payload.source.digest='0'.repeat(64);
    const accepted=await runtime.engine.startOperation({key:`queued:${randomUUID()}`,kind:'source_promote',payload,deferSchedule:true});
    assert.ok('accepted' in accepted);
    if (change==='version') await runtime.editLead({id:lead.id,version:2,body:'Unapproved third scope',author:'planner'});
    if (change==='approval') approveCurrent(runtime,lead.id,'Replaced approval');
    const before=store.lead(lead.id),oldTask=store.task(first.taskId);
    runtime.engine.scheduleAcceptedOperation(accepted.operation.id);
    const result=await runtime.engine.awaitOperation(accepted.operation.id,8_000);
    assert.equal(result.state,'failed');assert.match(result.diagnostic,/changed.*promotion|approval changed/i);
    assert.deepEqual(store.lead(lead.id),before);assert.deepEqual(store.task(first.taskId),oldTask);
    assert.equal(store.tasks().length,1);
  });
});

weighted(2)('unknown source delivery is observed even after approval changes and beyond the inspection page',async t=>{
  const f=await fixture(t),runtime=f.runtime,store=runtime.store;
  const lead=await runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'Unknown',body:text,lanes:[],author:'planner'});
  approveCurrent(runtime,lead.id);
  const payload=promotionPayload(runtime,lead.id,f.repo);
  // Unrelated historical attention must not hide this operation from a bounded list.
  for(let i=0;i<205;i++) {
    const accepted=await runtime.engine.startOperation({key:`attention:${i}`,kind:'source_promote',payload:{...payload,source:{...payload.source,id:`other-${i}`}},deferSchedule:true});
    assert.ok('accepted' in accepted);store.putOperation({...accepted.operation,state:'needs_attention'});
  }
  const accepted=await runtime.engine.startOperation({key:'legacy-unresolved-promotion',kind:'source_promote',payload,deferSchedule:true});
  assert.ok('accepted' in accepted);
  store.putOperation({...accepted.operation,state:'needs_attention',diagnostic:'Lost delivery reply'});
  approveCurrent(runtime,lead.id,'Fresh approval does not erase unknown delivery');
  const observed=await runtime.promoteLeadToTask({id:lead.id,board:true,note:''});
  assert.ok('accepted' in observed);assert.equal(observed.operation.id,accepted.operation.id);
  assert.equal(observed.operation.state,'needs_attention');assert.equal(store.tasks().length,0);
});

weighted(4)('a rolled lead promotion reconciles absence, retries the same version, and keeps a new version separate',async t=>{
  const f=await fixture(t),runtime=f.runtime,store=runtime.store;
  const lead=await runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'Rolled promotion',body:text,lanes:[],author:'planner'});
  approveCurrent(runtime,lead.id);
  const payload=promotionPayload(runtime,lead.id,f.repo);
  const current=store.lead(lead.id);
  const revision=JSON.stringify([current.version,briefDigest(current.body),current.baseBranch,current.approval]);
  const originalKey=`source-promote:${operationInputHash(['lead',lead.id,f.repo,revision])}`;
  const accepted=await runtime.engine.startOperation({key:originalKey,kind:'source_promote',payload,deferSchedule:true});
  assert.ok('accepted' in accepted);
  const interrupted=store.operation(accepted.operation.id)!;
  store.putOperation({...interrupted,state:'running',attempts:1,startedAt:new Date().toISOString(),settledAt:null,
    effect:{kind:'source_promotion',target:interrupted.id,intentAt:new Date().toISOString(),status:'intent',result:null,resultAt:null}});
  store.setMeta(`sourcePromotionOwner:${interrupted.id}`, { pid: 2147483647 }); // A positively absent executor.

  await runtime.drain();
  const restarted=new QueueRuntime({dataDir:f.dataDir,adapterFactory:()=>f.adapter,timers:false});
  t.after(()=>restarted.drain());
  await restarted.started;await restarted.bootstrap;
  assert.equal(restarted.store.operation(accepted.operation.id)?.state,'failed');
  assert.match(restarted.store.operation(accepted.operation.id)?.diagnostic??'',/no task or source insert was committed/);
  const retried=await promotedTask(restarted,await restarted.promoteLeadToTask({id:lead.id,board:true,note:''}));
  assert.equal(restarted.store.tasks().length,1);
  const sourceOperations=restarted.store.operations({limit:1000}).filter(operation=>operation.kind==='source_promote'
    && (restarted.store.operationPayload(operation.id) as {source:{id:string}}).source.id===lead.id);
  assert.equal(sourceOperations.length,2);
  assert.notEqual(sourceOperations.find(operation=>operation.id===accepted.operation.id)?.key,sourceOperations.find(operation=>operation.result?.taskId===retried.taskId)?.key);

  await restarted.editLead({id:lead.id,version:1,body:`${text}\nNew approved scope.\n`,author:'planner'});
  approveCurrent(restarted,lead.id);
  const next=await promotedTask(restarted,await restarted.promoteLeadToTask({id:lead.id,board:true,note:''}));
  assert.notEqual(next.taskId,retried.taskId);
  const nextOperation=restarted.store.operations({limit:1000}).find(operation=>operation.kind==='source_promote'&&operation.result?.taskId===next.taskId)!;
  assert.notEqual(nextOperation.key,sourceOperations.find(operation=>operation.id===accepted.operation.id)?.key);
  assert.equal(restarted.store.tasks().length,2);
});

weighted(3)('a rolled lead promotion with its task committed resolves to that task on restart',async t=>{
  const f=await fixture(t),runtime=f.runtime,store=runtime.store;
  const lead=await runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'Committed promotion',body:text,lanes:[],author:'planner'});
  approveCurrent(runtime,lead.id);
  const task=await promotedTask(runtime,await runtime.promoteLeadToTask({id:lead.id,board:true,note:''}));
  const operation=store.operations({limit:1000}).find(candidate=>candidate.kind==='source_promote'
    && (store.operationPayload(candidate.id) as {source:{id:string}}).source.id===lead.id)!;
  store.putOperation({...operation,state:'running',result:null,settledAt:null,attempts:operation.attempts+1,
    effect:{kind:'source_promotion',target:operation.id,intentAt:new Date().toISOString(),status:'intent',result:null,resultAt:null}});

  await runtime.drain();
  const restarted=new QueueRuntime({dataDir:f.dataDir,adapterFactory:()=>f.adapter,timers:false});
  t.after(()=>restarted.drain());
  await restarted.started;await restarted.bootstrap;
  const recovered=restarted.store.operation(operation.id)!;
  assert.equal(recovered.state,'succeeded');assert.equal(recovered.result?.taskId,task.taskId);
  assert.deepEqual(await restarted.promoteLeadToTask({id:lead.id,board:true,note:''}),task);
  assert.equal(restarted.store.tasks().length,1);
});

weighted(2)('approval changes during pushed-head recheck are refused before source admission',async t=>{
  const f=await fixture(t),runtime=f.runtime,store=runtime.store;
  const lead=await runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'Race',body:text,lanes:[],author:'planner'});
  approveCurrent(runtime,lead.id);
  const hooks=runtime.engine.hooks,preview=hooks.previewPreDispatch.bind(hooks);
  hooks.previewPreDispatch=async(...args)=>{approveCurrent(runtime,lead.id,'Changed during recheck');return preview(...args)};
  t.after(()=>{hooks.previewPreDispatch=preview});
  await assert.rejects(runtime.promoteLeadToTask({id:lead.id,board:true,note:''}),/approval no longer matches/);
  assert.equal(store.tasks().length,0);assert.equal(store.lead(lead.id).targets.length,0);
  assert.equal(store.lead(lead.id).approval?.note,'Changed during recheck');
});

weighted(16)('atomic promotion fences changed version, missing approval, stale head and mismatched digest',async t=>{
  for (const change of ['version','missing','head','digest'] as const) await t.test(change,async t=>{
    const f=await fixture(t),runtime=f.runtime,store=runtime.store;
    const lead=await runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'Atomic race',body:text,lanes:[],author:'planner'});
    approveCurrent(runtime,lead.id);
    const first=await promotedTask(runtime,await runtime.promoteLeadToTask({id:lead.id,board:true,note:''}));
    await runtime.editLead({id:lead.id,version:1,body:text+'\nNew scope.\n',author:'planner'});
    approveCurrent(runtime,lead.id);
    const prior=store.task(first.taskId),priorTargets=store.lead(lead.id).targets;
    const original=store.promoteSource.bind(store);
    store.promoteSource=(...args)=>{
      const current=store.lead(lead.id);
      const next=change==='version'?{...current,version:current.version+1}
        :{...current,approval:change==='missing'?null:{...current.approval!,
          ...(change==='head'?{planningCommit:'0'.repeat(40)}:{digest:'sha256:'+'0'.repeat(64)})}};
      store.updateLead(next);
      const snapshot=store.lead(lead.id);
      assert.throws(()=>original(...args),/changed during promotion/);
      // Even a caller with the new snapshot cannot submit the old admitted approval.
      args[3]=operationInputHash(snapshot);
      try { return original(...args); }
      finally { assert.deepEqual(store.lead(lead.id),snapshot); }
    };
    await assert.rejects(runtime.promoteLeadToTask({id:lead.id,board:true,note:''}),/approval or check changed/);
    assert.equal(store.tasks().length,1);assert.deepEqual(store.task(first.taskId),prior);
    assert.deepEqual(store.lead(lead.id).targets,priorTargets);
  });
});

weighted(2)('papercut edits preserve the original task through request, operation and atomic retries',async t=>{
  const f=await fixture(t),runtime=f.runtime,store=runtime.store;
  const cut=runtime.addPapercut({repository:{origin:f.repo,path:f.repo},title:'Cut',happened:'Failure',impact:'Wait',filedBy:'planner'});
  const original=store.promoteSource.bind(store);
  let admission!:Parameters<Store['promoteSource']>;
  store.promoteSource=(...args)=>{admission=args;return original(...args)};
  const input={id:cut.id,board:true,note:'',complexity:'medium' as const};
  const first=await promotedTask(runtime,await runtime.promotePapercutToTask(input));
  const operation=store.operations().find(op=>op.kind==='source_promote')!;
  const payload=sourcePromotionOperationPayloadSchema.parse(store.operationPayload(operation.id));
  runtime.editPapercut({id:cut.id,version:1,title:'Edited cut',impact:'Updated impact',author:'planner'});
  const before=store.task(first.taskId);
  assert.deepEqual(await runtime.promotePapercutToTask(input),first);
  assert.deepEqual(await runtime.promoteLeadToTask(input),first);
  assert.equal((await replayPromotion(runtime,payload)).result?.taskId,first.taskId);
  const atomic=original(...admission);assert.ok('taskId' in atomic);assert.equal(atomic.taskId,first.taskId);
  assert.equal(store.tasks().length,1);assert.deepEqual(store.task(first.taskId),before);
});

test('Spec 053: a lead brief without queue.complexity fails its check; a papercut promotion names one; a lead promotion cannot override its brief',async t=>{
  const f=await fixture(t);
  const bare=text.replace('  complexity: medium\n','');
  assert.notEqual(bare,text);
  const lead=await f.runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'No complexity',body:bare,lanes:[],author:'planner'});
  assert.equal(lead.check?.ok,false);
  assert.match(lead.check!.message,/queue\.complexity is required/);
  const named=await f.runtime.editLead({id:lead.id,version:lead.version,body:text,author:'planner'});
  assert.equal(named.check?.ok,true);
  f.runtime.approveLead({id:lead.id,version:named.version,digest:named.digest!,approver:'operator (board)',note:'',relayed:false});
  await assert.rejects(f.runtime.promoteLeadToTask({id:lead.id,note:'',board:true,complexity:'high'} as never),/names its complexity in its brief/);
  const cut=f.runtime.addPapercut({repository:{origin:f.repo,path:f.repo},title:'Cut without complexity',happened:'It failed.',impact:'A user waited.',filedBy:'agent'});
  await assert.rejects(f.runtime.promotePapercutToTask({id:cut.id,note:'',board:true}),/queue\.complexity is required/);
  const promoted=await promotedTask(f.runtime,await f.runtime.promotePapercutToTask({id:cut.id,note:'',board:true,complexity:'low'}));
  assert.equal(f.runtime.store.task(promoted.taskId).complexity,'low');
});

test('Spec 053 (review #597): promotions Queue accepted before the requirement replay; review entry needs complexity on first acceptance',async t=>{
  const f=await fixture(t);
  // A papercut promotion accepted before Spec 053 required complexity: no request.complexity, and its generated brief names none.
  const cut=f.runtime.addPapercut({repository:{origin:f.repo,path:f.repo},title:'Legacy accepted cut',happened:'It failed.',impact:'A user waited.',filedBy:'agent'});
  const legacy=sourcePromotionOperationPayloadSchema.parse({type:'source_promote',
    source:{kind:'papercut',id:cut.id,repository:f.repo,version:null,digest:storeDigest(JSON.stringify(f.runtime.store.papercut(cut.id)))},
    request:{id:cut.id,repository:f.repo,board:true,note:''}});
  const accepted=await f.runtime.engine.startOperation({key:`legacy-papercut:${randomUUID()}`,kind:'source_promote',payload:legacy,deferSchedule:true});
  assert.ok('accepted' in accepted);
  // A retry while it is unfinished reuses it instead of refusing for the missing complexity.
  const retried=await f.runtime.promotePapercutToTask({id:cut.id,note:'',board:true});
  const settled='accepted' in retried?await f.runtime.engine.awaitOperation(retried.operation.id,8_000):null;
  const taskId=settled?settled.result?.taskId:(retried as {taskId:string}).taskId;
  assert.ok(taskId,`the accepted promotion replays to a task (${settled?.state}: ${settled?.diagnostic ?? ''})`);
  if (settled) assert.equal(settled.id,accepted.operation.id,'the unfinished operation is reused');
  assert.equal(f.runtime.store.task(taskId!).complexity ?? null,null,'a grandfathered task keeps no complexity (selection counts it as medium)');

  // Review entry creates a new task and refuses first acceptance without complexity.
  const submission={submissionId:`review-entry-${randomUUID()}`,title:'Review entry',repoPath:f.repo,planningCommit:'a'.repeat(40),handoffPath:'h.md',originAgentId:'origin'};
  await assert.rejects(f.runtime.operationStart({key:`review-entry:${submission.submissionId}`,kind:'review_entry',payload:{type:'review_entry',input:{submission}}} as never),/queue\.complexity is required/);
});

weighted(3)('host reconnect leaves an in-flight promotion unsettled until its own commit', async t => {
  const f=await fixture(t), runtime=f.runtime;
  const lead=await runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'Live promotion',body:text,lanes:[],author:'planner'});
  approveCurrent(runtime,lead.id);
  const payload=promotionPayload(runtime,lead.id,f.repo);
  let resume!:()=>void, entered!:()=>void;
  const gate=new Promise<void>(resolve=>{resume=resolve}), started=new Promise<void>(resolve=>{entered=resolve});
  const execute=Reflect.get(runtime,'executeSourcePromotion').bind(runtime);
  runtime.engine.setSourcePromotionHandler(async (value,host,selection)=>{entered();await gate;return execute(value,host,selection)});
  try {
    const accepted=await runtime.engine.startOperation({key:`live:${randomUUID()}`,kind:'source_promote',payload});
    assert.ok('accepted' in accepted); await started;
    runtime.engine.resumeOperations(false);
    runtime.engine.resumeOperations(); // Even a bootstrap overlapping a live handler cannot prove absence.
    const pending=runtime.store.operation(accepted.operation.id)!;
    assert.equal(pending.state,'running');
    assert.equal(pending.effect?.status,'uncertain');
    assert.match(pending.diagnostic,/outcome is uncertain/);
    assert.doesNotMatch(pending.diagnostic,/no task or source insert was committed/);
    resume();
    const settled=await runtime.engine.awaitOperation(accepted.operation.id,8000);
    assert.equal(settled.state,'succeeded',settled.diagnostic);
    assert.ok(settled.result?.taskId);
    assert.equal(runtime.store.tasks().length,1);
  } finally { resume(); }
});

weighted(2)('an interrupted legacy promotion without executor identity stays uncertain', async t => {
 const f=await fixture(t), runtime=f.runtime, store=runtime.store;
 const lead=await runtime.addLead({repositories:[{origin:f.repo,path:f.repo}],title:'Unknown owner',body:text,lanes:[],author:'planner'});
 approveCurrent(runtime,lead.id);
 const payload=promotionPayload(runtime,lead.id,f.repo);
 const accepted=await runtime.engine.startOperation({key:`unknown-owner:${randomUUID()}`,kind:'source_promote',payload,deferSchedule:true});
 assert.ok('accepted' in accepted);
 const operation=accepted.operation;
 store.putOperation({...operation,state:'running',attempts:1,startedAt:new Date().toISOString(),
   effect:{kind:'source_promotion',target:operation.id,intentAt:new Date().toISOString(),status:'intent',result:null,resultAt:null}});
 runtime.engine.reconcileSourcePromotion(store.operation(operation.id)!);
 const observed=store.operation(operation.id)!;
 assert.equal(observed.state,'needs_attention');
 assert.equal(observed.effect?.status,'uncertain');
 assert.match(observed.diagnostic,/may still commit/);
 assert.equal(store.tasks().length,0);
});
