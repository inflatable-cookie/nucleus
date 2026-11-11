import { toolTimelinePage } from './tool-timeline';
import assert from "node:assert/strict";
import {mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {reviewEntryInputSchema,reviewEntryRecordSchema,submissionSchema,type Completion,type Profile,type Run,type Task} from "../../shared/contracts";
import {Store,digest,now,operationInputHash} from "../../core/store/store";
import {normalizeRepositoryOrigin} from "../../shared/lanes";
import {bindReviewEntry,type ReviewEntryAdapter} from "../../core/review/review-entry";
import {briefDigest} from "../../core/planning/brief";
import {hookRecordSchema,type HookRecord} from "../../shared/hooks";
import {holdPatch} from "../../core/merge/merge-hold";
import {Engine} from "../../core/engine";
import {QueueRuntime} from "../../service/runtime-owner";
import {type Adapter,type AgentObservation} from "../../core/host";
import type {ResolutionAdapter} from "../../core/resolution";
import {queueOperationSchema,type QueueOperation} from "../../shared/operations";


export const base='b'.repeat(40),head='a'.repeat(40),operationId='c'.repeat(64);
export const submission=()=>submissionSchema.parse({submissionId:'external-pr',title:'External PR',repoPath:'/repo',planningCommit:base,handoffPath:'docs/handoff.md',originAgentId:'origin'});
export const input=()=>reviewEntryInputSchema.parse({submission:submission(),workspaceId:'workspace',prNumber:41,expectedBranch:'feature/external',expectedHead:head,expectedBaseCommit:base,authority:'Operator approved takeover',authorDeclaration:{models:['OpenAI/GPT-5','openai/gpt-5'],githubAuthor:'external-author',authoringSystem:'external-agent',attestedBy:'operator',provenance:'Provider records and author report'}});
export const record=()=>reviewEntryRecordSchema.parse({operationId,prNumber:41,repository:'example/repo',branch:'feature/external',workspaceId:'workspace',verifiedHead:head,verifiedBase:base,planningCommit:base,authority:'Operator approved takeover',authorDeclaration:input().authorDeclaration,checkedAt:new Date().toISOString(),preserveWorkspace:true});
/**
 * The disposable bare origin. Admission reads the configured GitHub URL; insteadOf
 * routes its transport here, and `git remote get-url` reports this path, which
 * still normalizes to the recorded example/repo.
 */
export const hostedOrigin=(root:string)=>join(root,'github.com','example','repo.git');
export const runGit=(cwd:string,...args:string[])=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
export function exactProofFixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'ns-review-entry-proof-'))),origin=hostedOrigin(root),repo=join(root,'repo'),workspace=join(root,'workspace');
  execFileSync('git',['init','--bare',origin],{stdio:'ignore'});execFileSync('git',['init','-b','main',repo],{stdio:'ignore'});
  runGit(repo,'config','user.name','Queue Fixture');runGit(repo,'config','user.email','queue@example.test');
  mkdirSync(join(repo,'docs'));writeFileSync(join(repo,'docs','handoff.md'),'fixture handoff\n');writeFileSync(join(repo,'README.md'),'base\n');
  runGit(repo,'add','.');runGit(repo,'commit','-m','planning');const planningCommit=runGit(repo,'rev-parse','HEAD');
  runGit(repo,'remote','add','origin',origin);runGit(repo,'push','-u','origin','main');
  runGit(repo,'worktree','add','-b','feature/external',workspace,'main');
  writeFileSync(join(workspace,'README.md'),'external change\n');runGit(workspace,'add','README.md');runGit(workspace,'commit','-m','external implementation');
  const expectedHead=runGit(workspace,'rev-parse','HEAD');runGit(workspace,'push','-u','origin','feature/external');
  const githubRemote='ssh://git@github.com/example/repo.git';runGit(repo,'config','remote.origin.url',githubRemote);runGit(repo,'config',`url.${origin}.insteadOf`,githubRemote);
  const reviewInput=reviewEntryInputSchema.parse({submission:{submissionId:'proof-fixture',title:'Proof fixture',repoPath:repo,planningCommit,handoffPath:'docs/handoff.md',originAgentId:'origin'},workspaceId:'workspace',prNumber:41,expectedBranch:'feature/external',expectedHead,expectedBaseCommit:planningCommit,authority:'Operator approved takeover',authorDeclaration:{models:['openai/gpt-5'],githubAuthor:'external-author',authoringSystem:'external-agent',attestedBy:'operator',provenance:'Fixture attestation'}});
  const adapter:ReviewEntryAdapter={hostId:'host',inspectReviewEntry:async()=>({directory:workspace,originWorkspaceId:'origin-workspace',busyReason:''}),originAgent:async id=>({id,workspaceId:'origin-workspace',title:'Origin',archived:false}),reviewEntryGithubCommand:async(_file,args)=>args[1].includes('/pulls/')?JSON.stringify({state:'open',merged_at:null,draft:false,head:{repo:{full_name:'example/repo'},ref:'feature/external',sha:expectedHead},base:{repo:{full_name:'example/repo'},ref:'main'},user:{login:'external-author'},html_url:'https://github.com/example/repo/pull/41'}):JSON.stringify({permissions:{push:true}})};
  return {root,repo,workspace,planningCommit,expectedHead,reviewInput,adapter};
}
export function queueHeldBriefFixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'ns-review-entry-brief-'))),origin=hostedOrigin(root),repo=join(root,'repo'),workspace=join(root,'workspace');
  execFileSync('git',['init','--bare',origin],{stdio:'ignore'});execFileSync('git',['init','-b','main',repo],{stdio:'ignore'});
  runGit(repo,'config','user.name','Queue Fixture');runGit(repo,'config','user.email','queue@example.test');
  writeFileSync(join(repo,'README.md'),'base\n');runGit(repo,'add','.');runGit(repo,'commit','-m','planning');const planningCommit=runGit(repo,'rev-parse','HEAD');
  runGit(repo,'remote','add','origin',origin);runGit(repo,'push','-u','origin','main');runGit(repo,'worktree','add','-b','feature/external',workspace,'main');
  writeFileSync(join(workspace,'feature.txt'),'external change\n');runGit(workspace,'add','feature.txt');runGit(workspace,'commit','-m','external implementation');
  const expectedHead=runGit(workspace,'rev-parse','HEAD');runGit(workspace,'push','-u','origin','feature/external');
  const githubRemote='ssh://git@github.com/example/repo.git';runGit(repo,'config','remote.origin.url',githubRemote);runGit(repo,'config',`url.${origin}.insteadOf`,githubRemote);
  const briefText='Queue-held review scope: inspect PR 41 and retain the existing checkout.\n',approval={version:1,digest:briefDigest(briefText),approver:'operator (board)',approvedAt:new Date().toISOString(),note:'Checked scope',relayed:false};
  const reviewInputBase={submission:{submissionId:'brief-review',title:'Queue-held brief review',repoPath:repo,planningCommit,handoffPath:'',brief:{text:briefText,mediaType:'text/markdown',digest:approval.digest},originAgentId:'origin',planningSource:{kind:'lead' as const,id:'approved-review-brief'},leadProvenance:{version:1,approval,earlierDigests:[]}},workspaceId:'isolated-workspace',prNumber:41,expectedBranch:'feature/external',expectedHead,expectedBaseCommit:planningCommit,authority:'Authorize independent review of the existing PR',workspaceOwnership:'external' as const,workspaceMode:'shared_canonical' as const,authorDeclaration:{models:['openai/gpt-5'],githubAuthor:'external-author',authoringSystem:'external-agent',attestedBy:'operator',provenance:'Checked Queue-held brief and reported author identity'}};
  const reviewInput=reviewEntryInputSchema.parse(reviewInputBase);
  let inspections=0,githubCalls=0;
  const adapter:ReviewEntryAdapter={hostId:'host',inspectReviewEntry:async()=>{inspections++;return{directory:workspace,originWorkspaceId:'origin-workspace',busyReason:''};},originAgent:async id=>({id,workspaceId:'origin-workspace',title:'Origin',archived:false}),reviewEntryGithubCommand:async(_file,args)=>{githubCalls++;return args[1].includes('/pulls/')?JSON.stringify({state:'open',merged_at:null,draft:false,head:{repo:{full_name:'example/repo'},ref:'feature/external',sha:expectedHead},base:{repo:{full_name:'example/repo'},ref:'main'},user:{login:'external-author'},html_url:'https://github.com/example/repo/pull/41'}):JSON.stringify({permissions:{push:true}});}};
  return {root,repo,workspace,planningCommit,expectedHead,briefText,approval,reviewInput,adapter,get inspections(){return inspections;},get githubCalls(){return githubCalls;}};
}
export function approveBrief(store:Store,fixture:ReturnType<typeof queueHeldBriefFixture>,papercut=false){
  const stamp=new Date().toISOString(),digest=fixture.approval.digest;
  store.addLead({id:'approved-review-brief',title:'Approved review scope',body:fixture.briefText,repositories:[{origin:'https://github.com/example/repo',path:fixture.repo}],lanes:[],tags:papercut?['papercut']:[],papercut:papercut?{area:null,happened:'Wait',impact:'Time',fix:null,source:null,draftId:null}:null,closure:null,author:'operator',state:'open',version:1,digest,
    check:{ok:true,message:'Checked against pushed planning',checkedAt:stamp,planningCommit:fixture.planningCommit},approval:fixture.approval,originAgentId:'origin',baseBranch:'main',dropReason:null,targets:[],source:null,createdAt:stamp,updatedAt:stamp,closedAt:null},'operator');
}

/** Accepted review entry held in needs_attention, shaped like a legacy operation with prose-only attention. */
export function heldReviewEntry(store:Store,fixture:ReturnType<typeof exactProofFixture>,key:string,overrides:Partial<QueueOperation>={}){
  const acceptance=store.acceptOperation({key,kind:'review_entry',inputHash:operationInputHash({type:'review_entry',input:fixture.reviewInput}),
    submissionId:fixture.reviewInput.submission.submissionId,repoPath:fixture.repo,hostId:fixture.adapter.hostId,payload:{type:'review_entry',input:fixture.reviewInput}});
  if(!('accepted' in acceptance))throw Error('Fixture acceptance was backpressured');
  return store.putOperation({...acceptance.operation,state:'needs_attention',attempts:1,settledAt:now(),
    diagnostic:'Origin author thread origin still has an active or uncertain turn',...overrides});
}

/** A workerless review-entry task with a project owner, a dispatch fence and a revisable pushed head. */
export function ownerRevisionFixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'ns-owner-revision-'))),origin=hostedOrigin(root),repo=join(root,'repo'),workspace=join(root,'workspace');
  execFileSync('git',['init','--bare',origin],{stdio:'ignore'});execFileSync('git',['init','-b','main',repo],{stdio:'ignore'});
  runGit(repo,'config','user.name','Queue Fixture');runGit(repo,'config','user.email','queue@example.test');
  mkdirSync(join(repo,'docs'));writeFileSync(join(repo,'docs','handoff.md'),'fixture handoff\n');writeFileSync(join(repo,'README.md'),'base\n');
  runGit(repo,'add','.');runGit(repo,'commit','-m','planning');const planningCommit=runGit(repo,'rev-parse','HEAD');
  runGit(repo,'remote','add','origin',origin);runGit(repo,'push','-u','origin','main');
  runGit(repo,'worktree','add','-b','feature/external',workspace,'main');
  writeFileSync(join(workspace,'feature.txt'),'external change\n');runGit(workspace,'add','feature.txt');runGit(workspace,'commit','-m','external implementation');
  const oldHead=runGit(workspace,'rev-parse','HEAD');runGit(workspace,'push','-u','origin','feature/external');
  const githubRemote='ssh://git@github.com/example/repo.git';runGit(repo,'config','remote.origin.url',githubRemote);runGit(repo,'config',`url.${origin}.insteadOf`,githubRemote);
  const reviewInput=reviewEntryInputSchema.parse({submission:{submissionId:'owner-revision',title:'Owner revision fixture',repoPath:repo,planningCommit,handoffPath:'docs/handoff.md',originAgentId:'origin'},workspaceId:'workspace',prNumber:41,expectedBranch:'feature/external',expectedHead:oldHead,expectedBaseCommit:planningCommit,authority:'Operator approved takeover',authorDeclaration:{models:['openai/gpt-5'],githubAuthor:'external-author',authoringSystem:'external-agent',attestedBy:'operator',provenance:'Fixture attestation'}});
  const owner='owner-thread',reviewer:Profile={id:'reviewer',name:'Reviewer',provider:'test',model:'reviewer-model',notes:'',available:true,problem:'',supportedThinking:[]};
  // Task 408: the same PR may be merged outside Queue. `mergeCommit` is the
  // merge commit the forge reports while merged; `onMerge`/`onObserve` let a
  // test mutate one fact inside an awaited proof.
  const state={loseAgentReply:false,prSha:oldHead,prAuthor:'external-author',busyReason:'',busyTransient:undefined as boolean|undefined,onPull:null as null|(()=>void),onRepo:null as null|(()=>void),
    merged:false,mergeCommit:null as string|null,onMerge:null as null|(()=>void),onObserve:null as null|((id:string)=>void),
    // An admitted adapter's method overrides capture their delegate at
    // construction, so a test that needs the REAL proof swaps this hook rather
    // than the proxy's method (task 408 identity coverage).
    externalMergeImpl:null as null|((task:Task,acceptHead:boolean|undefined)=>Promise<{head:string;commit:string}|null>)};
  const prResponse=()=>JSON.stringify({state:state.merged?'closed':'open',merged_at:state.merged?'2026-10-24T10:00:00Z':null,
    ...(state.merged&&state.mergeCommit?{merge_commit_sha:state.mergeCommit}:{}),draft:false,
    head:{repo:{full_name:'example/repo'},ref:'feature/external',sha:state.prSha},base:{repo:{full_name:'example/repo'},ref:'main'},user:{login:state.prAuthor},html_url:'https://github.com/example/repo/pull/41'});
  const workspaceHead=()=>runGit(workspace,'rev-parse','HEAD');
  const states=new Map<string,AgentObservation>([[owner,{id:owner,workspaceId:'origin-workspace',status:'idle',active:false,permissions:false,error:'',model:'openai/gpt-5',provider:'openai'}]]);
  const creates:Run[]=[];
  const tokens=new Map<string,string>();
  let store=new Store(join(root,'queue.sqlite'));
  /**
   * The mocked remote identity every flow reads: one adapter per engine or
   * runtime, sharing the fixture's Git state and observation map. The callback
   * socket and helper live inside the fixture root so a real runtime can bind
   * its own callback surface without touching host paths.
   */
  const archivedAgents = new Set<string>();
  let adapterCount=0;
  const buildAdapter=()=>{
    const count=++adapterCount,tag=`${count}-${randomUUID()}`,socketTag=`${count}-${randomUUID().slice(0,8)}`;
    const adapter:ReviewEntryAdapter&ResolutionAdapter&Partial<Adapter>
      &{socketPath:string;helperPath:string;connect:()=>Promise<void>;close:()=>Promise<void>}={
      // Unix socket paths are length-bounded on macOS; keep the bound socket name short.
      hostId:'host',socketPath:join(root,`cb-${socketTag}.sock`),helperPath:join(root,`worker-report-${tag}.mjs`),
      connect:async()=>{},close:async()=>{},
      inspectReviewEntry:async()=>({directory:workspace,originWorkspaceId:'origin-workspace',busyReason:state.busyReason,...(state.busyTransient===undefined?{}:{busyTransient:state.busyTransient})}),
      originAgent:async id=>({id,workspaceId:'origin-workspace',title:'Origin',archived:archivedAgents.has(id)}),
      reviewEntryGithubCommand:async(_file,args)=>{
        if(args[1]?.includes('/pulls/')){state.onPull?.();return prResponse();}
        state.onRepo?.();return JSON.stringify({permissions:{push:true}});
      },
      // Profiles route from the Queue store through the host catalog (#870): the catalog lists the reviewer's model.
      catalog:async()=>({providers:[{key:reviewer.provider,label:'test',available:true,problem:'',models:[{id:reviewer.model,label:reviewer.model,aliases:[],thinkingOptions:[],defaultThinkingOptionId:null,modes:[],features:[]}]}]}),
      validate:async()=>planningCommit,
      createWorkspace:async()=>{throw Error('must preserve workspace')},findWorkspaces:async()=>[],verifyWorkspace:async()=>'feature/external',
      createAgent:async()=>{throw Error('no initial worker')},findAgents:async()=>[],
      observe:async id=>{state.onObserve?.(id);return states.get(id)??{id,workspaceId:'workspace',status:'idle',active:false,permissions:false,error:''};},
      // The merged-state proof the real forge gives the external-merge route:
      // the canonical merged head (the published branch head the workspace
      // holds) and the merge commit, never a caller-supplied head.
      externalMerge:async(task,acceptHead)=>{
        if(state.externalMergeImpl)return state.externalMergeImpl(task,acceptHead);
        state.onMerge?.();
        if(!state.merged)return null;
        const head=workspaceHead();
        if(!acceptHead)throw Error('External merge head differs from recorded task work');
        return {head,commit:String(state.mergeCommit??'')};
      },
      agentTimeline:async()=>[],
      // A complete page built from agentTimeline, so per-test overrides of agentTimeline still apply.
      async agentTimelinePage(id:string){const entries=await (this as {agentTimeline(id:string):Promise<unknown[]|null>}).agentTimeline(id);
        return entries?toolTimelinePage(entries as never):null;},
      archiveAgent:async id=>{archivedAgents.add(id);},verifyPr:async()=>({url:'https://github.com/example/repo/pull/41',head:workspaceHead(),repository:'example/repo',headRepository:'example/repo'}),
      verifyPrIdentity:async()=>({url:'https://github.com/example/repo/pull/41',head:workspaceHead(),repository:'example/repo',headRepository:'example/repo'}),
      coveringEvidence:async t=>({head:t.prHead!,base:t.resolution.mergeBase??t.planningBase,wait:''}),
      createRun:async(_task,run,token)=>{tokens.set(run.id,token);const id=creates.length ? `review-agent-${run.id}` : 'review-agent';creates.push(run);states.set(id,{id,workspaceId:run.workspaceId,status:'running',active:true,permissions:false,error:'',model:'reviewer-model'});if(state.loseAgentReply){state.loseAgentReply=false;throw Error('lost agent reply');}return{id,workspaceId:run.workspaceId}},
      sendRun:async()=>{},findRunAgents:async run=>creates.filter(created=>created.id===run.id).map(created=>({id:creates.indexOf(created) ? `review-agent-${run.id}` : 'review-agent',workspaceId:run.workspaceId})),verifyReview:async()=>{},
      mergeGate:async()=>({head:workspaceHead(),base:planningCommit,wait:''}),merge:async()=>{},
      merged:async()=>({merged:false,commit:null,head:workspaceHead(),base:'main'}),syncMain:async()=>planningCommit,
      verifyCloseout:async()=>{},notify:async()=>{},
    };
    return adapter as Adapter&ReviewEntryAdapter;
  };
  const buildEngine=(overrides:Partial<Adapter&ResolutionAdapter&ReviewEntryAdapter>={})=>{
    // A test that needs the REAL adapter method (the installed Paseo inspection,
    // for example) composes it over the fixture's otherwise mocked surface.
    const adapter={...buildAdapter(),...overrides} as Adapter&ResolutionAdapter&ReviewEntryAdapter;
    const engine=new Engine(store,adapter,0);engine.profiles=[reviewer];
    return {engine,adapter};
  };
  /**
   * The real public runtime owner over an isolated store: `taskControl` here
   * persists the durable `task_control` operation before the engine performs
   * it, exactly as `queue.task` does in production (task 404).
   */
  const buildRuntime=()=>{
    // Queue #912: a runtime registers its host only when the adapter's client reports connected (`hostConnected`);
    // without it every host-routed control waits for the host instead of refusing.
    const runtime=new QueueRuntime({dataDir:join(root,`runtime-${randomUUID()}`),adapterFactory:()=>({...buildAdapter(),client:{isConnected:true}}),timers:false});
    return runtime;
  };
  const pushRevision=(message='owner revised source')=>{
    writeFileSync(join(workspace,'feature.txt'),`${message}\n`);runGit(workspace,'add','feature.txt');runGit(workspace,'commit','-m',message);
    const head=workspaceHead();runGit(workspace,'push','origin','feature/external');state.prSha=head;return head;
  };
  /**
   * The PR merged outside Queue at a published descendant of the recorded head:
   * one real merge commit on the integration branch, the PR head at the merged
   * source, and the workspace on that clean merged head.
   */
  const mergeExternally=(message='external merge outside Queue')=>{
    const head=pushRevision(message);
    runGit(repo,'fetch','origin','feature/external');
    runGit(repo,'merge','--ff-only','origin/feature/external');
    const mergeCommit=runGit(repo,'rev-parse','HEAD');
    state.merged=true;state.mergeCommit=mergeCommit;state.prSha=head;
    return {head,mergeCommit};
  };
  const close=()=>{store.close();rmSync(root,{recursive:true,force:true});};
  /** One normal process restart: the same durable database file reopened by a fresh store. */
  const reopen=()=>{store.close();store=new Store(join(root,'queue.sqlite'));};
  return {root,repo,workspace,planningCommit,oldHead,reviewInput,owner,reviewer,states,creates,tokens,state,workspaceHead,pushRevision,mergeExternally,buildEngine,buildAdapter,buildRuntime,reopen,get store(){return store;},close};
}
/** Bind the fixture task, record old reviewer evidence and place the root-owned gen1 dispatch fence. */
export async function ownedRevisableTask(f:ReturnType<typeof ownerRevisionFixture>,options:{acceptedReview?:boolean;blockedReport?:boolean;blockedCompletion?:Partial<Completion>;projectOwner?:string;briefText?:string}={}){
  const store=f.store,{engine,adapter}=f.buildEngine();
  store.setMeta('paused',false);
  store.setMeta('pool',[{profileId:'reviewer',enabled:true,group:'reviewers',roles:['reviewer'],weight:1,scopes:['general']}]);
  const operation=queueOperationSchema.parse({id:'c'.repeat(64),key:'owner-revision-intake',kind:'review_entry',inputHash:'d'.repeat(64),hostId:'host',state:'running',taskId:null,expectedVersion:null,repoPath:f.repo,submissionId:'owner-revision',createdAt:now(),startedAt:now(),settledAt:null,attempts:1,diagnostic:'',result:null,effect:null});
  // A Queue-held brief replaces the committed handoff: exactly one instruction
  // source with the operator's approved lead, bound through the same real
  // review-entry path.
  let reviewInput=f.reviewInput;
  if(options.briefText){
    const stamp=new Date().toISOString(),approval={version:1,digest:briefDigest(options.briefText),approver:'operator (board)',approvedAt:stamp,note:'Checked scope',relayed:false};
    store.addLead({id:'approved-review-brief',title:'Approved review scope',body:options.briefText,
      repositories:[{origin:'https://github.com/example/repo',path:f.repo}],lanes:[],tags:[],papercut:null,closure:null,author:'operator',
      state:'open',version:1,digest:approval.digest,check:{ok:true,message:'Checked against pushed planning',checkedAt:stamp,planningCommit:f.planningCommit},
      approval,originAgentId:'origin',baseBranch:'main',dropReason:null,targets:[],source:null,createdAt:stamp,updatedAt:stamp,closedAt:null},'operator');
    reviewInput=reviewEntryInputSchema.parse({...f.reviewInput,submission:{...f.reviewInput.submission,handoffPath:'',
      brief:{text:options.briefText,mediaType:'text/markdown',digest:approval.digest},
      planningSource:{kind:'lead',id:'approved-review-brief'},leadProvenance:{version:1,approval,earlierDigests:[]}}});
  }
  const task=await bindReviewEntry(store,adapter,operation,reviewInput,'host');
  const project=store.projectFor(task.repoPath,normalizeRepositoryOrigin(task.repository??''))!;
  store.setProjectPlanner({key:project.key,agentId:options.projectOwner??f.owner,setBy:'test',note:'Current project planner'});
  if(options.acceptedReview){
    const completion:Completion={eventId:'old-review-event',taskId:task.id,runId:'old-review-run',status:'ready_to_merge',summary:'Original exact-head approval',head:f.oldHead,reviewCommentId:7};
    const run:Run={id:'old-review-run',taskId:task.id,role:'reviewer',generation:1,head:f.oldHead,base:f.planningCommit,agentId:'old-reviewer',workspaceId:task.workspaceId!,profile:f.reviewer,status:'finished',createdAt:now(),lastObservedAt:now(),active:false,idleSince:now(),completion,released:true};
    store.putRun(run);
    store.db.prepare('INSERT INTO receipts(id,task,run,hash,response) VALUES(?,?,?,?,?)').run(completion.eventId,task.id,run.id,digest(JSON.stringify(completion)),JSON.stringify({accepted:true}));
    store.update(task.id,{phase:'changes_requested',reason:'Approval skipped the required macOS CI cases',resolution:{...task.resolution,review:completion,reviewerAgentId:'old-reviewer',reviewerProfile:f.reviewer}});
  }
  if(options.blockedReport){
    const completion:Completion={eventId:'blocked-review-event',taskId:task.id,runId:'blocked-review-run',status:'blocked',summary:'Authentic environment BLOCKED; the native batch is spent',...options.blockedCompletion};
    const run:Run={id:'blocked-review-run',taskId:task.id,role:'reviewer',generation:1,head:f.oldHead,base:f.planningCommit,agentId:'blocked-reviewer',workspaceId:task.workspaceId!,profile:f.reviewer,status:'finished',createdAt:now(),lastObservedAt:now(),active:false,idleSince:now(),completion,released:true};
    store.putRun(run);
    store.db.prepare('INSERT INTO receipts(id,task,run,hash,response) VALUES(?,?,?,?,?)').run(completion.eventId,task.id,run.id,digest(JSON.stringify(completion)),JSON.stringify({accepted:true}));
    store.update(task.id,{phase:'blocked',reason:'Reviewer reported the environment blocked'});
  }
  store.update(task.id,holdPatch(store.task(task.id),'dispatch','effigy-root','Root-owned gen1 dispatch fence'));
  return {task:store.task(task.id),engine,store};
}
export const INERT_KEY='a'.repeat(64);
export const STALE_CHECKOUT_DETAIL='Prospective merge requires a clean synchronized integration base: Integration checkout is on a different branch';
export function plantInertRecovery(store:Store,taskId:string,recoveryId:string,overrides:Record<string,unknown>={}){
  const task=store.task(taskId);
  store.update(taskId,{resolution:{...task.resolution,recovery:{id:recoveryId,key:INERT_KEY,generation:task.coordinatorGeneration,
    runId:null,agentId:null,status:'pending',summary:'',idleSince:null,incidentId:null,...overrides}}});
}
export function plantStaleCheckoutIncident(store:Store,taskId:string,incidentId:string,overrides:Record<string,unknown>={}){
  const task=store.task(taskId),stamp=new Date().toISOString();
  store.update(taskId,{resolution:{...task.resolution,attention:true,incident:{id:incidentId,role:'coordinator',runId:null,
    fingerprint:incidentId,attempt:0,cause:'repository_identity',detail:STALE_CHECKOUT_DETAIL,action:'',status:'reconciling',
    createdAt:stamp,updatedAt:stamp,...overrides}}});
}

export function ownerEffectHook(task:Task,state:HookRecord['state'],outcome?:'ok'|'blocked'):HookRecord{
  const eventId='owner-effect-event';
  return hookRecordSchema.parse({id:'owner-effect-hook',taskId:task.id,hookId:'policy',event:'task.pre_dispatch',eventId,
    occurrence:1,mode:'read_only',delivery:'required',state,
    manifest:{path:'.paseo/queue.json',commit:task.planningBase,digest:`sha256:${'a'.repeat(64)}`},
    program:{kind:'repository',executable:{path:'.paseo/hooks/policy',commit:task.planningBase,digest:`sha256:${'b'.repeat(64)}`},argv:[]},
    instruction:null,baseBranch:'main',baseCommit:task.planningBase,attempt:1,timeoutMs:30000,maxOutputBytes:65536,
    allowedPaths:[],commitSubject:null,eventDigest:'c'.repeat(64),createdAt:now(),updatedAt:now(),
    result:outcome?{schema:'paseo.queue.hook-result.v1',eventId,outcome,summary:'Recorded policy result'}:null});
}

/**
 * Dated observation race regressions; these do not assert terminal quiescence.
 * Each mutates exactly one fact inside the final combined observation
 * window — the last await before the synchronous commit path — and asserts
 * refusal with no receipt, scaffold/incident/history/fence change. Actor
 * observations per flow are exactly initial + combined, so the >=2 gate
 * fires deterministically once; the fired-count assertion below proves the
 * mutation landed (a test whose trigger never fires would pass vacuously).
 * Demonstrated pre-barrier: the same four mutations committed (missing
 * expected rejection) on the prior ordering, 34/34 baseline intact.
 */
export function observeCountingAdapter(engine:Engine,f:{states:Map<string,AgentObservation>;owner:string}){
  const engO=engine as unknown as {adapter:{observe:(id:string)=>Promise<AgentObservation>}};
  return {engO,innerO:engO.adapter.observe.bind(engO.adapter)};
}

/** Canonical remote witnesses move independently of both registered local checkouts. */
export function pushRemoteOnly(f:ReturnType<typeof ownerRevisionFixture>,branch:string){
  const clone=join(f.root,`remote-writer-${randomUUID()}`);
  runGit(f.root,'clone',hostedOrigin(f.root),clone);
  runGit(clone,'config','user.name','Remote writer');runGit(clone,'config','user.email','writer@example.test');
  runGit(clone,'checkout',branch);
  writeFileSync(join(clone,'remote-only.txt'),randomUUID());runGit(clone,'add','remote-only.txt');runGit(clone,'commit','-m','remote-only drift');
  runGit(clone,'push','origin',branch);return runGit(clone,'rev-parse','HEAD');
}
export async function admitPinned(f:ReturnType<typeof ownerRevisionFixture>,engine:Engine,taskId:string){
  const held=f.store.task(taskId);
  // The release schedules this task's admission on its own lane; wake drains it.
  // A second admission called here runs off that lane and can lose to the first,
  // and the loser parks the task with no reviewer.
  await engine.performTaskControl({taskId,version:held.version,action:'release',kind:'dispatch',reason:'Owner releases independent review'});
  await engine.wake();
}

// Realistic idle-owner history: an unrelated failed shell, a canceled call and
// completed calls whose renderer type is unknown. All are terminal.
export const terminalOwnerHistory=()=>[
  {timestamp:now(),item:{type:'tool_call',name:'shell',callId:'exec-failed',status:'failed',detail:{type:'shell',command:'effigy graph src/runner/gateway_command'}}},
  {timestamp:now(),item:{type:'tool_call',name:'web_search',callId:'exec-search',status:'completed'}},
  {timestamp:now(),item:{type:'tool_call',name:'send_agent_prompt',callId:'exec-coord',status:'completed',detail:{note:'renderer type absent'}}},
  {timestamp:now(),item:{type:'tool_call',name:'shell',callId:'exec-canceled',status:'canceled',detail:{type:'shell',command:'sleep 1'}}},
];
