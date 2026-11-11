import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {writeFileSync,rmSync} from 'node:fs';
import {ownerRevisionFixture,ownedRevisableTask,admitPinned,runGit} from './support/review-entry-fixture';
import {materializeLegacyView} from './support/legacy-review-view-fixture';
import {verifyReviewSourceView} from '../core/review/review-source';
import {paseoWorkspaceIdAccepted} from '../hosts/paseo/adapter/workspace-id';

test('a review-entry reviewer uses the task workspace and creates no pinned workspace',async()=>{
  const f=ownerRevisionFixture();
  try{
    const {task,engine,store}=await ownedRevisableTask(f);
    await admitPinned(f,engine,task.id);
    const run=store.run(f.creates[0]!.id)!;
    assert.equal(run.workspaceId,task.workspaceId);
    assert.equal(run.reviewSourceView,undefined);
    assert.equal(runGit(task.directory!,'rev-parse','HEAD'),run.head);
    assert.equal(runGit(task.directory!,'status','--porcelain'),'');
    await engine.stop();
  }finally{f.close();}
});

test('a stored pinned view keeps its historical identity and content proof at terminal archive',async()=>{
  const f=ownerRevisionFixture();
  try{
    const {task,engine,store}=await ownedRevisableTask(f);
    await admitPinned(f,engine,task.id);
    store.putRun({...store.run(f.creates[0]!.id)!,released:true,status:'finished'});
    const run=materializeLegacyView(f,store,f.creates[0]!.id);
    const view=run.reviewSourceView!;
    const done=store.update(task.id,{phase:'done'});
    await verifyReviewSourceView(done,run);
    const portableRun={...run,workspaceId:'other:workspace',reviewSourceView:{...view,workspaceId:'other:workspace'}};
    await verifyReviewSourceView(done,portableRun,undefined,id=>id==='other:workspace');
    await assert.rejects(()=>verifyReviewSourceView(done,portableRun,undefined,paseoWorkspaceIdAccepted),/binding changed/);
    const dirty=join(view.directory!,'late-unreviewed-source.txt');
    writeFileSync(dirty,'not part of the recorded review\n');
    await assert.rejects(()=>verifyReviewSourceView(done,run),/unowned untracked source/);
    rmSync(dirty);
    await verifyReviewSourceView(done,run);
    assert.equal(store.task(task.id).workspaceId,task.workspaceId,'legacy cleanup proofs leave the task source identity intact');
    await engine.stop();
  }finally{f.close();}
});
