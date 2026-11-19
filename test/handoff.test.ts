import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {git,validateSubmission} from '../core/git/index';
import {heldBriefQueuePolicy, parseBriefDocument, prepareHandoff, submissionQueueFields} from '../core/planning/handoff';
import {Store} from '../core/store/store';
import {submissionSchema, taskPlanner} from '../shared/contracts';
const content=`---
title: Disposable brief
queue_approval: Operator approved this disposable test
queue:
  scope: mechanical
  skipPRReview: true
  dependsOn: [prerequisite-task-id]
---
## Outcome

Concrete task instructions.
`;
async function fixture(t:any){
 const root=await realpath(await mkdtemp(join(tmpdir(),'queue-brief-')));t.after(()=>rm(root,{recursive:true,force:true}));
 await git(root,'init','--bare',join(root,'origin.git'));await git(root,'clone',join(root,'origin.git'),join(root,'repo'));
 const repo=join(root,'repo');await git(repo,'checkout','-b','main');await git(repo,'config','user.name','Queue test');await git(repo,'config','user.email','queue@example.invalid');
 await writeFile(join(repo,'README.md'),'# Repo\n');await git(repo,'add','.');await git(repo,'commit','-m','Initial');await git(repo,'push','origin','main');
 const briefPath=join(root,'brief.md');
 async function publishBrief(text=content){await writeFile(briefPath,text);}
 await publishBrief();
 return {root,repo,briefPath,publishBrief,input:{briefPath,repoPath:repo,originAgentId:'origin-test',baseBranch:'main',dryRun:true}};
}
test('approved pushed brief derives routing and stable identity across unrelated commits',async t=>{
 const f=await fixture(t);const first=await prepareHandoff(f.input);
 assert.deepEqual(first.submission.dependsOn,['prerequisite-task-id']);assert.equal(first.submission.repoPath,f.repo);assert.equal(first.submission.skipPRReview,true);assert.equal(first.submission.scope,'mechanical');assert.equal(first.submission.originAgentId,'origin-test');assert.match(first.approval,/Operator approved/);
 assert.equal(first.submission.handoffPath,'','a brief carries no committed path');
 await writeFile(join(f.repo,'unrelated.txt'),'Unrelated');await git(f.repo,'add','.');await git(f.repo,'commit','-m','Unrelated');await git(f.repo,'push','origin','main');
 // A brief pins the pushed integration head, so an unrelated push re-pins it; the brief text is unchanged.
 const second=await prepareHandoff(f.input);
 assert.equal(second.digest,first.digest);assert.notEqual(second.submission.planningCommit,first.submission.planningCommit);assert.equal(second.submission.planningCommit,await git(f.repo,'rev-parse','HEAD'));
 await f.publishBrief(content.replace('Disposable brief','Revised brief'));assert.notEqual((await prepareHandoff(f.input)).digest,first.digest);
});
test('a committed handoff path is refused with the lead.submit guidance',async t=>{
 const f=await fixture(t);
 await assert.rejects(prepareHandoff({...f.input,briefPath:undefined,handoffPath:join(f.repo,'tasks/old.md')}),/Committed handoffs are retired.*lead\.submit/);
 const legacy=submissionSchema.parse({submissionId:'legacy',title:'Legacy',repoPath:f.repo,planningCommit:'a'.repeat(40),handoffPath:'tasks/old.md',originAgentId:'origin'});
 await assert.rejects(validateSubmission(legacy),/Committed handoffs are retired.*lead\.submit/);
});
test('submission rejects uncommitted brief edits, stale expected HEAD and unpushed main',async t=>{
 const f=await fixture(t);
 await writeFile(join(f.repo,'README.md'),'# Edited\n');await assert.rejects(prepareHandoff(f.input),/uncommitted/);await git(f.repo,'checkout','--','README.md');
 await assert.rejects(prepareHandoff({...f.input,planningCommit:'0'.repeat(40)}),/origin changed from the requested planning commit/);
 await writeFile(join(f.repo,'unpushed'),'x');await git(f.repo,'add','.');await git(f.repo,'commit','-m','Unpushed');await assert.rejects(prepareHandoff(f.input),/Push the integration/);
});
test('malformed briefs cannot become queue work',async t=>{
 const f=await fixture(t);
 for(const bad of [content.replace('queue_approval: Operator approved this disposable test\n',''),content.replace('## Outcome\n\nConcrete task instructions.\n','   \n'),content.replace('title: Disposable brief','title: Disposable brief\ntitle: Duplicate'),content.replace('Concrete task instructions.','{{TASK_SCOPE}}')]){
  await f.publishBrief(bad);await assert.rejects(prepareHandoff(f.input));
 }
});
test('brief metadata carries normalized optional completion cohorts',async t=>{
 const f=await fixture(t);
 await f.publishBrief(content.replace('skipPRReview: true','skipPRReview: true\n  notifyOriginOnCloseout: true\n  completionNotificationAgentIds: [thread-b, thread-a, thread-b]'));
 const prepared=await prepareHandoff(f.input);
 assert.equal(prepared.submission.notifyOriginOnCloseout,true);assert.deepEqual(prepared.submission.completionNotificationAgentIds,['thread-a','thread-b']);
});
test('brief frontmatter may request a merge hold',async t=>{
 const f=await fixture(t);
 await f.publishBrief(content.replace('scope: mechanical','scope: mechanical\n  mergeHold: true\n  mergeHoldReason: Waiting on an external receipt'));
 const prepared=await prepareHandoff(f.input);
 assert.equal(prepared.submission.mergeHold,true);
});
test('proof-only submission check returns a non-blocking worker preference warning',async t=>{
 const f=await fixture(t),head=await git(f.repo,'rev-parse','HEAD'),briefPath=join(f.root,'proof-brief.md');
 await writeFile(briefPath,`---\ntitle: Proof qualification\nqueue_approval: operator approved\nqueue:\n  complexity: medium\n  preferredProfileId: preferred-worker\n  requirePreferred: true\n  proofOnly:\n    commit: ${head}\n  proofExecution:\n    selector: effigy check\n    inputs: []\n  requiresOperatorGo: release approval\n---\n## Outcome\n\nProve it.\n`);
 const prepared=await prepareHandoff({...f.input,briefPath,repoPath:f.repo});
 assert.match(prepared.warning??'',/preferredProfileId\/requirePreferred bind only the GO-gate reviewer when requiresOperatorGo is set/);
 assert.equal(prepared.submission.proofOnly?.commit,head);
});

test('behind checkout fetches unknown remote ancestry without rewriting the local checkout', async t => {
 const f=await fixture(t),head=await git(f.repo,'rev-parse','HEAD');
 const other=join(f.repo,'..','other');await git(f.repo,'clone',join(f.repo,'..','origin.git'),other);
 await git(other,'checkout','main');await git(other,'config','user.name','Queue test');await git(other,'config','user.email','queue@example.invalid');
 await writeFile(join(other,'remote-only.txt'),'Published elsewhere');await git(other,'add','.');await git(other,'commit','-m','Remote advancement');await git(other,'push','origin','main');
 const prepared=await prepareHandoff(f.input);
 assert.equal(prepared.submission.repoPath,f.repo);
 assert.equal(await git(f.repo,'rev-parse','HEAD'),head,'submission validation never mutates the canonical checkout');
});

test('heldBriefQueuePolicy reads a lead body that the brief schema still refuses', () => {
  const lead = `---\ntitle: Report\nqueue:\n  complexity: low\n  lanes: [web-health]\n  reportOnly: true\n  reportLane: web-health\n---\n\n## Outcome\nWrite a report.\n`;
  assert.throws(() => parseBriefDocument(lead, 'brief'), /queue_approval/);
  assert.equal(heldBriefQueuePolicy(lead).reportOnly, true);
  assert.equal(heldBriefQueuePolicy(lead).reportLane, 'web-health');
  const submitted = lead.replace('title: Report\n', 'title: Report\nqueue_approval: operator approved\n');
  assert.equal(parseBriefDocument(submitted, 'brief').queue.reportOnly, true);
});

test('every document intake path refuses queue.goal or queue.subjectSets without queue.stages', () => {
  // Every intake (brief, draft, lead check, amend_brief) parses through parseBriefDocument
  // with one of these labels, so this table covers every path.
  const heads = {
    brief: 'title: Gate fixture\nqueue_approval: planner approved',
    draft: 'title: Gate fixture',
  } as const;
  for (const [label, head] of Object.entries(heads) as [keyof typeof heads, string][]) {
    const doc = (queue: string) => `---\n${head}\n${queue}\n---\n# Body\n`;
    assert.doesNotThrow(() => parseBriefDocument(doc('queue:\n  mergeHold: false'), label), `${label}: a plain queue block parses`);
    // Well-formed values, so only the stage-adjacency guard can refuse them.
    for (const [key, field] of [['goal', 'goal: true'], ['subjectSets', 'subjectSets: {"version": 1, "sets": {}}']] as const) {
      const refusal = new RegExp(`queue\\.${key} requires queue\\.stages`);
      assert.throws(() => parseBriefDocument(doc(`queue:\n  ${field}`), label), refusal, `${label}: ${key} without stages is refused`);
    }
  }
});

test('task 1109: a brief names the task planner, and the operator is refused as one',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'queue-planner-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const brief=`---\ntitle: Planner brief\nqueue_approval: "Operator approved"\nqueue:\n  planner: named-planner\n---\n\nThe brief body.\n`;
 const parsed=parseBriefDocument(brief,'brief');
 assert.equal(parsed.queue.planner,'named-planner');
 const fields=submissionQueueFields(parsed.queue);
 assert.equal(fields.plannerAgentId,'named-planner');
 assert.deepEqual(fields.lanes,[]);
 const submission=submissionSchema.parse({submissionId:'planner-brief',title:'Planner brief',repoPath:join(root,'repo'),
  planningCommit:'a'.repeat(40),brief:{text:brief},originAgentId:'origin',...fields});
 const store=new Store(':memory:');
 try{
  const task=store.insert(submission,'host','brief','a'.repeat(40));
  assert.equal(task.plannerAgentId,'named-planner');
  assert.equal(taskPlanner(task),'named-planner','a brief-named planner is the first rung');
  assert.throws(()=>store.insert({...submission,submissionId:'operator-planner',plannerAgentId:'operator'},'host','brief','a'.repeat(40)),
   /operator is not a thread/);
  const ordinary=store.insert({...submission,submissionId:'owner-planner',plannerAgentId:null},'host','brief','a'.repeat(40));
  assert.equal(ordinary.plannerAgentId,null);
  assert.equal(taskPlanner(ordinary),'origin','unset keeps the submitting thread as the planner');
 }finally{store.close()}
});
