import type { Submission } from "../../shared/contracts";
import { isParkedTask,submissionSchema,taskHasUnreleasedRun,type Run,type Task } from "../../shared/contracts";
import { pinnedBriefDigest } from "../planning/brief";
import { digest,StoreCore } from "./store-core";
import { StoreTasks } from "./store-tasks";

// Omitted false/empty policy remains identical to legacy submissions.
const submissionPolicyDigest = (
  rest: Record<string, unknown>,
  dependsOn: Submission["dependsOn"],
  brief: Submission["brief"],
  instruction: Submission["instruction"],
  skipPRReview: boolean,
  notifyOriginOnCloseout: boolean,
  completionNotificationAgentIds: Submission["completionNotificationAgentIds"],
  lanes: Submission["lanes"],
  draftProvenance: Submission["draftProvenance"],
  leadProvenance: Submission["leadProvenance"],
  laneDocuments: Submission["laneDocuments"],
  input: Submission,
) => {
  const identity = dependsOn?.length ? { ...rest, dependsOn: [...dependsOn].sort() } : rest;
  const policy = {
    ...identity,
    // A brief is identified by its computed digest, whether or not the caller supplied one.
    ...(brief ? { brief: { mediaType: brief.mediaType, digest: pinnedBriefDigest(input) } } : {}),
    ...(instruction ? { instruction } : {}),
    ...(skipPRReview ? { skipPRReview } : {}),
    ...(notifyOriginOnCloseout ? { notifyOriginOnCloseout } : {}),
    ...(completionNotificationAgentIds.length ? { completionNotificationAgentIds: [...completionNotificationAgentIds].sort() } : {}),
    // The stored idempotency digest predates multi-lane membership. A one-lane
    // submission keeps its historical `{ lane }` shape so an in-flight retry
    // still reconciles the same task, while two or more lanes hash the list form.
    ...(lanes.length === 1 ? { lane: lanes[0] } : lanes.length ? { lanes } : {}),
    ...(draftProvenance ? { draftProvenance } : {}),
    ...(leadProvenance ? { leadProvenance } : {}),
    ...(laneDocuments?.length ? { laneDocuments } : {}),
  };
  return digest(JSON.stringify(policy));
};

const materializedSubmissionHash = (input: Submission, keepExplicitCriticalFalse: boolean) => {
  // Every new task is responsible: the identity digest materializes true at
  // its schema position, so an absent flag hashes like explicit true.
  const normalized = submissionSchema.parse({ ...input, responsible: input.responsible ?? true });
  const { skipPRReview, dependsOn, notifyOriginOnCloseout, completionNotificationAgentIds,
    instruction, brief, lanes, laneDocuments, draftProvenance, leadProvenance, ...rest } = normalized;
  if (rest.mergeHold === false) delete rest.mergeHold;
  if (rest.interactive === false) delete rest.interactive;
  // critical defaults to false, so an explicit false is the same submission as an absent flag.
  if (rest.critical === false && !keepExplicitCriticalFalse) delete rest.critical;
  return submissionPolicyDigest(rest, dependsOn, brief, instruction, skipPRReview, notifyOriginOnCloseout,
    completionNotificationAgentIds, lanes, draftProvenance, leadProvenance, laneDocuments, input);
};

export const submissionHash = (input: Submission) => materializedSubmissionHash(input, false);

/**
 * The identity digest that kept an explicit critical:false (queue.critical,
 * task 723). Rows stored with it keep reconciling through `existing`.
 * Never change this formula.
 */
export const explicitCriticalFalseSubmissionHash = (input: Submission) => materializedSubmissionHash(input, true);

/**
 * The frozen pre-rollout identity digest (before responsible became the
 * default, Tom, 2026-11-01): absent and explicit false both hashed without
 * the field. Rows stored before the rollout keep reconciling through
 * `existing`, which accepts either digest; new rows always store the
 * materialized form above. Never change this formula.
 */
export const legacySubmissionHash = (input: Submission) => {
  const { skipPRReview, dependsOn, notifyOriginOnCloseout, completionNotificationAgentIds,
    instruction, brief, lanes, laneDocuments, draftProvenance, leadProvenance, ...rest } = input;
  if (rest.mergeHold === false) delete rest.mergeHold;
  if (rest.interactive === false) delete rest.interactive;
  if (rest.responsible === false) delete rest.responsible;
  return submissionPolicyDigest(rest, dependsOn, brief, instruction, skipPRReview, notifyOriginOnCloseout,
    completionNotificationAgentIds, lanes, draftProvenance, leadProvenance, laneDocuments, input);
};
interface Ports {
  numberedTask: (data: string) => Task;
  taskReference: (id: string) => ReturnType<StoreTasks["taskReference"]>;
  runs: (taskId?: string) => Run[];
  tasks: () => Task[];
  update: (id: string, change: Partial<Task> & { attention?: never }, kind?: string, detail?: string, expected?: number) => Task;
}
export class StoreSubmissions {
  constructor(private readonly core: StoreCore, private readonly ports: Ports) {}
  private get db() { return this.core.db; }
  private numberedTask = (...args: Parameters<Ports["numberedTask"]>) => this.ports.numberedTask(...args);
  private taskReference = (...args: Parameters<Ports["taskReference"]>) => this.ports.taskReference(...args);
  private runs = (...args: Parameters<Ports["runs"]>) => this.ports.runs(...args);
  private tasks = (...args: Parameters<Ports["tasks"]>) => this.ports.tasks(...args);
  private update = (...args: Parameters<Ports["update"]>) => this.ports.update(...args);

  existing(input: Submission): Task | null {
    const row = this.db.prepare("SELECT data,input_hash FROM tasks WHERE submission=?").get(input.submissionId);
    if (!row) {
      const purged=this.db.prepare("SELECT id FROM tombstones WHERE submission=?").get(input.submissionId);
      if(purged)throw new Error(`Submission ${input.submissionId} already belongs to purged task ${purged.id}; it will not be dispatched again`);
      return null;
    }
    // Rows stored before responsible became the default (Tom, 2026-11-01)
    // keep the pre-rollout digest with the flag omitted; a replay of the same
    // submission still reconciles its task instead of refusing. Rows stored
    // with an explicit critical false keep that digest too.
    if (row.input_hash !== submissionHash(input) && row.input_hash !== legacySubmissionHash(input)
      && row.input_hash !== explicitCriticalFalseSubmissionHash(input))
      throw new Error("Submission ID already used with different content");
    return this.numberedTask(String(row.data));
  }

  validateDependencies(input: Submission) {
    for (const id of input.dependsOn) {
      let dependency: ReturnType<StoreTasks["taskReference"]>;
      try { dependency = this.taskReference(id); } catch { throw new Error(`Prerequisite task does not exist: ${id}. Submit prerequisites first.`); }
      if (dependency.submissionId === input.submissionId) throw new Error("A task cannot depend on itself");
      if (dependency.removedAt && dependency.phase !== "done") throw new Error(`Prerequisite was removed before completion: ${dependency.title} (${id})`);
    }
  }

  promoteQueuedTask(task:Task,actor="operator control"):Task {
    const hasUnreleasedRun = this.runs(task.id).some(run => !run.released);
    const queued = task.phase === "queued" && !taskHasUnreleasedRun(task, hasUnreleasedRun);
    const parked = isParkedTask(task, hasUnreleasedRun) &&
      (task.phase !== "needs_attention" || Boolean(task.resolution.recovery));
    if(task.removedAt || (!queued && !parked) || task.resolution.mergeIntent || task.resolution.mergedCommit)
      throw Error("Only a queued or parked, unmerged task can be promoted");
    const liveTasks = this.tasks().filter(candidate => !candidate.removedAt && !["done", "cancelled"].includes(candidate.phase));
    const front=Math.max(0,...liveTasks.map(candidate=>candidate.queuePriority));
    const tiedAtFront = liveTasks.some(candidate => candidate.id !== task.id && candidate.queuePriority === front);
    if(task.queuePriority===front&&front>0&&!tiedAtFront)return task;
    return this.update(task.id,{queuePriority:front+1},"queue_promoted",`Promoted to the front of slot admission for ${task.repoPath}; requested by ${actor}`,task.version);
  }
}
