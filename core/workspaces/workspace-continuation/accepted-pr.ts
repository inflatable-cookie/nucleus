import type { Resolution } from "../../resolution";
import { ACCEPTED_PR_RECONCILIATION_REASON, readyReviewAtHead } from "../../recovery/task-reasons";
import { now } from "../../store/store";
import type { Task } from "../../../shared/contracts";

/**
 * One parked accepted PR's workspace reconciliation: confirming that the
 * task's retained workspace is still available, or re-creating a replacement
 * checkout from the accepted branch when it is gone.
 *
 * It is a task-level decision over the store, not a host workspace policy, so
 * it lives beside `host.ts` rather than inside it. Two things can be parked
 * here, and they are two named conditions, not two copies of one predicate:
 *
 * - `requested`: an operator or coordinator asked for this reconciliation. Only
 *   the workspace identity is needed to confirm availability.
 * - `retained`: a ready accepted PR whose retained worker identity the task still
 *   records. The full identity is needed to re-create the checkout and retire
 *   the run that held the old one.
 *
 * `acceptedPrWorkspaceMayApply` and `reconcileAcceptedPrWorkspace` both read
 * these two, so a lifecycle pass can never be advanced for one state and then
 * act on another.
 */
export class AcceptedPrWorkspace {
  constructor(readonly context: AcceptedPrWorkspaceContext) {}

  /** The parked state both conditions share: attention on a ready accepted PR with no live run. */
  private parked(t: Task): boolean {
    return t.phase === "needs_attention" && t.completion?.status === "ready_for_review"
      && !t.resolution.currentRunId && Boolean(t.workspaceId) && Boolean(this.context.adapter.workspaceAvailable);
  }

  /** An operator's or coordinator's own request, which a workspace identity alone can answer. */
  private requested(t: Task): boolean {
    return this.parked(t) && t.reason === ACCEPTED_PR_RECONCILIATION_REASON;
  }

  /** A retained delivery whose recorded worker identity can be replaced by a recovered checkout. */
  private retained(t: Task): boolean {
    return this.parked(t) && Boolean(t.directory && t.agentId && t.runId && t.profile);
  }

  acceptedPrWorkspaceMayApply(t: Task): boolean {
    return this.requested(t) || this.retained(t);
  }

  async reconcileAcceptedPrWorkspace(t: Task): Promise<Task | null> {
    const workspaceId = t.workspaceId;
    if (!this.parked(t) || !workspaceId) return t;
    const available = await this.context.adapter.workspaceAvailable!(workspaceId);
    // An available workspace answers the request; a retained delivery whose
    // workspace is gone needs the recovery below.
    if (available) return this.requested(t) ? this.confirmWorkspace(t, workspaceId) : t;
    if (!this.retained(t)) return t;
    return this.recoverWorkspace(t);
  }

  /** Record that the retained workspace is truly available and re-evaluate the pre-merge gates. */
  private confirmWorkspace(t: Task, workspaceId: string): Task {
    const reviewed = readyReviewAtHead(t);
    return this.context.store.update(t.id, {
      phase: reviewed ? 'verifying' : 'awaiting_review',
      reason: reviewed
        ? 'Retained task workspace confirmed; re-evaluating pre-merge gates at the accepted reviewed head'
        : 'Retained task workspace confirmed; awaiting independent review',
      resolution: {
        ...t.resolution,
        attention: false,
        recoveryActive: false,
        recovery: t.resolution.recovery ? { ...t.resolution.recovery, status: 'resolved', summary: 'Retained task workspace confirmed available' } : null,
        incident: t.resolution.incident ? { ...t.resolution.incident, status: 'resolved', detail: 'Retained task workspace confirmed available', updatedAt: now() } : null,
        integrationTurn: null,
      },
    }, 'task_workspace_confirmed', workspaceId);
  }

  /** Re-create the accepted PR's checkout and retire the run that held the lost workspace. */
  private async recoverWorkspace(t: Task): Promise<Task | null> {
    if (!this.context.adapter.recoverTaskWorkspace) {
      this.context.attention(t, 'Accepted PR is preserved but the task workspace is unavailable; workspace recovery is unsupported');
      return null;
    }
    if (!t.prHead || !t.prUrl) {
      if (!this.context.adapter.verifyPrIdentity) {
        this.context.attention(t, 'Accepted PR identity recovery is unavailable');
        return null;
      }
      const pr = await this.context.adapter.verifyPrIdentity(t, t.completion!.prNumber!);
      t = this.context.store.update(t.id, { prHead: pr.head, prUrl: pr.url }, 'accepted_pr_reconciled', `PR #${t.completion!.prNumber} at ${pr.head}`);
    }
    // A host that cannot look a registration up cannot prove absence, so it never
    // recovers a second registration for one folder: the unknown is attention,
    // not an empty answer.
    if (!this.context.adapter.findWorkspaces) {
      this.context.attention(t, 'The task workspace is unavailable and this host cannot look up its registration; inspect the workspace before retrying');
      return null;
    }
    const found = await this.context.adapter.findWorkspaces(t);
    if (found.length > 1) {
      this.context.attention(t, 'Task workspace recovery is ambiguous; no resource was selected');
      return null;
    }
    if (!found[0] && this.context.startsNoRuns()) return t;
    const workspace = found[0] ?? await this.context.adapter.recoverTaskWorkspace(t);
    const oldWorker = { agentId: t.agentId!, runId: t.runId!, profile: t.profile!, reason: 'Accepted delivery preserved after the original task workspace was removed' };
    return this.context.store.update(t.id, {
      workspaceId: workspace.id, directory: workspace.directory, agentId: null, runId: null, agentIntent: false,
      retiredWorkers: [...t.retiredWorkers, oldWorker], phase: 'awaiting_review', reason: 'Recovered the accepted PR branch in a replacement task workspace; awaiting independent review',
      resolution: { ...t.resolution, attention: false, recoveryActive: false,
        recovery: t.resolution.recovery ? { ...t.resolution.recovery, status: 'resolved', summary: 'Accepted PR workspace recovered without repeating worker delivery' } : null,
        incident: t.resolution.incident ? { ...t.resolution.incident, status: 'resolved', detail: 'Accepted PR workspace recovered', updatedAt: now() } : null },
    }, 'task_workspace_recovered', `${t.workspaceId} → ${workspace.id} at ${t.prHead}`);
  }
}

export type AcceptedPrWorkspaceContext = Pick<Resolution, 'adapter' | 'attention' | 'startsNoRuns' | 'store'>;
