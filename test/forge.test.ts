import {test} from 'node:test';
import { isRepositoryContention } from '../core/scheduling/repository-contention';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {git,githubRepositoryFromRemote,verifyWorkspace,verifyResume} from '../core/git/index';
import {assertPullRequestIdentity,branchRequiresUpToDate,classifyGithubMerge,classifyUncertainMergeProof,exactIntendedMerge,findAnyOpenBranchPr,integrationBaseGate,reportedOrExactMergeCommit,syncMain,uniqueMarkedReviewComment,validateReviewComment,verifyContinuedProgress,verifyInspectedRevisionHead} from '../core/forge/index';
import {Store} from '../core/store/store';
import {submissionSchema} from '../shared/contracts';

test('GitHub origin parser accepts HTTPS, SCP-style, and SSH URL remotes',()=>{
 const remotes=[
  'https://github.com/example/repo',
  'https://github.com/example/repo.git',
  'git@github.com:example/repo',
  'git@github.com:example/repo.git',
  'ssh://git@github.com/example/repo',
  'ssh://git@github.com/example/repo.git',
 ];
 for(const remote of remotes)assert.equal(githubRepositoryFromRemote(remote),'example/repo',remote);
 assert.equal(githubRepositoryFromRemote('ssh://git@gitlab.com/example/repo'),null);
});

test('retained-worker PR identity accepts a matching draft only for continuation',()=>{
 const task={branch:'ns-task',baseBranch:'main'} as any;
 const draft={state:'open',draft:true,html_url:'https://github.com/example/repo/pull/1',head:{ref:'ns-task',sha:'a'.repeat(40)},base:{ref:'main'}};
 assert.deepEqual(assertPullRequestIdentity(task,draft,{allowDraft:true}),{url:draft.html_url,head:'a'.repeat(40)});
 assert.throws(()=>assertPullRequestIdentity(task,draft),/PR must be open, ready, and match the task branch and base/);
 assert.throws(()=>assertPullRequestIdentity(task,{...draft,head:{...draft.head,ref:'other'}},{allowDraft:true}),/PR must be open, and match the task branch and base/);
 assert.throws(()=>assertPullRequestIdentity(task,{...draft,state:'closed'},{allowDraft:true}),/PR must be open, and match the task branch and base/);
 const releaseTask={branch:'ns-task',baseBranch:'release/v0.5'} as any;
 assert.deepEqual(assertPullRequestIdentity(releaseTask,{...draft,draft:false,base:{ref:'release/v0.5'} }),{url:draft.html_url,head:'a'.repeat(40)});
 assert.throws(()=>assertPullRequestIdentity(releaseTask,{...draft,draft:false}),/PR must be open, ready, and match the task branch and base/);
});

test('report-only completion enumerates open draft PRs and PRs targeting another base', async () => {
 const dir=mkdtempSync(join(tmpdir(),'ns-any-open-pr-'));
 const priorPath=process.env.PATH;
 try{
  const bin=join(dir,'bin');mkdirSync(bin);
  const gh=join(bin,'gh');
  writeFileSync(gh,`#!/bin/sh\ncat <<'JSON'\n${JSON.stringify([
   {number:1,url:'https://github.com/acme/report/pull/1',state:'OPEN',isDraft:true,headRefName:'ns-task',baseRefName:'main'},
   {number:2,url:'https://github.com/acme/report/pull/2',state:'OPEN',isDraft:false,headRefName:'ns-task',baseRefName:'develop'},
   {number:3,url:'https://github.com/acme/report/pull/3',state:'CLOSED',isDraft:false,headRefName:'ns-task',baseRefName:'main'},
   {number:4,url:'https://github.com/acme/report/pull/4',state:'OPEN',isDraft:false,headRefName:'other',baseRefName:'main'},
 ])}\nJSON\n`);
  chmodSync(gh,0o755);process.env.PATH=`${bin}:${priorPath??''}`;
  await git(dir,'init','--initial-branch=main');await git(dir,'remote','add','origin','git@github.com:acme/report.git');
  const found=await findAnyOpenBranchPr({repoPath:dir,branch:'ns-task'} as any);
  assert.deepEqual(found,[
   {number:1,url:'https://github.com/acme/report/pull/1'},
   {number:2,url:'https://github.com/acme/report/pull/2'},
  ]);
 }finally{process.env.PATH=priorPath;rmSync(dir,{recursive:true,force:true})}
});

test('release-base merge verification and sync follow the task baseBranch',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ns-release-base-'));
 try{
  await git(dir,'init','--bare','--initial-branch=main','origin.git');
  const root=join(dir,'integration');await git(dir,'clone',join(dir,'origin.git'),root);
  await git(root,'config','user.name','Queue test');await git(root,'config','user.email','queue@example.invalid');
  writeFileSync(join(root,'base.txt'),'base');await git(root,'add','base.txt');await git(root,'commit','-m','base');await git(root,'push','-u','origin','main');
  await git(root,'checkout','-b','release/v0.5');await git(root,'push','-u','origin','release/v0.5');
  const base=await git(root,'rev-parse','HEAD');
  const writer=join(dir,'writer');await git(dir,'clone','--branch','release/v0.5',join(dir,'origin.git'),writer);
  await git(writer,'config','user.name','Queue test');await git(writer,'config','user.email','queue@example.invalid');
  await git(writer,'checkout','-b','ns-release-task');writeFileSync(join(writer,'feature.txt'),'feature');await git(writer,'add','feature.txt');
  await git(writer,'commit','-m','release task');const head=await git(writer,'rev-parse','HEAD');await git(writer,'push','-u','origin','ns-release-task');
  await git(writer,'checkout','release/v0.5');await git(writer,'fetch','origin','ns-release-task');await git(writer,'merge','--no-ff','--no-edit',head);
  await git(writer,'push','origin','release/v0.5');const merged=await git(writer,'rev-parse','HEAD');
  const task={repoPath:root,baseBranch:'release/v0.5',resolution:{mergeBase:base,mergeHead:head,mergedCommit:merged}} as any;
  assert.equal(await exactIntendedMerge(task),merged);
  assert.equal(await syncMain(task),merged);
  assert.equal(await git(root,'branch','--show-current'),'release/v0.5');
  assert.equal(await git(root,'rev-parse','HEAD'),merged);
  assert.equal(await git(root,'status','--porcelain'),'');
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('worker workspace preflight requires the queue-owned branch',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ns-worker-branch-'));
 try{
  await git(dir,'init');writeFileSync(join(dir,'handoff.md'),'scope');await git(dir,'add','handoff.md');await git(dir,'commit','-m','planning');
  const planningBase=await git(dir,'rev-parse','HEAD'),task={planningBase,handoffPath:'handoff.md',handoffText:'scope',branch:'ns-task',baseBranch:'main'} as any;
  await git(dir,'checkout','-b','ns-task');assert.equal(await verifyWorkspace(task,dir),'ns-task');
  await git(dir,'branch','-m','ns-prettier-name');await assert.rejects(verifyWorkspace(task,dir),/queue-owned branch ns-task/);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('continuation worktree verification preserves dirty files and unpublished commits',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ns-resume-'));
 try{
  await git(dir,'init','--bare','remote.git');await git(dir,'clone',join(dir,'remote.git'),'main');const root=join(dir,'main');await git(root,'checkout','-b','main');
  writeFileSync(join(root,'handoff.md'),'scope');await git(root,'add','handoff.md');await git(root,'commit','-m','planning');await git(root,'push','-u','origin','main');
  const planningBase=await git(root,'rev-parse','HEAD'),worker=join(dir,'worker'),branch='ns-task';
  await git(root,'worktree','add','-b',branch,worker,'main');
  const task={repoPath:root,directory:worker,planningCommit:planningBase,planningBase,handoffPath:'handoff.md',handoffText:'scope',branch,baseBranch:'main'} as any;
  writeFileSync(join(worker,'unstaged.txt'),'dirty work');writeFileSync(join(worker,'staged.txt'),'staged work');await git(worker,'add','staged.txt');
  writeFileSync(join(worker,'committed.txt'),'unpublished commit');await git(worker,'add','committed.txt');await git(worker,'commit','-m','unpublished');
  const before=await git(worker,'status','--porcelain');
  await verifyResume(task);
  assert.equal(await git(worker,'status','--porcelain'),before);
  assert.match(await git(worker,'log','--oneline'),/unpublished/);
  assert.equal(await git(worker,'branch','--show-current'),branch);
  await git(worker,'branch','-m','ns-renamed');await assert.rejects(verifyResume(task),/Continuation branch changed/);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('continuation reattaches a clean detached queue head only when local and remote branch heads match',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ns-resume-detached-'));
 try{
  await git(dir,'init','--bare','remote.git');
  const root=join(dir,'main');await git(dir,'clone',join(dir,'remote.git'),root);await git(root,'checkout','-b','main');
  writeFileSync(join(root,'handoff.md'),'scope');await git(root,'add','handoff.md');await git(root,'commit','-m','planning');await git(root,'push','-u','origin','main');
  const planning=await git(root,'rev-parse','HEAD'),branch='ns-task',worker=join(dir,'worker');await git(root,'worktree','add','-b',branch,worker,'main');
  writeFileSync(join(worker,'feature.txt'),'task');await git(worker,'add','feature.txt');await git(worker,'commit','-m','task work');await git(worker,'push','-u','origin',branch);
  const head=await git(worker,'rev-parse','HEAD');
  const task={repoPath:root,directory:worker,planningCommit:planning,planningBase:planning,handoffPath:'handoff.md',handoffText:'scope',branch,baseBranch:'main'} as any;

  await git(worker,'checkout','--detach',planning);
  await assert.rejects(verifyResume(task),/Continuation branch changed/);
  await git(worker,'checkout','--detach',head);writeFileSync(join(worker,'dirty.txt'),'preserve');
  await assert.rejects(verifyResume(task),/Continuation branch changed/);
  await git(worker,'clean','-f');
  assert.equal(await git(worker,'branch','--show-current'),'');
  assert.equal(await verifyResume(task),head);
  assert.equal(await git(worker,'branch','--show-current'),branch);
  assert.equal(await git(worker,'rev-parse','HEAD'),head);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('real Git sync fast-forwards only, preserves dirty main, and honors pause before writing',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ns-sync-'));let store:Store|undefined;
 try{
  await git(dir,'init','--bare','remote.git');await git(dir,'clone',join(dir,'remote.git'),'main');const root=join(dir,'main');
  await git(root,'checkout','-b','main');writeFileSync(join(root,'handoff.md'),'fixture');await git(root,'add','handoff.md');await git(root,'commit','-m','planning');await git(root,'push','-u','origin','main');
  const planning=await git(root,'rev-parse','HEAD');await git(dir,'clone','--branch','main',join(dir,'remote.git'),'writer');const writer=join(dir,'writer');
  writeFileSync(join(writer,'result.txt'),'merged');await git(writer,'add','result.txt');await git(writer,'commit','-m','merged work');await git(writer,'push');const merged=await git(writer,'rev-parse','HEAD');
  store=new Store(join(dir,'queue.sqlite'));const t=store.insert(submissionSchema.parse({submissionId:'sync',title:'Sync fixture',repoPath:root,planningCommit:planning,handoffPath:'handoff.md',originAgentId:'origin'}),'host','fixture',planning);
  const task=store.update(t.id,{resolution:{...t.resolution,mergedCommit:merged}});
  writeFileSync(join(root,'unrelated.txt'),'keep');await assert.rejects(syncMain(task),/dirty/);assert.equal(await git(root,'rev-parse','HEAD'),planning);rmSync(join(root,'unrelated.txt'));
  await assert.rejects(syncMain(task,()=>false),/Paused/);assert.equal(await git(root,'rev-parse','HEAD'),planning);
  assert.equal(await syncMain(task),merged);assert.equal(await syncMain(task),merged);assert.equal(await git(root,'status','--porcelain'),'');
  writeFileSync(join(root,'planning-followup.md'),'later canonical planning');await git(root,'add','planning-followup.md');await git(root,'commit','-m','planning followup');await git(root,'push');const advanced=await git(root,'rev-parse','HEAD');
  assert.equal(await syncMain(task),advanced);assert.equal(await git(root,'rev-parse','HEAD'),advanced);
  writeFileSync(join(root,'local.txt'),'unpublished');await git(root,'add','local.txt');await git(root,'commit','-m','unpublished local work');const local=await git(root,'rev-parse','HEAD');
  // An unpushed local commit is named as repository contention, so it waits out the grace instead of parking.
  await assert.rejects(syncMain(task),(error:Error)=>isRepositoryContention(error.message)&&/Local integration branch differs from origin/.test(error.message));assert.equal(await git(root,'rev-parse','HEAD'),local);
 }finally{store?.close();rmSync(dir,{recursive:true,force:true})}
});


test('review identity distinguishes literal-file uploads, stale markers and account mismatches',()=>{
 const issue='https://api.github.com/repos/example/repo/issues/1',marker='<!-- northstar-review:task:run:head:ready_to_merge -->';
 const comment={issue_url:issue,user:{login:'reviewer'},body:`Actual review findings\n${marker}`};
 assert.doesNotThrow(()=>validateReviewComment(comment,issue,'reviewer',marker));
 assert.throws(()=>validateReviewComment({...comment,body:'@/tmp/review.md'},issue,'reviewer',marker),/literal file path/);
 assert.throws(()=>validateReviewComment(comment,issue,'other',marker),/authenticated GitHub account/);
 assert.throws(()=>validateReviewComment(comment,issue,'reviewer','different-head-marker'),/missing the marker/);
 assert.throws(()=>validateReviewComment(comment,issue+'2','reviewer',marker),/different PR/);
});

test('review comment reconciliation settles a duplicate exact marker on the earliest',()=>{
 const issue='https://api.github.com/repos/example/repo/issues/1',marker='<!-- northstar-review:task:run:head:changes_required -->';
 const valid={id:12,issue_url:issue,user:{login:'reviewer'},body:`Required findings\n${marker}`};
 assert.equal(uniqueMarkedReviewComment([valid],issue,'reviewer',marker).id,12);
 assert.throws(()=>uniqueMarkedReviewComment([{...valid,user:{login:'other'}}],issue,'reviewer',marker),/found 0/);
 // Task 704: a duplicate is the real outcome of a publication race; the earliest is the record.
 assert.equal(uniqueMarkedReviewComment([valid,{...valid,id:13}],issue,'reviewer',marker).id,12);
 assert.equal(uniqueMarkedReviewComment([{...valid,id:13},valid],issue,'reviewer',marker).id,12);
 assert.throws(()=>uniqueMarkedReviewComment([{...valid,body:`${marker}\n${marker}`}],issue,'reviewer',marker),/found 0/);
});

test('PR check classification separates pending checks from terminal failures',async()=>{
 const {classifyPrChecks}=await import('../core/forge/index');
 assert.deepEqual(classifyPrChecks([{__typename:'CheckRun',name:'build',status:'IN_PROGRESS'}]),{wait:'PR checks are pending',checksFailed:false,pendingCheck:true});
 assert.deepEqual(classifyPrChecks([{__typename:'StatusContext',context:'legacy',state:'EXPECTED'}]),{wait:'PR checks are pending',checksFailed:false,pendingCheck:true});
 assert.deepEqual(classifyPrChecks([{__typename:'CheckRun',name:'routes',status:'COMPLETED',conclusion:'FAILURE'}]),{wait:'PR checks failed: routes (job URL: (no job URL))',checksFailed:true});
 const job='https://github.com/example/repo/actions/runs/109833109128/job/1';
 assert.deepEqual(classifyPrChecks([{__typename:'CheckRun',name:'lint',status:'COMPLETED',conclusion:'FAILURE',detailsUrl:job},{__typename:'CheckRun',name:'tests',status:'COMPLETED',conclusion:'TIMED_OUT'}]),
  {wait:`PR checks failed: lint (job URL: ${job}), tests (job URL: (no job URL))`,checksFailed:true});
 assert.deepEqual(classifyPrChecks([{__typename:'CheckRun',name:'tests',status:'COMPLETED',conclusion:'SUCCESS'}]),{wait:'',checksFailed:false});
});

test('hosted-runner acquisition cancellations classify as infrastructure only with fetched evidence',async()=>{
 const {classifyPrChecks,isInfrastructureCancellation,HOSTED_RUNNER_ACQUISITION_PATTERN,workflowJobRefFromJobUrl,enrichPendingCheckEvidence}=await import('../core/forge/index');
 const job='https://github.com/example/repo/actions/runs/9/job/1';
 const cancelled={__typename:'CheckRun',name:'build',status:'COMPLETED',conclusion:'CANCELLED',startedAt:'2026-10-05T00:00:00.000Z',completedAt:'2026-10-05T00:01:00.000Z',detailsUrl:job,steps:[] as {name?:string}[]};
 assert.equal(isInfrastructureCancellation(cancelled),true,'an explicitly empty step list proves the job never ran');
 assert.equal(HOSTED_RUNNER_ACQUISITION_PATTERN.test('The job was not acquired by Runner of type hosted even after multiple attempts'),true);
 assert.equal(HOSTED_RUNNER_ACQUISITION_PATTERN.test('Failed to acquire a runner for label ubuntu-latest'),true,'a runner-scoped acquisition failure still matches');
 assert.equal(HOSTED_RUNNER_ACQUISITION_PATTERN.test('Data acquisition step cancelled by user'),false,'an unrelated annotation containing acquisition never matches');
 assert.equal(HOSTED_RUNNER_ACQUISITION_PATTERN.test('The lock was not acquired before the deadline'),false,'an acquisition without a runner never matches');
 const unrelated={__typename:'CheckRun',name:'ingest',status:'COMPLETED',conclusion:'CANCELLED',detailsUrl:job,steps:[{name:'Fetch data',status:'completed'}],annotations:[{message:'Data acquisition step cancelled by user'}]};
 assert.equal(isInfrastructureCancellation(unrelated),false,'an unrelated cancelled check stays semantic despite the word acquisition');
 const annotated={__typename:'CheckRun',name:'lint',status:'COMPLETED',conclusion:'CANCELLED',detailsUrl:job,steps:[{name:'Set up job',status:'completed'}],annotations:[{message:'The job was not acquired by Runner of type hosted'}]};
 assert.equal(isInfrastructureCancellation(annotated),true,'a runner-acquisition annotation proves infrastructure even with step records');
 const bare={__typename:'CheckRun',name:'queue',status:'COMPLETED',conclusion:'CANCELLED',detailsUrl:job};
 assert.equal(isInfrastructureCancellation(bare),false,'omitted steps are not evidence of an empty run');
 const stepped={__typename:'CheckRun',name:'tests',status:'COMPLETED',conclusion:'CANCELLED',detailsUrl:job,steps:[{name:'Run tests',status:'completed',conclusion:'cancelled'}]};
 assert.equal(isInfrastructureCancellation(stepped),false,'a job cancelled after executing steps stays out of the infrastructure path');
 assert.equal(isInfrastructureCancellation({__typename:'CheckRun',name:'unit',status:'COMPLETED',conclusion:'FAILURE',detailsUrl:job}),false,'a real failure is still semantic');
 const infra=classifyPrChecks([cancelled]);
 assert.equal(infra.checksFailed,false);
 assert.equal((infra as {infrastructure?: boolean}).infrastructure,true);
 assert.deepEqual((infra as {infraRunIds?: string[]}).infraRunIds,['9']);
 assert.match(infra.wait,/cancelled before running \(hosted-runner acquisition\)/);
 assert.match(infra.wait,/build \(job URL: /);
 const unproven=classifyPrChecks([bare]);
 assert.equal(unproven.checksFailed,true,'a cancellation without evidence stays a semantic refusal');
 assert.match(unproven.wait,/PR checks failed: queue/);
 const mixed=classifyPrChecks([{__typename:'CheckRun',name:'lint',status:'COMPLETED',conclusion:'FAILURE',detailsUrl:job},cancelled]);
 assert.equal(mixed.checksFailed,true,'a real failure alongside infra stays a semantic refusal');
 assert.match(mixed.wait,/lint/);assert.doesNotMatch(mixed.wait,/hosted-runner/);
 assert.deepEqual(workflowJobRefFromJobUrl(job),{owner:'example',repo:'repo',runId:'9',jobId:'1'});
 assert.equal(workflowJobRefFromJobUrl('(no job URL)'),null);
 assert.equal(workflowJobRefFromJobUrl('https://github.com/example/repo/actions/runs/9'),null);
 const store={jobSteps: new Map<string,{steps:{name?:string}[];labels?:string[]}>(), annotations: new Map<string,{message:string}[]>()};
 store.jobSteps.set('1',{steps:[],labels:['macos-latest']});
 store.jobSteps.set('2',{steps:[{name:'Run tests'}]});
 store.annotations.set('21',[{message:'The job was not acquired by Runner of type hosted'}]);
 const transport=async(_t:unknown,endpoint:string)=>{
  const jobMatch=endpoint.match(/\/actions\/jobs\/(\d+)$/);
  if(jobMatch){const record=store.jobSteps.get(jobMatch[1]);if(!record)throw new Error('job lookup failed');return record;}
  const noteMatch=endpoint.match(/\/check-runs\/(\d+)\/annotations$/);
  if(noteMatch)return store.annotations.get(noteMatch[1])??[];
  throw new Error(`unexpected endpoint ${endpoint}`);
 };
 const unevidenced=[{__typename:'CheckRun',databaseId:20,name:'build',status:'COMPLETED',conclusion:'CANCELLED',detailsUrl:'https://github.com/example/repo/actions/runs/9/job/1'},{__typename:'CheckRun',databaseId:21,name:'lint',status:'COMPLETED',conclusion:'CANCELLED',detailsUrl:'https://github.com/example/repo/actions/runs/9/job/2'}];
 const observed=await (await import('../core/forge/index')).observeCheckClassification({} as never,unevidenced,undefined,'all',undefined,'example','repo',transport as never);
 assert.equal(observed.infrastructure,true,'fetched job and annotation evidence classifies infrastructure');
 const flaky=await (await import('../core/forge/index')).observeCheckClassification({} as never,[{__typename:'CheckRun',name:'queue',status:'COMPLETED',conclusion:'CANCELLED',detailsUrl:'https://github.com/example/repo/actions/runs/9/job/3'}],undefined,'all',undefined,'example','repo',transport as never);
 assert.match(flaky.wait,/lack step evidence/);
 const queued=await enrichPendingCheckEvidence({} as never,[{__typename:'CheckRun',name:'rust',status:'QUEUED',startedAt:'2026-10-05T00:00:00.000Z',detailsUrl:job}],transport as never,'example/repo');
 assert.deepEqual(queued.uninferred,[]);
 assert.deepEqual(queued.checks[0].steps,[],'a queued job carries fetched zero-step runner evidence');
 assert.deepEqual(queued.checks[0].labels,['macos-latest'],'queued job labels remain visible for planner attention');
 const overdueQueued=classifyPrChecks(queued.checks,{now:Date.parse('2026-10-06T00:00:00.000Z')});
 assert.equal(overdueQueued.overdue,true,'a runnerless queued job remains on the bounded pending-check path');
 assert.equal(overdueQueued.pendingCheck,true);
 assert.equal(overdueQueued.infrastructure,undefined,'do not spend the one-shot rerun intent while GitHub still reports QUEUED');
 assert.match(overdueQueued.wait,/queued, no runner yet/);
 assert.match(overdueQueued.wait,/runner label: macos-latest/);
});

test('a required check pending past its deadline raises attention with the job URL; one within it does not',async()=>{
 const {classifyPrChecks,pendingCheckDeadlineMs,PENDING_CHECK_FALLBACK_MS,isPendingCheckDeadlineReason}=await import('../core/forge/index');
 const now=Date.parse('2026-09-26T12:00:00.000Z');
 const iso=(ms:number)=>new Date(ms).toISOString();
 assert.equal(pendingCheckDeadlineMs([]),PENDING_CHECK_FALLBACK_MS);
 assert.equal(pendingCheckDeadlineMs([60_000,120_000]),360_000);
 const job='https://github.com/example/repo/actions/runs/9';
 const overdue=classifyPrChecks([{__typename:'CheckRun',name:'build',status:'IN_PROGRESS',startedAt:iso(now-31*60_000),detailsUrl:job}],{now});
 assert.equal(overdue.checksFailed,false);
 assert.equal(overdue.overdue,true);
 assert.match(overdue.wait,/Required check 'build'.*has been pending past its deadline/);
 assert.match(overdue.wait,/job URL: https:\/\/github.com\/example\/repo\/actions\/runs\/9/);
 assert.equal(isPendingCheckDeadlineReason(overdue.wait),true);
 const within=classifyPrChecks([{__typename:'CheckRun',name:'build',status:'IN_PROGRESS',startedAt:iso(now-10*60_000),detailsUrl:job}],{now,durations:()=>[5*60_000]});
 assert.deepEqual(within,{wait:'PR checks are pending',checksFailed:false,pendingCheck:true});
 assert.equal(isPendingCheckDeadlineReason(within.wait),false);
 const historic=classifyPrChecks([{__typename:'CheckRun',name:'build',status:'IN_PROGRESS',startedAt:iso(now-20*60_000),detailsUrl:job}],{now,durations:()=>[5*60_000]});
 assert.equal(historic.overdue,true);
 assert.match(historic.wait,/bound 15m/);
 const queued=classifyPrChecks([{__typename:'CheckRun',name:'rust',status:'QUEUED',startedAt:iso(now-31*60_000),detailsUrl:'https://github.com/example/repo/actions/runs/12/job/3',steps:[]}],{now});
 assert.equal(queued.infrastructure,undefined,'even with zero-step evidence, a still-queued run cannot use the cancelled-run rerun path');
 assert.equal(queued.overdue,true);
 assert.equal(queued.pendingCheck,true);
 assert.match(queued.wait,/Required check 'rust'.*queued, no runner yet.*has been pending past its deadline/);
 assert.equal(queued.overdueCheck?.state,'QUEUED');
 const recentQueued=classifyPrChecks([{__typename:'CheckRun',name:'rust',status:'QUEUED',startedAt:iso(now-10*60_000),detailsUrl:'https://github.com/example/repo/actions/runs/12/job/3',steps:[]}],{now,durations:()=>[5*60_000]});
 assert.deepEqual(recentQueued,{wait:'PR checks are pending',checksFailed:false,pendingCheck:true},'a runnerless queued job is not retried before its bound');
});

test('integration gate records the fetched remote base without rebasing a behind head',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ns-base-advance-'));
 try{
  await git(dir,'init','--bare','remote.git');await git(dir,'clone',join(dir,'remote.git'),'main');const root=join(dir,'main');
  await git(root,'checkout','-b','main');writeFileSync(join(root,'base.txt'),'a');await git(root,'add','base.txt');await git(root,'commit','-m','base a');await git(root,'push','-u','origin','main');
  await git(dir,'clone','--branch','main',join(dir,'remote.git'),'worker');const worker=join(dir,'worker');await git(worker,'checkout','-b','feature');writeFileSync(join(worker,'feature.txt'),'feature');await git(worker,'add','feature.txt');await git(worker,'commit','-m','feature');const staleHead=await git(worker,'rev-parse','HEAD');
  writeFileSync(join(root,'base.txt'),'b');await git(root,'commit','-am','base b');await git(root,'push');const currentBase=await git(root,'rev-parse','HEAD');
  assert.deepEqual(await integrationBaseGate({repoPath:root,baseBranch:'main',directory:worker},staleHead),{base:currentBase,wait:''});
  writeFileSync(join(root,'unrelated.txt'),'dirty');await assert.rejects(integrationBaseGate({repoPath:root,baseBranch:'main',directory:worker},staleHead),/dirty or switched/);
  rmSync(join(root,'unrelated.txt'));
  await git(worker,'fetch','origin','main');
  await git(worker,'merge','--no-edit',currentBase);const updatedHead=await git(worker,'rev-parse','HEAD');
  assert.deepEqual(await integrationBaseGate({repoPath:root,baseBranch:'main',directory:worker},updatedHead),{base:currentBase,wait:''});
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('GitHub merge classification accepts behind mergeable heads and rebases only conflict or required updates',()=>{
 assert.deepEqual(classifyGithubMerge({mergeable:'MERGEABLE',mergeStateStatus:'CLEAN'},false),{wait:''});
 assert.deepEqual(classifyGithubMerge({mergeable:'MERGEABLE',mergeStateStatus:'BEHIND'},false),{wait:''});
 assert.deepEqual(classifyGithubMerge({mergeable:'MERGEABLE',mergeStateStatus:'HAS_HOOKS'},false),{wait:''});
 assert.deepEqual(classifyGithubMerge({mergeable:'MERGEABLE',mergeStateStatus:'BEHIND'},true),{wait:'Repository requires the PR head to include the current base',needsRebase:true});
 assert.deepEqual(classifyGithubMerge({mergeable:'MERGEABLE',mergeStateStatus:'BLOCKED'},true),{wait:'Repository requires the PR head to include the current base',needsRebase:true});
 assert.deepEqual(classifyGithubMerge({mergeable:'CONFLICTING',mergeStateStatus:'DIRTY'},false),{wait:'GitHub reports a merge conflict; the worker must update the PR head',needsRebase:true});
 assert.deepEqual(classifyGithubMerge({mergeable:'MERGEABLE',mergeStateStatus:'DIRTY'},false),{wait:'GitHub reports a merge conflict; the worker must update the PR head',needsRebase:true});
 assert.deepEqual(classifyGithubMerge({mergeable:'UNKNOWN',mergeStateStatus:'UNKNOWN'},false),{wait:'GitHub merge state is UNKNOWN; branch rules must be satisfied'});
 assert.deepEqual(classifyGithubMerge({mergeable:'MERGEABLE',mergeStateStatus:'BLOCKED'},false),{wait:'GitHub merge state is BLOCKED; branch rules must be satisfied'});
 assert.equal(branchRequiresUpToDate([],null),false);
 assert.equal(branchRequiresUpToDate([],{strict:true}),true);
 assert.equal(branchRequiresUpToDate([{type:'required_status_checks',parameters:{strict_required_status_checks_policy:true}}],null),true);
 assert.equal(branchRequiresUpToDate([{type:'required_status_checks',parameters:{strict_required_status_checks_policy:false}}],null),false);
});

test('uncertain-merge proof requires complete merge-queue evidence',()=>{
 const pullRequest={headRefOid:'a'.repeat(40),baseRefName:'main',state:'OPEN',merged:false,mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',autoMergeRequest:null,isInMergeQueue:false,isMergeQueueEnabled:true,mergeQueueEntry:null};
 const noEntry=classifyUncertainMergeProof({pullRequest,mergeQueue:{id:'queue'}},'a'.repeat(40),'main');
 assert.equal(noEntry.proven,true);
 const queued=classifyUncertainMergeProof({pullRequest:{...pullRequest,isInMergeQueue:true,mergeQueueEntry:{id:'entry'}} ,mergeQueue:{id:'queue'}},'a'.repeat(40),'main');
 assert.equal(queued.proven,false);
 const unavailable=classifyUncertainMergeProof({pullRequest},'a'.repeat(40),'main','mergeQueue query unavailable');
 assert.equal(unavailable.proven,false);
 assert.match(unavailable.detail,/mergeQueueAvailable/);
 const missing=classifyUncertainMergeProof({pullRequest},'a'.repeat(40),'main');
 assert.equal(missing.proven,false,'missing merge-queue data cannot prove absence');
 const disabled=classifyUncertainMergeProof({pullRequest:{...pullRequest,isMergeQueueEnabled:false},mergeQueue:null},'a'.repeat(40),'main');
 assert.equal(disabled.proven,true,'a known disabled queue has no entry');
});

test('exact merge-intent recovery recognizes only the recorded two-parent merge on remote main',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ns-merge-intent-'));
 try{
  await git(dir,'init','--bare','remote.git');await git(dir,'clone',join(dir,'remote.git'),'main');const root=join(dir,'main');
  await git(root,'checkout','-b','main');writeFileSync(join(root,'base.txt'),'base');await git(root,'add','base.txt');await git(root,'commit','-m','base');await git(root,'push','-u','origin','main');const base=await git(root,'rev-parse','HEAD');
  await git(dir,'clone','--branch','main',join(dir,'remote.git'),'worker');const worker=join(dir,'worker');await git(worker,'checkout','-b','feature');writeFileSync(join(worker,'feature.txt'),'feature');await git(worker,'add','feature.txt');await git(worker,'commit','-m','feature');const head=await git(worker,'rev-parse','HEAD');await git(worker,'push','-u','origin','feature');
  await git(root,'fetch','origin','feature');await git(root,'merge','--no-ff','--no-edit',head);await git(root,'push');const merge=await git(root,'rev-parse','HEAD');
  const task={repoPath:root,baseBranch:'main',resolution:{mergeBase:base,mergeHead:head}} as any;
  assert.equal(await exactIntendedMerge(task),merge);
  assert.equal(await reportedOrExactMergeCommit(task,{merged:false,merge_commit_sha:null}),merge);
  assert.equal(await reportedOrExactMergeCommit(task,{merged:true,merge_commit_sha:merge}),merge);
  assert.equal(await exactIntendedMerge({...task,resolution:{mergeBase:base,mergeHead:'f'.repeat(40)}}),null);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('published closeout accepts a clean docs-only descendant, rejects unpublished or out-of-scope changes',async()=>{
 const {mkdirSync}=await import('node:fs');const {verifyCloseoutPublication}=await import('../core/forge/index');
 const dir=mkdtempSync(join(tmpdir(),'ns-closeout-publish-'));let store:Store|undefined;
 try{
  await git(dir,'init','--bare','remote.git');await git(dir,'clone',join(dir,'remote.git'),'main');const root=join(dir,'main');await git(root,'checkout','-b','main');
  mkdirSync(join(root,'docs/handoffs'),{recursive:true});writeFileSync(join(root,'result.txt'),'merged work');writeFileSync(join(root,'docs/handoffs/task.md'),'committed handoff');await git(root,'add','result.txt','docs/handoffs/task.md');await git(root,'commit','-m','merged task');await git(root,'push','-u','origin','main');const baseline=await git(root,'rev-parse','HEAD');
  store=new Store(join(dir,'queue.sqlite'));const original=store.insert(submissionSchema.parse({submissionId:'closeout',title:'Closeout',repoPath:root,planningCommit:baseline,handoffPath:'docs/handoffs/task.md',originAgentId:'origin'}),'host','handoff',baseline);
  const task=store.update(original.id,{resolution:{...original.resolution,mergedCommit:baseline,syncedCommit:baseline}});
  assert.equal(await verifyCloseoutPublication(task),baseline);
  mkdirSync(join(root,'docs/logs'),{recursive:true});writeFileSync(join(root,'docs/logs/closeout.md'),'Task merged; review accepted; unrelated failures recorded.');rmSync(join(root,'docs/handoffs/task.md'));await git(root,'add','docs/logs/closeout.md','docs/handoffs/task.md');await git(root,'commit','-m','closeout');const published=await git(root,'rev-parse','HEAD');
  const report={eventId:'closeout',taskId:task.id,runId:'run',status:'closed' as const,summary:'Closed',closeoutCommit:published};
  await assert.rejects(verifyCloseoutPublication(task,report),/published/);await git(root,'push');
  await assert.rejects(verifyCloseoutPublication(task),/report the published/);assert.equal(await verifyCloseoutPublication(task,report),published);
  writeFileSync(join(root,'result.txt'),'unrelated implementation edit');await assert.rejects(verifyCloseoutPublication(task,report),/not clean/);await git(root,'add','result.txt');await git(root,'commit','-m','outside closeout');await git(root,'push');
  await assert.rejects(verifyCloseoutPublication(task,{...report,closeoutCommit:await git(root,'rev-parse','HEAD')}),/outside canonical closeout/);
 }finally{store?.close();rmSync(dir,{recursive:true,force:true})}
});

test('published closeout accepts the exact root docs front door and fences nearby paths',async()=>{
 const {mkdirSync,symlinkSync}=await import('node:fs');const {verifyCloseoutPublication}=await import('../core/forge/index');
 const dir=mkdtempSync(join(tmpdir(),'ns-closeout-front-door-'));let store:Store|undefined;
 try{
  await git(dir,'init','--bare','remote.git');await git(dir,'clone',join(dir,'remote.git'),'main');const root=join(dir,'main');await git(root,'checkout','-b','main');
  mkdirSync(join(root,'docs/handoffs'),{recursive:true});writeFileSync(join(root,'README.md'),'# Queue');writeFileSync(join(root,'docs/README.md'),'# Docs\n');writeFileSync(join(root,'docs/handoffs/task.md'),'committed handoff');await git(root,'add','README.md','docs/README.md','docs/handoffs/task.md');await git(root,'commit','-m','merged task');await git(root,'push','-u','origin','main');const baseline=await git(root,'rev-parse','HEAD');
  store=new Store(join(dir,'queue.sqlite'));const original=store.insert(submissionSchema.parse({submissionId:'closeout-front-door',title:'Closeout front door',repoPath:root,planningCommit:baseline,handoffPath:'docs/handoffs/task.md',originAgentId:'origin'}),'host','handoff',baseline);
  const task=store.update(original.id,{resolution:{...original.resolution,mergedCommit:baseline,syncedCommit:baseline}});
  mkdirSync(join(root,'docs/logs'),{recursive:true});writeFileSync(join(root,'docs/logs/closeout.md'),'Task merged; review accepted.');writeFileSync(join(root,'docs/README.md'),'# Docs\n\n- [Logs](logs/README.md)\n');rmSync(join(root,'docs/handoffs/task.md'));await git(root,'add','docs/README.md','docs/logs/closeout.md','docs/handoffs/task.md');await git(root,'commit','-m','closeout');const published=await git(root,'rev-parse','HEAD');await git(root,'push');
  const report={eventId:'closeout',taskId:task.id,runId:'run',status:'closed' as const,summary:'Closed',closeoutCommit:published};
  assert.equal(await verifyCloseoutPublication(task,report),published);
  writeFileSync(join(root,'docs/OTHER.md'),'unrelated root docs page');await git(root,'add','docs/OTHER.md');await git(root,'commit','-m','unrelated root docs page');await git(root,'push');
  await assert.rejects(verifyCloseoutPublication(task,{...report,closeoutCommit:await git(root,'rev-parse','HEAD')}),/outside canonical closeout/);
  rmSync(join(root,'docs/OTHER.md'));rmSync(join(root,'docs/README.md'));symlinkSync('../README.md',join(root,'docs/README.md'));await git(root,'add','docs/README.md','docs/OTHER.md');await git(root,'commit','-m','symlink front door');await git(root,'push');
  await assert.rejects(verifyCloseoutPublication(task,{...report,closeoutCommit:await git(root,'rev-parse','HEAD')}),/preserve regular Markdown files/);
 }finally{store?.close();rmSync(dir,{recursive:true,force:true})}
});

test('published closeout rejects deletion of canonical Markdown other than its submitted handoff',async()=>{
 const {mkdirSync}=await import('node:fs');const {verifyCloseoutPublication}=await import('../core/forge/index');
 const dir=mkdtempSync(join(tmpdir(),'ns-closeout-delete-'));let store:Store|undefined;
 try{
  await git(dir,'init','--bare','remote.git');await git(dir,'clone',join(dir,'remote.git'),'main');const root=join(dir,'main');await git(root,'checkout','-b','main');
  mkdirSync(join(root,'docs/logs'),{recursive:true});writeFileSync(join(root,'docs/logs/retained.md'),'retained evidence');await git(root,'add','docs/logs/retained.md');await git(root,'commit','-m','merged task');await git(root,'push','-u','origin','main');const baseline=await git(root,'rev-parse','HEAD');
  store=new Store(join(dir,'queue.sqlite'));const original=store.insert(submissionSchema.parse({submissionId:'closeout-delete',title:'Closeout deletion',repoPath:root,planningCommit:baseline,handoffPath:'docs/handoffs/task.md',originAgentId:'origin'}),'host','handoff',baseline);
  const task=store.update(original.id,{resolution:{...original.resolution,mergedCommit:baseline,syncedCommit:baseline}});
  rmSync(join(root,'docs/logs/retained.md'));await git(root,'add','docs/logs/retained.md');await git(root,'commit','-m','delete evidence');await git(root,'push');
  await assert.rejects(verifyCloseoutPublication(task,{eventId:'closeout',taskId:task.id,runId:'run',status:'closed',summary:'Closed',closeoutCommit:await git(root,'rev-parse','HEAD')}),/preserve regular Markdown files/);
 }finally{store?.close();rmSync(dir,{recursive:true,force:true})}
});

test('inspected stopped-revision proof requires exact local, remote and PR equality',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ns-inspected-head-'));
 try{
  await git(dir,'init','--bare','remote.git');await git(dir,'clone',join(dir,'remote.git'),'main');const root=join(dir,'main');await git(root,'checkout','-b','main');
  writeFileSync(join(root,'handoff.md'),'scope');await git(root,'add','handoff.md');await git(root,'commit','-m','planning');await git(root,'push','-u','origin','main');
  const branch='ns-task';await git(root,'worktree','add','-b',branch,join(dir,'worker'),'main');const worker=join(dir,'worker');
  const task={repoPath:root,directory:worker,branch,baseBranch:'main'} as any;
  writeFileSync(join(worker,'result.txt'),'revision work');await git(worker,'add','result.txt');await git(worker,'commit','-m','revision');await git(worker,'push','-u','origin',branch);
  const inspected=await git(worker,'rev-parse','HEAD');
  let prHead=inspected;
  const lookup=async()=>({url:'https://github.com/example/repo/pull/1',head:prHead});
  const prove=(expected:string)=>verifyInspectedRevisionHead(task,1,expected,lookup);
  await prove(inspected);
  // A wrong, shortened or stale head fails with the observed identity facts.
  const other='f'.repeat(40);
  await assert.rejects(prove(other),/does not match the observed worktree/);
  await assert.rejects(prove('abc123'),/exact 40-character inspected PR head/);
  writeFileSync(join(worker,'followup.txt'),'later push');await git(worker,'add','followup.txt');await git(worker,'commit','-m','followup');await git(worker,'push');
  const advanced=await git(worker,'rev-parse','HEAD');prHead=advanced;
  await assert.rejects(prove(inspected),/does not match the observed worktree/);
  await prove(advanced);
  // A local-only commit the remote and PR never saw fails without mutation.
  writeFileSync(join(worker,'local.txt'),'unpushed');await git(worker,'add','local.txt');await git(worker,'commit','-m','unpushed');
  const localOnly=await git(worker,'rev-parse','HEAD');
  await assert.rejects(prove(localOnly),new RegExp(`remote ${advanced}`));
  await git(worker,'reset','--hard',advanced);
  // A PR-only head the worktree and remote never saw fails the same way.
  prHead=other;
  await assert.rejects(prove(other),new RegExp(`worktree ${advanced}, remote ${advanced} and PR ${other}`));
  prHead=advanced;
  await prove(advanced);
  // Dirty work, a switched branch and an ambiguous remote head fail closed.
  writeFileSync(join(worker,'dirty.txt'),'unstaged');await assert.rejects(prove(advanced),/clean retained worktree/);rmSync(join(worker,'dirty.txt'));
  await git(worker,'checkout','-q','--detach','HEAD');await assert.rejects(prove(advanced),/retained worktree on queue-owned branch/);await git(worker,'checkout','-q',branch);
  const unpushed='ns-unpushed';
  await git(worker,'checkout','-b',unpushed);writeFileSync(join(worker,'solo.txt'),'solo');await git(worker,'add','solo.txt');await git(worker,'commit','-m','solo');
  const solo=await git(worker,'rev-parse','HEAD');
  await assert.rejects(verifyInspectedRevisionHead({...task,branch:unpushed},1,solo,lookup),/ambiguous remote head/);
  await git(worker,'checkout',branch);await git(worker,'branch','-D',unpushed);
  await prove(advanced);
  // A matching head on a different verified PR identity is not the recorded task PR.
  await assert.rejects(verifyInspectedRevisionHead({...task,prUrl:'https://github.com/example/repo/pull/9'},1,advanced,lookup),/does not match the recorded task PR/);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('continued progress proves canonical published descendant in the retained worktree',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ns-continued-source-'));
 const savedPath=process.env.PATH, savedRemote=process.env.NS_TEST_REMOTE;
 try {
  await git(dir,'init','--bare','remote.git');
  await git(dir,'clone',join(dir,'remote.git'),'main');
  const root=join(dir,'main'), worker=join(dir,'worker'), origin='https://github.com/example/repo.git';
  await git(root,'checkout','-b','main');
  writeFileSync(join(root,'handoff.md'),'scope');await git(root,'add','handoff.md');await git(root,'commit','-m','planning');await git(root,'push','-u','origin','main');
  const planning=await git(root,'rev-parse','HEAD'), id='fixture', branch=`ns-${id}`;
  await git(root,'worktree','add','-b',branch,worker,'main');
  writeFileSync(join(worker,'work.txt'),'progress');await git(worker,'add','work.txt');await git(worker,'commit','-m','progress');await git(worker,'push','-u','origin',branch);
  await git(root,'remote','set-url','origin',origin);
  const bin=join(dir,'bin');mkdirSync(bin);const wrapper=join(bin,'git');
  writeFileSync(wrapper,'#!/bin/sh\nif [ "$1" = ls-remote ] && [ "$2" = origin ]; then exec /usr/bin/git ls-remote "$NS_TEST_REMOTE" "$3"; fi\nexec /usr/bin/git "$@"\n');chmodSync(wrapper,0o755);
  process.env.NS_TEST_REMOTE=join(dir,'remote.git');process.env.PATH=`${bin}:${savedPath ?? ''}`;
  const head=await git(worker,'rev-parse','HEAD'), url='https://github.com/example/repo/pull/1';
  const task={id,repoPath:root,directory:worker,workspaceId:'workspace',agentId:'author',branch,baseBranch:'main',planningCommit:planning,handoffPath:'handoff.md',handoffText:'scope',prUrl:url} as any;
  let forgeHead=head, repository='example/repo';
  const lookup=async()=>({url,head:forgeHead,repository:'example/repo',headRepository:repository});
  const prove=(ancestors=[planning])=>verifyContinuedProgress(task,1,head,ancestors,{},lookup);
  await prove();
  await assert.rejects(prove(['f'.repeat(40)]),/does not contain recorded work/);
  repository='other/repo';await assert.rejects(prove(),/not the canonical/);repository='example/repo';
  forgeHead='e'.repeat(40);await assert.rejects(prove(),/identity or head changed/);forgeHead=head;
  await assert.rejects(verifyContinuedProgress({...task,id:'other'},1,head,[planning],{},lookup),/immutable task branch/);
  await assert.rejects(verifyContinuedProgress({...task,prUrl:'https://github.com/example/repo/pull/2'},1,head,[planning],{},lookup),/identity or head changed/);
  let observations=0;await assert.rejects(verifyContinuedProgress(task,1,head,[planning],{},async()=>({...await lookup(),head:++observations>1?'e'.repeat(40):head})),/does not match|identity or head changed/);
  writeFileSync(join(worker,'dirty.txt'),'dirty');await assert.rejects(prove(),/dirty/);
  await verifyContinuedProgress(task,1,head,[planning],{requireClean:false},lookup);rmSync(join(worker,'dirty.txt'));
  writeFileSync(join(worker,'local.txt'),'unpublished');await git(worker,'add','local.txt');await git(worker,'commit','-m','unpublished');
  const unpublished=await git(worker,'rev-parse','HEAD');forgeHead=unpublished;
  await assert.rejects(verifyContinuedProgress(task,1,unpublished,[planning],{},lookup),/does not match the observed worktree/);
  await git(worker,'reset','--hard',head);forgeHead=head;
  await prove();
 } finally { if(savedPath===undefined)delete process.env.PATH;else process.env.PATH=savedPath;if(savedRemote===undefined)delete process.env.NS_TEST_REMOTE;else process.env.NS_TEST_REMOTE=savedRemote;rmSync(dir,{recursive:true,force:true}); }
});

test('pending status timers belong to a head and reset after completion', async () => {
 const {checkHistoryFromStore,classifyPrChecks}=await import('../core/forge/index');
 const values=new Map<string,unknown>();
 const store={getMeta:(key:string)=>values.get(key),setMeta:(key:string,value:unknown)=>values.set(key,value),deleteMeta:(key:string)=>values.delete(key)} as unknown as import('../core/store/store').Store;
 const start=Date.parse('2026-11-09T00:00:00Z');
 const pending={__typename:'StatusContext' as const,context:'ci',state:'PENDING'};
 const observe=(head:string,now:number)=>classifyPrChecks([pending],checkHistoryFromStore(store,'repo',now,head));
 observe('head-a',start);
 assert.equal(observe('head-b',start+31*60_000).wait,'PR checks are pending');
 classifyPrChecks([{...pending,state:'SUCCESS'}],checkHistoryFromStore(store,'repo',start+32*60_000,'head-a'));
 assert.equal(observe('head-a',start+33*60_000).wait,'PR checks are pending');
});

test('strict branch rule discovery preserves unknown reads', async () => {
 const {branchUpdateRequired}=await import('../core/forge/index');
 const task={} as import('../shared/contracts').Task;
 const read=(rules:unknown, protection:unknown) => async (_t:typeof task, endpoint:string) => {
  const value=endpoint.includes('/rules/branches/') ? rules : protection;
  if (value instanceof Error) throw value;
  return value;
 };
 assert.equal(await branchUpdateRequired(task,'o','r','main',read([], {strict:false})),false);
 const planRefusal=Object.assign(new Error('gh api failed'), {stderr:'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)'});
 assert.equal(await branchUpdateRequired(task,'o','r','main',read(planRefusal, {strict:false})),false);
 assert.equal(await branchUpdateRequired(task,'o','r','main',read([], planRefusal)),false);
 await assert.rejects(branchUpdateRequired(task,'o','r','main',read(new Error('HTTP 403 permission denied'), {strict:false})));
 assert.equal(await branchUpdateRequired(task,'o','r','main',read([{type:'required_status_checks',parameters:{strict_required_status_checks_policy:true}}], {strict:false})),true);
 await assert.rejects(branchUpdateRequired(task,'o','r','main',read(new Error('network'), {strict:false})));
 await assert.rejects(branchUpdateRequired(task,'o','r','main',read([], new Error('permission denied'))));
 await assert.rejects(branchUpdateRequired(task,'o','r','main',read({}, {strict:false})));
});
