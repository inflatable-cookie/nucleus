import { propagateQuantumDeferral } from "../../scheduling/pass-snapshot";
import type { OwnerAcceptanceRecord, Task } from "../../../shared/contracts";
import { normalizeRepositoryOrigin } from "../../../shared/lanes";
import type { Engine } from "../../engine";
import type { AgentObservation } from "../../host/adapter";
import { hostFailureRefusalDetail } from "../../host/errors";
import { executionParticipants } from "../../machine/execution-participants";
import { runFenceRefusal, runSettlementFence } from "../../intake/run-settlement";
import { taskPrNumber } from "../../forge/index";
import { now } from "../../store/store";
import { qualifiedAcceptanceEligibility } from "../owner-verbs";

/**
 * A refused review-entry external-merge reconciliation is definite. It only reads
 * evidence (forge, workspace, owners) and commits in one store transaction, so a
 * refusal with no merge record proves nothing was accepted — even when the
 * observation it names was unreadable, active or unknown (task 408).
 */
export class ExternalMergeRefusal extends Error {
  constructor(message: string) { super(message); this.name = 'ExternalMergeRefusal'; }
}

/** The owner's external-merge reconciliation request, shared by both closeout routes. */
export type ExternalMergeInput = {
  task: Task;
  reason: string;
  caller?: string;
  qualification?: string;
  head?: string;
  relayed?: boolean;
  relayNote?: string;
  operationId?: string;
};

/**
 * An operator source acceptance of a PR merged outside Queue, for a task that has
 * a retained worker, workspace and recorded PR source. The exact final head is
 * named, the forge reports it merged, and the acceptance is one durable record
 * over that head; nothing is minted as review, verdict or proof.
 */
export async function reconcileRetainedExternalMerge(engine: Engine, input: ExternalMergeInput & { qualification: string }): Promise<Task> {
  const store = engine.store;
  const { task } = input, qualification = input.qualification.trim();
  if (['queued', 'dispatching'].includes(task.phase) || !task.agentId || !task.runId || !task.workspaceId || !task.directory || !task.prHead || !task.prUrl)
    throw new ExternalMergeRefusal('An operator source acceptance in a closeout applies only to a never-dispatched review-entry task at its boundary or a dispatched task with a retained worker, workspace and recorded PR source; this task is outside that boundary');
  if (!qualification || !input.head || !/^[a-f0-9]{40}$/.test(input.head))
    throw new ExternalMergeRefusal('Accepting a descendant external merge requires qualification and the exact final head');
  const authority = engine.assertOwnerAuthority(input.caller, input.relayed, input.relayNote, 'External-merge source acceptance');
  const project = store.projectFor(task.repoPath, normalizeRepositoryOrigin(task.repository ?? ''));
  if (!project) throw new ExternalMergeRefusal('The task project is not registered');
  const runs = store.runs(task.id), projectIdentity = JSON.stringify(project), runsIdentity = JSON.stringify(runs);
  const operationId = input.operationId;
  const assertState = () => {
    const current = store.task(task.id);
    if (current.version !== task.version || JSON.stringify(store.runs(task.id)) !== runsIdentity
      || JSON.stringify(store.projectFor(task.repoPath, normalizeRepositoryOrigin(task.repository ?? ''))) !== projectIdentity)
      throw Error('Task, runs or project changed during external merge observation');
    for (const run of store.runs(task.id).filter(item => !item.released)) {
      const fence = runSettlementFence({ store, task: current }, run);
      if (fence) throw Error(runFenceRefusal(run, fence));
    }
  };
  const acceptanceFor = (head: string): OwnerAcceptanceRecord => {
    if (head !== input.head) throw Error(`The observed merged head ${head} differs from the exact head accepted`);
    const eligible = qualifiedAcceptanceEligibility({ ...store.task(task.id), prHead: head }, store.runs(task.id));
    if (!eligible.available) throw Error(eligible.refusal);
    if (eligible.acceptance !== 'operator_source') throw Error('Current-head review evidence cannot be replaced by source acceptance');
    return { at: now(), kind: 'operator_source', head, prNumber: taskPrNumber(task), review: null,
      actor: { agentId: input.caller!, role: authority.role }, authority: { kind: authority.kind, note: authority.note },
      reason: input.reason.trim().slice(0, 4000), qualification: qualification.slice(0, 4000), missingEvidence: eligible.missingEvidence.slice(0, 4000) };
  };
  const participants = executionParticipants(task, runs);
  const assertQuiet = async () => {
    const workspaces = await engine.adapter.findWorkspaces(task);
    if (workspaces.length !== 1 || workspaces[0]!.id !== task.workspaceId || workspaces[0]!.directory !== task.directory)
      throw Error('Retained workspace registration is missing, aliased or changed');
    for (const [id, workspaceId] of participants) {
      if (store.unreleasedRunsForAgent(id, task.hostId).some(run => run.taskId !== task.id)) throw Error(`Participant ${id} owns another unreleased run`);
      engine.admission?.invalidate(id);
      let observed: AgentObservation;
      try { observed = await engine.host.observe(id); }
      catch (error) { throw Error(`Participant ${id} could not be observed (${hostFailureRefusalDetail(error)})`); }
      if (!observed.workspaceId || (workspaceId && observed.workspaceId !== workspaceId) || observed.id !== id || observed.active !== false
        || observed.permissions !== false || observed.activeTurnId || !['idle', 'error', 'closed'].includes(observed.status))
        throw Error(`Participant ${id} is active, permission-holding or unobservable`);
    }
    assertState();
  };
  try {
    assertState();
    const settleOperation = (settled: Task) => {
      const operation = operationId ? store.operation(operationId) : null;
      // The shared owner move releases its own stop hold. Settle it here so
      // an interrupted response cannot strand a hold after a successful move.
      engine.releaseOwnerStopHold(settled.id);
      settled = store.task(settled.id);
      if (operation?.taskId !== settled.id || operation.state !== 'running') return;
      const at = now();
      store.putOperation({ ...operation, diagnostic: '',
        result: { taskId: settled.id, taskVersion: settled.version, phase: settled.phase, number: settled.number, reference: settled.reference },
        effect: operation.effect ? { ...operation.effect, status: 'reconciled', result: settled.id, resultAt: at } : null });
    };
    return await engine.resolution.acceptExternalMerge(task, input.reason, `move closeout: ${input.reason}`, engine.coordinatorActionRunId.getStore(), undefined, { acceptanceFor, assertQuiet, assertState, settleOperation });
  } catch (error) { propagateQuantumDeferral(error); throw error instanceof ExternalMergeRefusal ? error : new ExternalMergeRefusal(error instanceof Error ? error.message : String(error)); }
}

/**
 * Task 408: the owner closeout reconciliation of a never-dispatched review-entry
 * task whose PR merged outside Queue. It proves the accepting authority, the
 * exact-final-head source acceptance, and fresh inactive ownership; the merge
 * identity, descendant heads and workspace proofs stay in the existing
 * external-merge route. Nothing is dispatched and no review, proof or credit is
 * minted.
 */
export async function reconcileReviewEntryExternalMerge(engine: Engine, input: ExternalMergeInput): Promise<Task> {
  const store = engine.store;
  const task = input.task, qualification = input.qualification?.trim();
  if (!qualification) throw Error('This never-dispatched review-entry task has no reviewer, review, verification or proof at the head its PR merged at, so the merge alone is an observed fact, never acceptance. Pass an explicit operator source acceptance — the same `qualification` a move to merge records — to accept that exact merged head, or leave the task held; no approval is invented for it');
  // The merged head is observed, never supplied: a caller cannot name a head
  // as fact at the forge.
  if (input.head) throw Error('The merged head is observed at the forge, never supplied by the caller; omit head and pass only the acceptance');
  const authority = engine.assertOwnerAuthority(input.caller, input.relayed, input.relayNote, 'External-merge source acceptance');
  const ownerIdentity = JSON.stringify(store.projectFor(task.repoPath, normalizeRepositoryOrigin(task.repository ?? '')));
  // The shared acceptance rule is derived at whatever head the forge reports,
  // so an older head's ruling or the merged status itself never becomes
  // acceptance of the final head.
  const acceptanceFor = (head: string) => {
    const eligible = qualifiedAcceptanceEligibility({ ...task, prHead: head }, store.runs(task.id));
    if (!eligible.available) throw Error(eligible.refusal);
    if (eligible.acceptance !== 'operator_source') throw Error('Review evidence already binds the merged head; no external-merge source acceptance applies to it');
    return {
      at: now(), kind: 'operator_source' as const, head, prNumber: taskPrNumber(task), review: null,
      actor: { agentId: input.caller!, role: authority.role },
      authority: { kind: authority.kind, note: authority.note },
      reason: input.reason.trim().slice(0, 4000), qualification: qualification.slice(0, 4000),
      missingEvidence: `The same PR merged outside Nucleus at ${head} before any reviewer, review, verification or proof existed at that head: this task never dispatched, so no review evidence binds it. ${eligible.missingEvidence}`.slice(0, 4000),
    } as OwnerAcceptanceRecord;
  };
  // Fresh inactive project state before the forge read and again before the
  // commit: an unknown, active or permission-holding writer is never read as
  // absent.
  const assertQuiet = async () => {
    const project = store.projectFor(task.repoPath, normalizeRepositoryOrigin(task.repository ?? ''));
    if (!project)
      throw Error('The task project is not registered; the external-merge source acceptance is refused');
    if (JSON.stringify(project) !== ownerIdentity) throw Error('Project changed during external merge proof');
    for (const [id, workspaceId] of executionParticipants(task, store.runs(task.id))) {
      engine.admission?.invalidate(id);
      let observed: AgentObservation;
      try { observed = await engine.host.observe(id); }
      catch (error) { throw Error(`Participant ${id} could not be observed (${hostFailureRefusalDetail(error)})`); }
      if (observed.id !== id || observed.workspaceId !== workspaceId || observed.status !== 'idle' || observed.active !== false || observed.activeTurnId
        || observed.permissions !== false || store.unreleasedRunsForAgent(id, task.hostId).some(run => run.taskId !== task.id))
        throw Error(`Participant ${id} has observed activity, a permission or unknown identity`);
    }
  };
  try {
    return await engine.resolution.acceptExternalMerge(store.task(task.id), input.reason, `move closeout: ${input.reason}`,
      engine.coordinatorActionRunId.getStore(), { operationId: input.operationId, acceptanceFor, assertQuiet });
  } catch (error) {
    propagateQuantumDeferral(error);
    // Every refusal on this path happens before its one transaction, so it is
    // definite: nothing was merged, accepted or dispatched.
    throw error instanceof ExternalMergeRefusal ? error : new ExternalMergeRefusal(error instanceof Error ? error.message : String(error));
  }
}
