import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {git} from '../core/git/index';
import {heldBriefQueuePolicy, parseNorthstarDocument, prepareHandoff} from '../core/planning/handoff';
const sections=['What This Thread Was Doing','Why It Matters','Current State','Boundaries','Important Context','Suggested Next Move','Completion Protocol'];
const content=`---
title: Disposable handoff
kind: northstar-handoff
handoff_mode: worker-pr-loop
worker_mode: implementation
dispatch_authority: orchestrator
status: ready-to-launch
base_required: pushed-main
queue_dispatch: northstar-queue
queue_approval: Operator approved this disposable test
queue:
  scope: mechanical
  skipPRReview: true
  dependsOn: [prerequisite-task-id]
---
${sections.map(s=>`## ${s}\n\nConcrete task instructions.\n`).join('\n')}`;
async function fixture(t:any){
 const root=await realpath(await mkdtemp(join(tmpdir(),'northstar-handoff-')));t.after(()=>rm(root,{recursive:true,force:true}));
 await git(root,'init','--bare',join(root,'origin.git'));await git(root,'clone',join(root,'origin.git'),join(root,'repo'));
 const repo=join(root,'repo');await git(repo,'checkout','-b','main');await git(repo,'config','user.name','Queue test');await git(repo,'config','user.email','queue@example.invalid');
 await mkdir(join(repo,'docs/handoffs'),{recursive:true});const path=join(repo,'docs/handoffs/test.md');
 async function publish(text=content){await writeFile(path,text);await git(repo,'add','.');await git(repo,'commit','-m','Test handoff');await git(repo,'push','origin','main');}
 await publish();return {root,repo,path,publish,input:{handoffPath:path,originAgentId:'origin-test',baseBranch:'main',dryRun:true}};
}
test('approved pushed handoff derives routing and stable identity across unrelated commits',async t=>{
 const f=await fixture(t);const first=await prepareHandoff(f.input);
 assert.deepEqual(first.submission.dependsOn,['prerequisite-task-id']);assert.equal(first.submission.repoPath,f.repo);assert.equal(first.submission.skipPRReview,true);assert.equal(first.submission.scope,'mechanical');assert.equal(first.submission.originAgentId,'origin-test');assert.match(first.approval,/Operator approved/);
 await writeFile(join(f.repo,'unrelated.txt'),'Unrelated');await git(f.repo,'add','.');await git(f.repo,'commit','-m','Unrelated');await git(f.repo,'push','origin','main');
 assert.deepEqual(await prepareHandoff(f.input),first);
 await f.publish(content.replace('Disposable handoff','Revised handoff'));assert.notEqual((await prepareHandoff(f.input)).submission.submissionId,first.submission.submissionId);
});
test('submission rejects uncommitted bytes, stale expected HEAD and unpushed main',async t=>{
 const f=await fixture(t);
 await writeFile(f.path,content+'\n');await assert.rejects(prepareHandoff(f.input),/uncommitted/);await writeFile(f.path,content);
 await assert.rejects(prepareHandoff({...f.input,planningCommit:'0'.repeat(40)}),/HEAD changed/);
 await writeFile(join(f.repo,'unpushed'),'x');await git(f.repo,'add','.');await git(f.repo,'commit','-m','Unpushed');await assert.rejects(prepareHandoff(f.input),/Push the integration/);
});
test('planning drafts and malformed handoffs cannot become queue work',async t=>{
 const f=await fixture(t);
 for(const bad of [content.replace('queue_dispatch: northstar-queue\n',''),content.replace('ready-to-launch','draft'),content.replace('## Boundaries','## Wrong section'),content.replace('title: Disposable handoff','title: Disposable handoff\ntitle: Duplicate'),content.replace('Concrete task instructions.','{{TASK_SCOPE}}')]){
  await f.publish(bad);await assert.rejects(prepareHandoff(f.input));
 }
});
test('handoff metadata carries normalized optional completion cohorts',async t=>{
 const f=await fixture(t);
 await f.publish(content.replace('skipPRReview: true','skipPRReview: true\n  notifyOriginOnCloseout: true\n  completionNotificationAgentIds: [thread-b, thread-a, thread-b]'));
 const prepared=await prepareHandoff(f.input);
 assert.equal(prepared.submission.notifyOriginOnCloseout,true);assert.deepEqual(prepared.submission.completionNotificationAgentIds,['thread-a','thread-b']);
});
test('handoff frontmatter may request a merge hold',async t=>{
 const f=await fixture(t);
 await f.publish(content.replace('scope: mechanical','scope: mechanical\n  mergeHold: true\n  mergeHoldReason: Waiting on an external receipt'));
 const prepared=await prepareHandoff(f.input);
 assert.equal(prepared.submission.mergeHold,true);
});
test('proof-only submission check returns a non-blocking worker preference warning',async t=>{
 const f=await fixture(t),head=await git(f.repo,'rev-parse','HEAD'),briefPath=join(f.root,'proof-brief.md');
 await writeFile(briefPath,`---\ntitle: Proof qualification\nqueue_approval: operator approved\nqueue:\n  complexity: medium\n  preferredProfileId: preferred-worker\n  requirePreferred: true\n  proofOnly:\n    commit: ${head}\n  proofExecution:\n    selector: effigy check\n    inputs: []\n  requiresOperatorGo: release approval\n---\n\nQualify the merged source.\n`);
 const prepared=await prepareHandoff({...f.input,handoffPath:undefined,briefPath,repoPath:f.repo});
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
  assert.throws(() => parseNorthstarDocument(lead, 'brief'), /queue_approval/);
  assert.equal(heldBriefQueuePolicy(lead).reportOnly, true);
  assert.equal(heldBriefQueuePolicy(lead).reportLane, 'web-health');
  const submitted = lead.replace('title: Report\n', 'title: Report\nqueue_approval: operator approved\n');
  assert.equal(parseNorthstarDocument(submitted, 'brief').queue.reportOnly, true);
});

test('every document intake path refuses queue.goal or queue.subjectSets without queue.stages', () => {
  // Every intake (brief, draft, lead check, amend_brief, committed handoff) parses through
  // parseNorthstarDocument with one of these labels, so this table covers every path.
  const heads = {
    brief: 'title: Gate fixture\nqueue_approval: planner approved',
    draft: 'title: Gate fixture',
    handoff: 'title: Gate fixture\nkind: northstar-handoff\nhandoff_mode: worker-pr-loop\nworker_mode: implementation\ndispatch_authority: orchestrator\nstatus: ready-to-launch\nqueue_dispatch: northstar-queue\nqueue_approval: planner approved\nbase_required: pushed-main',
  } as const;
  const handoffBody = ['What This Thread Was Doing', 'Why It Matters', 'Current State', 'Boundaries', 'Important Context', 'Suggested Next Move', 'Completion Protocol']
    .map(section => `## ${section}\n\nText.\n`).join('\n');
  for (const [label, head] of Object.entries(heads) as [keyof typeof heads, string][]) {
    const doc = (queue: string) => `---\n${head}\n${queue}\n---\n${label === 'handoff' ? handoffBody : '# Body\n'}`;
    assert.doesNotThrow(() => parseNorthstarDocument(doc('queue:\n  mergeHold: false'), label), `${label}: a plain queue block parses`);
    // Well-formed values, so only the stage-adjacency guard can refuse them.
    for (const [key, field] of [['goal', 'goal: true'], ['subjectSets', 'subjectSets: {"version": 1, "sets": {}}']] as const) {
      const refusal = label === 'handoff' ? new RegExp(key) : new RegExp(`queue\\.${key} requires queue\\.stages`);
      assert.throws(() => parseNorthstarDocument(doc(`queue:\n  ${field}`), label), refusal, `${label}: ${key} without stages is refused`);
    }
  }
});

test('handoff dispatch accepts Nucleus and the permanent legacy value',()=>{
 for(const value of ['nucleus','northstar-queue']) assert.doesNotThrow(()=>parseNorthstarDocument(content.replace('queue_dispatch: northstar-queue',`queue_dispatch: ${value}`),'handoff'));
});
