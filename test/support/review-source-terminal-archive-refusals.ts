import assert from 'node:assert/strict';
import { existsSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Lifecycle } from '../../core/closeout/workspace-lifecycle';
import { workspaceDiscardKey } from '../../core/workspaces/orphan-worktree';
import { OPERATOR_BOARD_CALLER } from '../../shared/contracts';
import { runGit } from './review-entry-fixture';
import { fixture, seedRetry } from './review-source-terminal-archive-fixture';


export type Fault = 'missing-event'|'discard-without-intent'|'failed-retirement'|'retirement-before-capture'|'failed-view-retirement'|'dirty'|'index'|'untracked'|'foreign-origin'|'source-alias'|'source-recreated'|'foreign-thread'|'busy-thread'|'unpublished'|'missing-canonical'|'unreleased';
export async function assertArchiveRefusals(faults: readonly Fault[]) {
  for(const fault of faults){
    const f=await fixture();
    try {
      await new Lifecycle(f.engine).archive(f.store.task(f.task.id),f.task.workspaceId!);
      await seedRetry(f);
      let task=f.store.task(f.task.id);
      const directory=f.run.reviewSourceView!.directory!;
      if(fault==='missing-event') f.store.db.prepare("DELETE FROM events WHERE taskId=? AND kind='workspace_archived'").run(task.id);
      if(fault==='discard-without-intent') {
        f.store.setMeta(workspaceDiscardKey(task.id,task.workspaceId!),{workspaceId:task.workspaceId,directory:task.directory});
        f.store.db.prepare("UPDATE events SET detail=? WHERE taskId=? AND kind='workspace_archived'").run(`workspace_archived; observed absent from the catalog and disk without a Queue archive intent; workspace ${task.workspaceId}`,task.id);
      }
      if(fault==='failed-retirement') f.store.update(task.id,{resolution:{...task.resolution,runtimeRetirements:task.resolution.runtimeRetirements.map(record=>record.workspaceId===task.workspaceId?{...record,state:'failed',error:'runtime retirement failed'}:record)}});
      if(fault==='retirement-before-capture') f.store.update(task.id,{resolution:{...task.resolution,runtimeRetirements:task.resolution.runtimeRetirements.map(record=>record.workspaceId===task.workspaceId?{...record,provedAt:'2000-01-01T00:00:00.000Z'}:record)}});
      if(fault==='failed-view-retirement') f.store.update(task.id,{resolution:{...task.resolution,runtimeRetirements:task.resolution.runtimeRetirements.map(record=>record.workspaceId===f.run.workspaceId?{...record,state:'failed',error:'runtime retirement failed'}:record)}});
      if(fault==='dirty') writeFileSync(join(directory,'feature.txt'),'changed');
      if(fault==='index'){writeFileSync(join(directory,'feature.txt'),'staged change');runGit(directory,'add','feature.txt');}
      if(fault==='untracked') writeFileSync(join(directory,'untracked-source'),'unowned');
      if(fault==='source-recreated') mkdirSync(f.workspace);
      if(fault==='foreign-origin') runGit(f.repo,'config','remote.origin.url','https://github.com/foreign/repository.git');
      if(fault==='source-alias') symlinkSync(directory,f.workspace,'dir');
      if(fault==='foreign-thread') f.agents.push({id:'foreign',workspaceId:f.run.workspaceId,labels:{},status:'idle'});
      if(fault==='busy-thread') f.agents.push({id:'busy',workspaceId:f.run.workspaceId,labels:{'northstar.task':task.id},status:'idle',pendingPermissions:[{id:'permission'}]});
      if(fault==='unpublished'){runGit(f.repo,'push','origin','--delete','feature/external');runGit(f.repo,'push','--force','origin',`${f.planningCommit}:refs/heads/main`);}
      if(fault==='missing-canonical') renameSync(f.repo,join(f.root,'unavailable-repo'));
      if(fault==='unreleased'){
        f.store.putRun({...f.store.run(f.run.id)!,released:false,status:'running'});
        f.states.set('review-agent',{id:'review-agent',workspaceId:f.run.workspaceId,status:'running',active:true,permissions:false,error:''});
      }
      task=f.store.task(task.id);
      await assert.rejects(f.engine.performTaskControl({taskId:task.id,version:task.version,action:'retry_effect',effect:`workspace_archive.${f.run.workspaceId}`,reason:'Retry proof refusal',caller:OPERATOR_BOARD_CALLER}),fault);
      assert.equal(existsSync(directory),true,fault);
      assert.equal(f.calls.length,1,`${fault}: no view archive`);
    } finally { await f.close(); }
  }
}
