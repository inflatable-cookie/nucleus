import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Lifecycle } from '../core/closeout/workspace-lifecycle';
import { workspaceDiscardKey } from '../core/workspaces/orphan-worktree';
import { OPERATOR_BOARD_CALLER } from '../shared/contracts';
import { runGit } from './support/review-entry-fixture';
import { fixture, seedRetry } from './support/review-source-terminal-archive-fixture';

test('a released view archives while its preserved external source advances and becomes dirty',async()=>{
  const f=await fixture(false,false,true);
  try {
    await seedRetry(f);
    runGit(f.workspace,'checkout','-b','source-owner-later-work');
    writeFileSync(join(f.workspace,'feature.txt'),'source owner continues editing\n');
    const before=f.store.task(f.task.id);
    await f.engine.performTaskControl({taskId:before.id,version:before.version,action:'retry_effect',
      effect:`workspace_archive.${f.run.workspaceId}`,reason:'Archive the released review view',caller:OPERATOR_BOARD_CALLER});
    const result=f.store.task(before.id);
    assert.ok(result.resolution.archivedWorkspaceIds.includes(f.run.workspaceId));
    assert.ok(!result.resolution.archivedWorkspaceIds.includes(f.task.workspaceId!));
    assert.equal(existsSync(f.run.reviewSourceView!.directory!),false);
    assert.equal(readFileSync(join(f.workspace,'feature.txt'),'utf8'),'source owner continues editing\n');
    assert.equal(runGit(f.workspace,'branch','--show-current'),'source-owner-later-work');
    assert.deepEqual(f.calls,[f.run.workspaceId]);
  } finally { await f.close(); }
});

test('recorded primary content discard retains the view’s independent archive proof',async()=>{
  const f=await fixture();
  try {
    // The primary archive and scoped retirement are real fixture lifecycle effects.
    // Model the durable owner-discard metadata and archive detail left by the
    // existing discard path; this fixture's intake worktree is not Queue-owned.
    await new Lifecycle(f.engine).archive(f.store.task(f.task.id),f.task.workspaceId!);
    let task=f.store.task(f.task.id);
    assert.ok(task.resolution.archivedWorkspaceIds.includes(task.workspaceId!));
    assert.equal(task.resolution.runtimeRetirements.find(record=>record.workspaceId===task.workspaceId)?.state,'retired');
    f.store.setMeta(workspaceDiscardKey(task.id,task.workspaceId!),{workspaceId:task.workspaceId,directory:task.directory,
      caller:OPERATOR_BOARD_CALLER,authority:'operator',note:null,reason:'Owner authorized discard',at:new Date().toISOString()});
    f.store.db.prepare("UPDATE events SET detail=? WHERE taskId=? AND kind='workspace_archived'").run(
      `workspace_archived; unproven contents discarded by operator (board) (operator); workspace ${task.workspaceId}`,task.id);
    assert.equal(existsSync(f.workspace),false);
    await seedRetry(f);
    task=f.store.task(task.id);
    await f.engine.performTaskControl({taskId:task.id,version:task.version,action:'retry_effect',
      effect:`workspace_archive.${f.run.workspaceId}`,reason:'Archive the separately proved review view',caller:OPERATOR_BOARD_CALLER});
    assert.ok(f.store.task(task.id).resolution.archivedWorkspaceIds.includes(f.run.workspaceId));
    assert.equal(existsSync(f.run.reviewSourceView!.directory!),false);
    assert.deepEqual(f.calls,[f.task.workspaceId,f.run.workspaceId]);
  } finally { await f.close(); }
});
