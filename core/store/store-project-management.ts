import { taskHasUnreleasedRun, projectPlanSchema, projectQaRunSchema, projectSchema, projectTombstoneSchema, type BulkDisposition, type BulkDispositionRequest, type Decision, type Lane, type Lead, type Outcome, type PendingSubmission, type ProjectManageInput, type ProjectManagementPreview, type ProjectPlan, type ProjectTombstone, type Run, type Task } from "../../shared/contracts";
import { type QueueOperation } from "../../shared/operations";
import { projectRemovalBlockers, projectRepositoryMatches } from "../../shared/project-removal";
import { digest, now, StoreCore } from "./store-core";
import { joinPlanEntries } from "./store-project-merge";
import { type StoreProjectRegistry } from "./store-project-registry";
import { type StoreProjectRemoval } from "./store-project-removal";

interface ManagementAccess {
  allTasks(): Task[];
  leads(): Lead[];
  lanes(): Lane[];
  outcomes(): Outcome[];
  taskRepositories(): Array<{ taskId: string; repository: string }>;
  listDecisions(query: { status?: Decision["status"] }): Decision[];
  pendingSubmissions(): PendingSubmission[];
  numberedOperation(data: string): QueueOperation;
  operationPayload(id: string): unknown;
  plan(input: { project: string }): ProjectPlan;
  runs(taskId?: string): Run[];
  updateLead(lead: Lead): Lead;
  setLaneStatus(key: string, status: Lane["status"], note?: string): Lane;
  updateDecision(decision: Decision): Decision;
}

/**
 * Project management: the preview a confirmation is taken from, the cancellation
 * reset, and the one confirmed write that deletes a project or reassigns its
 * contents to another project. The record side of a removal is `StoreProjectRemoval`.
 */
export class StoreProjectManagement {
  constructor(private readonly core: StoreCore, private readonly registry: StoreProjectRegistry,
    private readonly removal: StoreProjectRemoval, private readonly access: ManagementAccess) {}
  private get db() { return this.core.db; }

  /** Confirmation identity excludes task progress, but includes every task ID and complete planning records. */
  managementRecords(key: string) {
    const project = this.registry.projectByKey(key);
    if (!project) throw new Error(`Unknown project ${key}`);
    const matches = (repo: { origin?: string | null; path?: string | null }) => projectRepositoryMatches(project, repo.path, repo.origin);
    const tasks = this.access.allTasks().filter(task => projectRepositoryMatches(project, task.repoPath, task.repository));
    const leads = this.access.leads().filter(lead => (lead.state === "open" || lead.state === "promoted" && Boolean(lead.papercut)) && lead.repositories.some(matches));
    const lanes = this.access.lanes().filter(lane => (lane.status === "active" || lane.status === "paused") && lane.repositories.some(matches));
    // Resolve by ID through the same authoritative blocker predicate, including purged task history.
    const decisions = this.access.listDecisions({status:"open"}).filter(decision => projectRemovalBlockers(project, {
      tasks:this.access.allTasks(), leads:this.access.leads(), outcomes:this.access.outcomes(), taskRepositories:this.access.taskRepositories(),
      lanes:[], submissions:[], decisions:[decision],
    }).some(blocker => blocker.kind === "decision"));
    const submissions = this.access.pendingSubmissions().filter(item => projectRepositoryMatches(project, item.repoPath, item.repository));
    const operations = this.db.prepare("SELECT data FROM operations WHERE state IN ('pending','running','needs_attention') ORDER BY rowid").all().map(row=>this.access.numberedOperation(String(row.data))).filter(operation=>{
      const payload=this.access.operationPayload(operation.id) as {id?:string;source?:{id?:string};submission?:{repoPath:string};input?:{submission?:{repoPath:string}}}|null;
      return projectRepositoryMatches(project,operation.repoPath) || Boolean(operation.taskId && tasks.some(task=>task.id===operation.taskId)) || Boolean(payload && (
        leads.some(lead=>lead.id===(payload.source?.id??payload.id)) ||
        projectRepositoryMatches(project,payload.submission?.repoPath??payload.input?.submission?.repoPath)));
    });
    const qa = this.db.prepare("SELECT data FROM project_qa_runs WHERE json_extract(data,'$.state') IN ('queued','running') OR json_extract(data,'$.finishedAt') IS NULL").all()
      .map(row=>projectQaRunSchema.parse(JSON.parse(String(row.data)))).filter(run=>matches(run.repository));
    return {project,tasks,leads,lanes,decisions,submissions,operations,qa,plan:this.access.plan({project:key})};
  }

  projectManagementPreview(input: {key: string; target?: string}): ProjectManagementPreview {
    if (input.target === input.key) throw new Error("Choose a different destination project");
    const records = this.managementRecords(input.key);
    const target = input.target ? this.managementRecords(input.target) : null;
    const shared = (repos: Array<{origin?:string|null;path?:string|null}>) => repos.some(repo => !projectRepositoryMatches(records.project,repo.path,repo.origin));
    const items: ProjectManagementPreview["items"] = [
      ...records.tasks.filter(task=>task.phase!=="done"&&task.phase!=="cancelled").map(task=>({kind:"task" as const,id:task.id,label:task.reference??task.title,shared:false})),
      ...records.leads.map(lead=>({kind:lead.papercut?"papercut" as const:"lead" as const,id:lead.id,label:lead.title,shared:shared(lead.repositories)})),
      ...records.lanes.map(lane=>({kind:"lane" as const,id:lane.key,label:lane.title||lane.key,shared:shared(lane.repositories)})),
      ...records.decisions.map(decision=>({kind:"decision" as const,id:decision.id,label:decision.question,shared:true})),
      ...records.operations.map(item=>({kind:"operation" as const,id:item.id,label:`${item.kind}: ${item.state}`,shared:false})),
      ...records.qa.map(item=>({kind:"qa" as const,id:item.id,label:`QA ${item.state}`,shared:false})),
      ...records.submissions.map(item=>({kind:"submission" as const,id:item.id,label:item.title,shared:false})),
    ];
    const identity = (value: typeof records) => ({...value,tasks:value.tasks.map(task=>task.id).sort()});
    const cancellation=this.db.prepare("SELECT value FROM meta WHERE key LIKE 'bulkDisposition:%' ORDER BY rowid DESC").all()
      .map(row=>JSON.parse(String(row.value)) as BulkDisposition)
      .find(batch=>batch.operationId?.startsWith(`project-removal-${input.key.slice(0,64)}-`) && batch.action==="cancel" && batch.workDisposition==="preserve" && batch.items.length>0 && batch.items.every(item=>records.tasks.some(task=>task.id===item.taskId)))??null;
    return {project:records.project,target:target?.project??null,items,cancellation,
      tasks:records.tasks.filter(task=>task.phase!=="done"&&task.phase!=="cancelled").map(task=>({taskId:task.id,version:task.version})),
      digest:digest(JSON.stringify([identity(records),target ? identity(target) : null]))};
  }

  resetProjectCancellation(input: {key:string;operationId:string;tasks:Array<{taskId:string;version:number}>}) {
    return this.core.transaction(() => {
      if (!input.operationId.startsWith(`project-removal-${input.key.slice(0,64)}-`)) throw new Error("Cancellation identity does not belong to this project cleanup");
      if (this.core.getMeta(`bulkDisposition:${input.operationId}`)) throw new Error("Cancellation was accepted; reconcile its existing receipt instead");
      const refused=this.core.getMeta<{input:BulkDispositionRequest}>(`bulkDispositionRefused:${input.operationId}`);
      if (!refused || refused.input.action!=="cancel" || refused.input.workDisposition!=="preserve" || JSON.stringify(refused.input.tasks)!==JSON.stringify(input.tasks))
        throw new Error("No matching definitive refusal; preserve uncertain delivery and reconcile its original identity");
      const records=this.managementRecords(input.key);
      const current=input.tasks.map(item=>{
        const task=records.tasks.find(task=>task.id===item.taskId);
        if (!task) throw new Error("Cancellation task identity is not in this project");
        return {task,version:item.version};
      });
      if (!current.some(({task,version})=>task.version>version && !task.disposition)) throw new Error("Unaccepted delivery is not proven stale; preserve the request identity and reconcile it");
      // The same transaction retires the ID. A queued or late original delivery
      // checks this fence before ever accepting a batch or cancelling a task.
      this.core.setMeta(`bulkDispositionRetired:${input.operationId}`,{reason:"Stale unaccepted project cancellation",tasks:input.tasks,at:now()});
      return {reset:true as const};
    });
  }

  /**
   * Confirmed project management. With a target, the project's contents move into it
   * as one write and its record is tombstoned; without one, the project is removed
   * once every attached record has settled. Either way the receipt is kept under the
   * confirmation digest, so a repeated confirmation returns the same result.
   */
  manageRemoveProject(input: ProjectManageInput): ProjectTombstone {
    return this.core.transaction(() => {
      const receiptKey=`projectManagement:${input.key}:${input.digest}`;
      const receipt=this.core.getMeta<{input:ProjectManageInput;result:ProjectTombstone}>(receiptKey);
      if (receipt) {
        if (JSON.stringify(receipt.input)!==JSON.stringify(input)) throw new Error("This confirmation already belongs to another project cleanup request");
        return receipt.result;
      }
      const record=(result:ProjectTombstone)=>{this.core.setMeta(receiptKey,{input,result});return result};
      const preview = this.projectManagementPreview({key:input.key,target:input.target});
      if (preview.project.version!==input.version || preview.digest!==input.digest) throw new Error("Project or attached work changed; refresh the confirmation before continuing");
      const records = this.managementRecords(input.key);
      if (records.qa.length) throw new Error("Project QA must settle before moving or deleting the project");
      if (input.target) {
        if (input.cancellationOperationId) throw new Error("Reassignment must not cancel work");
        const destination = preview.target!;
        const members = [...destination.repositories];
        for (const repo of records.project.repositories) if (!members.some(member=>(member.origin??member.path)===(repo.origin??repo.path))) members.push(repo);
        const updated = projectSchema.parse({...destination,repositories:members,version:destination.version+1});
        const targetPlan = this.access.plan({project:destination.key});
        this.registry.persist(updated);
        let nextPlanVersion = targetPlan.version;
        // The source's plan history moves with its repositories; each version is renumbered onto the target.
        for (const row of this.db.prepare("SELECT data FROM project_plans WHERE project=? ORDER BY version").all(input.key)) {
          const old = projectPlanSchema.parse(JSON.parse(String(row.data)));
          this.db.prepare("INSERT INTO project_plans(project,version,data) VALUES(?,?,?)").run(destination.key,++nextPlanVersion,JSON.stringify({...old,project:destination.key,version:nextPlanVersion}));
        }
        // The moved order joins the target's current order by the one join rule that mergeProject uses.
        const joined = joinPlanEntries(targetPlan, records.plan);
        this.db.prepare("INSERT INTO project_plans(project,version,data) VALUES(?,?,?)").run(destination.key,++nextPlanVersion,JSON.stringify(projectPlanSchema.parse({project:destination.key,version:nextPlanVersion,...joined,author:"operator (project management)",createdAt:now()})));
        // Record history stays on its original repository identities; only membership changes.
        this.db.prepare("DELETE FROM project_plans WHERE project=?").run(input.key);
        this.db.prepare("DELETE FROM projects WHERE key=?").run(input.key);
        const tombstone = projectTombstoneSchema.parse({key:input.key,repositories:records.project.repositories,reason:input.reason,removedAt:now()});
        this.db.prepare("INSERT INTO project_tombstones(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data").run(input.key,JSON.stringify(tombstone));
        this.core.advanceRevision();
        return record(tombstone);
      }
      if (records.operations.length) throw new Error("Accepted operations must settle before removal; move the project contents instead or resolve the listed operations");
      if (records.submissions.length) throw new Error("Pending submissions must settle before removal; move the project contents instead or refresh after settlement");
      if (preview.tasks.length) throw new Error("Cancel the listed tasks with preserved work before removing the project");
      // Cancellation has external side effects; finish only after its durable operation and all leases settle.
      if (input.cancellationOperationId) {
        const operation = this.core.getMeta<BulkDisposition>(`bulkDisposition:${input.cancellationOperationId}`);
        if (!operation || operation.status!=="complete" || operation.action!=="cancel" || operation.workDisposition!=="preserve" || operation.items.some(item=>!records.tasks.some(task=>task.id===item.taskId)))
          throw new Error("Task cancellation has not completed for this project");
      }
      if (records.tasks.some(task=>taskHasUnreleasedRun(task,this.access.runs(task.id).some(run=>!run.released)) || (task.disposition && task.disposition.status!=="complete"))) throw new Error("Task work preservation is still settling; refresh before deleting");
      const stamp=now();
      for (const lead of records.leads) this.access.updateLead({...lead,state:lead.papercut?"closed":"dropped",dropReason:lead.papercut?lead.dropReason:input.reason,
        closure:lead.papercut?{reason:"deprecated",note:input.reason,at:stamp}:lead.closure,updatedAt:stamp,closedAt:stamp});
      for (const lane of records.lanes) this.access.setLaneStatus(lane.key,"abandoned",input.reason);
      for (const decision of records.decisions) {
        const withdrawal={reason:input.reason,withdrawnBy:"operator (project management)",withdrawnAt:stamp};
        this.access.updateDecision({...decision,status:"withdrawn",withdrawal,version:decision.version+1,updatedAt:stamp,
          versions:[...decision.versions,{version:decision.version+1,question:decision.question,context:decision.context,options:decision.options,recommendation:decision.recommendation,headline:decision.headline,choices:decision.choices,recommended:decision.recommended,details:decision.details,links:decision.links,status:"withdrawn",answer:decision.answer,withdrawal,supersededBy:decision.supersededBy,by:withdrawal.withdrawnBy,at:stamp}]});
      }
      return record(this.removal.removeProject({key:input.key,version:input.version,reason:input.reason}));
    });
  }
}
