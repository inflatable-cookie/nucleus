import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Lifecycle } from '../core/closeout/workspace-lifecycle';
import { verifyReviewSourceView } from '../core/review/review-source';
import { operationInputHash } from '../core/store/store';
import { OPERATOR_BOARD_CALLER, taskControlInputSchema } from '../shared/contracts';
import { runGit } from './support/review-entry-fixture';
import { fixture, seedRetry } from './support/review-source-terminal-archive-fixture';

test('terminal retry archives the released pinned view after authentic primary archive and retirement',async()=>{
  const f=await fixture();
  try {
    await new Lifecycle(f.engine).archive(f.store.task(f.task.id),f.task.workspaceId!);
    const primary=f.store.task(f.task.id);
    assert.equal(existsSync(f.workspace),false);
    assert.equal(primary.resolution.runtimeRetirements.find(item=>item.workspaceId===f.task.workspaceId)?.state,'retired');
    await assert.rejects(()=>verifyReviewSourceView(primary,f.store.run(f.run.id)!),/ENOENT/,'parent implementation requires removed primary');
    const receipts=JSON.stringify(primary.resolution.externalOwnerRevisions),review=JSON.stringify(primary.resolution.review);
    await seedRetry(f);
    const control=taskControlInputSchema.parse({taskId:f.task.id,version:f.store.task(f.task.id).version,action:'retry_effect',effect:`workspace_archive.${f.run.workspaceId}`,reason:'Retry the released view archive',caller:OPERATOR_BOARD_CALLER});
    const payload={type:'task_control' as const,control};
    const accepted=f.store.acceptOperation({key:'review-view-archive-retry',kind:'task_control',inputHash:operationInputHash(payload),taskId:control.taskId,expectedVersion:control.version,payload});
    assert.ok('accepted' in accepted);
    f.store.putOperation({...accepted.operation,state:'running',startedAt:new Date().toISOString(),attempts:1});
    await f.engine.performTaskControl(control,accepted.operation.id);
    const result=f.store.task(f.task.id);
    assert.ok(result.resolution.archivedWorkspaceIds.includes(f.run.workspaceId));
    assert.equal(existsSync(f.run.reviewSourceView!.directory!),false);
    assert.deepEqual(f.calls,[f.task.workspaceId,f.run.workspaceId]);
    assert.equal(JSON.stringify(result.resolution.externalOwnerRevisions),receipts);
    assert.equal(JSON.stringify(result.resolution.review),review);
    await f.engine.performTaskControl(control,accepted.operation.id);
    assert.equal(f.calls.length,2,'replaying the durable operation never resends the effect');
  } finally { await f.close(); }
});

test('a retirement proved before reconciliation of the primary archive still permits view retry',async()=>{
  const f=await fixture();
  try {
    f.delivery.lost=true;f.delivery.teardownFailure=true;
    await new Lifecycle(f.engine).archive(f.store.task(f.task.id),f.task.workspaceId!);
    let task=f.store.task(f.task.id);
    assert.equal(task.resolution.archiveIntentWorkspaceId,f.task.workspaceId);
    assert.equal(task.resolution.runtimeRetirements.find(record=>record.workspaceId===f.task.workspaceId)?.state,'failed');
    assert.ok(existsSync(f.workspace));assert.deepEqual(f.calls,[f.task.workspaceId]);
    await f.engine.retirement.retryNow(task.id);
    const retirement=f.store.task(task.id).resolution.runtimeRetirements.find(record=>record.workspaceId===f.task.workspaceId)!;
    assert.equal(retirement.state,'retired');assert.ok(retirement.provedAt);
    // The earlier native archive completes asynchronously after its lost reply.
    runGit(f.repo,'worktree','remove',f.workspace);
    await new Promise(resolve=>setTimeout(resolve,10));
    await new Lifecycle(f.engine).archive(f.store.task(task.id),f.task.workspaceId!);
    task=f.store.task(task.id);
    const archive=f.store.eventsAll(task.id).find(event=>event.kind==='workspace_archived'&&event.detail.split('; ').includes(`workspace ${f.task.workspaceId}`));
    assert.ok(archive);assert.ok(archive.at>retirement.provedAt!,'retirement precedes archive confirmation');
    assert.ok(task.resolution.archivedWorkspaceIds.includes(f.task.workspaceId!));
    assert.deepEqual(f.calls,[f.task.workspaceId],'native archive is never resent');
    f.delivery.lost=false;
    await seedRetry(f);
    task=f.store.task(task.id);
    await f.engine.performTaskControl({taskId:task.id,version:task.version,action:'retry_effect',effect:`workspace_archive.${f.run.workspaceId}`,reason:'Archive after reconciled primary',caller:OPERATOR_BOARD_CALLER});
    assert.ok(f.store.task(task.id).resolution.archivedWorkspaceIds.includes(f.run.workspaceId));
    assert.deepEqual(f.calls,[f.task.workspaceId,f.run.workspaceId]);
  } finally { await f.close(); }
});

test('terminal retry archives a historical old-head view without replacing its receipt',async()=>{
  const f=await fixture(false,true);
  try {
    const before=f.store.task(f.task.id),reader=f.store.run(f.run.id)!;
    assert.notEqual(reader.head,before.prHead);
    assert.equal(reader.completion?.status,'ready_to_merge');
    const receipt=JSON.stringify(before.resolution.externalOwnerRevisions);
    await new Lifecycle(f.engine).archive(before,f.task.workspaceId!);
    await seedRetry(f);
    const current=f.store.task(f.task.id);
    await f.engine.performTaskControl({taskId:current.id,version:current.version,action:'retry_effect',effect:`workspace_archive.${reader.workspaceId}`,reason:'Archive historical view',caller:OPERATOR_BOARD_CALLER});
    assert.ok(f.store.task(current.id).resolution.archivedWorkspaceIds.includes(reader.workspaceId));
    assert.equal(JSON.stringify(f.store.task(current.id).resolution.externalOwnerRevisions),receipt);
  } finally { await f.close(); }
});

test('terminal retry keeps a genuine historical receipt and authenticated partial-reader checkpoint',async()=>{
  const f=await fixture(true);
  try {
    const before=f.store.task(f.task.id), reader=f.store.run(f.run.id)!;
    assert.notEqual(reader.head,before.prHead);
    assert.equal(reader.status,'superseded');assert.equal(reader.released,true);
    assert.equal(reader.reviewCheckpoints!.length,1);
    const receipt=JSON.stringify(before.resolution.externalOwnerRevisions),checkpoint=JSON.stringify(reader.reviewCheckpoints);
    await new Lifecycle(f.engine).archive(before,f.task.workspaceId!);
    await seedRetry(f);
    const current=f.store.task(f.task.id);
    await f.engine.performTaskControl({taskId:current.id,version:current.version,action:'retry_effect',effect:`workspace_archive.${reader.workspaceId}`,reason:'Archive historical released view',caller:OPERATOR_BOARD_CALLER});
    assert.ok(f.store.task(current.id).resolution.archivedWorkspaceIds.includes(reader.workspaceId));
    assert.equal(JSON.stringify(f.store.task(current.id).resolution.externalOwnerRevisions),receipt);
    assert.equal(JSON.stringify(f.store.run(reader.id)!.reviewCheckpoints),checkpoint);
    assert.equal(f.store.task(current.id).resolution.review,null);
  } finally { await f.close(); }
});


test('unknown archive delivery is observed and never blindly resent',async()=>{
  const f=await fixture();
  try {
    await new Lifecycle(f.engine).archive(f.store.task(f.task.id),f.task.workspaceId!);
    await seedRetry(f);f.delivery.lost=true;
    let task=f.store.task(f.task.id);
    await assert.rejects(f.engine.performTaskControl({taskId:task.id,version:task.version,action:'retry_effect',effect:`workspace_archive.${f.run.workspaceId}`,reason:'Retry once',caller:OPERATOR_BOARD_CALLER}));
    assert.equal(f.calls.length,2);
    assert.equal(f.store.task(task.id).resolution.archiveIntentWorkspaceId,f.run.workspaceId);
    f.delivery.unavailable=true;task=f.store.task(task.id);
    await assert.rejects(f.engine.performTaskControl({taskId:task.id,version:task.version,action:'retry_effect',effect:`workspace_archive.${f.run.workspaceId}`,reason:'Observe delivery',caller:OPERATOR_BOARD_CALLER}),/catalog unavailable/);
    assert.equal(f.calls.length,2);assert.ok(existsSync(f.run.reviewSourceView!.directory!));
  } finally { await f.close(); }
});

test('missing view and unavailable canonical backing never settle from disappearance',async()=>{
  const f=await fixture();
  try {
    await new Lifecycle(f.engine).archive(f.store.task(f.task.id),f.task.workspaceId!);
    await seedRetry(f);
    runGit(f.repo,'worktree','remove',f.run.reviewSourceView!.directory!);
    f.archived.add(f.run.workspaceId);
    renameSync(f.repo,join(f.root,'unavailable-repo'));
    const task=f.store.task(f.task.id);
    await assert.rejects(f.engine.performTaskControl({taskId:task.id,version:task.version,action:'retry_effect',effect:`workspace_archive.${f.run.workspaceId}`,reason:'Observe missing view',caller:OPERATOR_BOARD_CALLER}));
    assert.ok(!f.store.task(task.id).resolution.archivedWorkspaceIds.includes(f.run.workspaceId));
    assert.equal(f.calls.length,1);
  } finally { await f.close(); }
});
