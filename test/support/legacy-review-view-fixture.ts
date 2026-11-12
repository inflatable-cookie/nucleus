import {randomUUID} from "node:crypto";
import {realpathSync} from "node:fs";
import {join} from "node:path";
import type {Run} from "../../shared/contracts";
import {currentBrief} from "../../core/planning/brief";
import {runGit} from "./review-entry-fixture";
import type {ownerRevisionFixture} from "./review-entry-fixture";

type Fixture=ReturnType<typeof ownerRevisionFixture>;

/** Reconstruct a stored pinned view from a prior build; current code only reads and retires it. */
export function materializeLegacyView(f:Fixture,store:Fixture['store'],runId:string){
  const task=store.task(store.run(runId)!.taskId),run=store.run(runId)!;
  if(run.reviewSourceView)return run;
  const receipt=task.resolution.externalOwnerRevisions?.at(-1),brief=currentBrief(task);
  const workspaceId=`wks_${randomUUID().replaceAll('-','').slice(0,16)}`;
  const view:NonNullable<Run['reviewSourceView']>={creationId:randomUUID(),workspaceId,runId,
    sourceWorkspaceId:task.workspaceId!,sourceDirectory:task.directory!,
    ...(receipt?{receiptOperationId:receipt.operationId,receiptAt:receipt.at}
      :{provenance:'review_entry_intake' as const,intakeOperationId:task.reviewEntry!.operationId,receiptOperationId:null,receiptAt:task.reviewEntry!.checkedAt}),
    head:run.head,tree:runGit(f.workspace,'rev-parse',`${run.head}^{tree}`),
    commonDir:realpathSync(runGit(f.repo,'rev-parse','--path-format=absolute','--git-common-dir')),
    origin:runGit(f.repo,'config','--get','remote.origin.url'),branch:`ns-review-${run.id}`,directory:null,state:'intent',agentCreationIntent:false,
    briefDigest:brief?.digest??null,briefVersion:brief?.version??null};
  const saved={...run,workspaceId,reviewSourceView:view};
  store.putRun(saved);
  if(run.agentId)f.states.set(run.agentId,{id:run.agentId,workspaceId,status:'idle',active:false,permissions:false,error:'',model:f.reviewer.model,provider:f.reviewer.provider});
  const directory=join(f.root,`legacy-review-view-${run.id}`);
  runGit(f.repo,'worktree','add','-b',view.branch,directory,run.head);
  const result={...saved,reviewSourceView:{...view,directory,state:'ready' as const}};
  store.putRun(result);
  return result;
}
