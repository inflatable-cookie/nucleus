import { wireLabel } from "../../shared/wire-labels";
import { existsSync } from "node:fs";
import type { ReviewEntryInput, Run, Task, Completion } from "../../shared/contracts";
import type { HostRetainedAgentRef, HostWorkspaceRef, HostThread } from "../../shared/host";
import type { AgentObservation, OriginAgent } from "../host/adapter";
import { authorModelKey, queueAuthorModelKey, taskAuthorModelKeys } from "../../shared/authors";
import { reviewerRuntimeChanged } from "./reviewer-runtime";
import { proofExecutorAgents } from "../qa/proof-execution";
import { isOwnerRoutedReviewer, reviewerIndependence } from "../dispatch/routing";
import { ProvenPreSendRefusalError } from "../recovery/task-reasons";
import { assertOrdinaryReviewIdentity, ordinaryReviewSource } from "./ordinary-review";
import { readGitCheckout } from "../git/git-identity";
import { repoCommonDir } from "../workspaces/workspace-allocation";
import * as forge from "../forge/index";
import { runTicketPath } from "../dispatch/agent-creation";

export interface ReviewPolicyHost {
  readonly helperPath: string;
  readonly workspaceHost: { workspaceRef(id:string): HostWorkspaceRef; activeThreads(): Promise<HostThread[]> };
  readonly messageHost: { retainedAgentRef(id:string): HostRetainedAgentRef };
  observe(id:string): Promise<AgentObservation>;
  originAgent(id:string): Promise<OriginAgent | null>;
  preflightWorkerContinuation(task:Task): Promise<{available:true}|{available:false;reason:string}>;
  binding(key:string,task:Task,runId:string,token:string): unknown;
}
export class ReviewPolicy {
  constructor(private readonly host: ReviewPolicyHost) {}
  async inspectRegistration(callerAgentId: string) {
    const agent = this.host.messageHost.retainedAgentRef(callerAgentId); await agent.refresh(); const current = agent.current();
    if (!current || agent.archivedAt) throw Error('Calling thread is not a live Paseo thread');
    if (!agent.workspaceId) throw Error('Calling thread has no workspace');
    if (wireLabel(current.labels, 'task')) throw Error(`Calling thread already works on queue task ${wireLabel(current.labels, 'task')}; resume that task instead`);
    const workspace = this.host.workspaceHost.workspaceRef(agent.workspaceId); await workspace.refresh();
    const placement = workspace.current();
    if (!workspace.directory || !placement) throw Error('Calling thread workspace is missing its directory');
    if (!placement.projectRootPath) throw Error('Calling thread workspace belongs to no project checkout');
    return { workspaceId: agent.workspaceId, directory: workspace.directory, repoPath: placement.projectRootPath, observation: await this.host.observe(callerAgentId) };
  }
  async inspectReviewEntry(input:ReviewEntryInput,taskId?:string, originProof?: { origin: OriginAgent; state: AgentObservation }) {
    const workspace=this.host.workspaceHost.workspaceRef(input.workspaceId);await workspace.refresh();const current=workspace.current();
    if(!workspace.directory||current?.projectRootPath!==input.submission.repoPath)throw Error('Review-entry workspace is missing or belongs to another project');
    const origin=originProof?.origin ?? await this.host.originAgent(input.submission.originAgentId);
    if(!origin||origin.archived||!origin.workspaceId)throw Error('Review entry requires a live originating thread');
    const originState=originProof?.state ?? await this.host.observe(origin.id);
    if(origin.id!==input.submission.originAgentId||originState.id!==origin.id||originState.workspaceId!==origin.workspaceId)
      throw Error('Review-entry origin observation does not match the recorded thread and workspace');
    const entries=await this.host.workspaceHost.activeThreads();
    const attached=entries.filter(entry=>entry.workspaceId===input.workspaceId&&!entry.archived);
    const busyEntries=attached.filter(entry=>entry.activeTurn
      ||(entry.pendingPermissionKinds.length&&!entry.pendingPermissionKinds.every(kind=>kind==='question'))
      ||!['idle','error','closed'].includes(entry.status));
    const owned=attached.find(entry=>wireLabel(entry.labels, 'task')&&wireLabel(entry.labels, 'task')!==taskId);
    const originHasTurnPermission=originState.permissions
      &&!(originState.pendingPermissionKinds?.length&&originState.pendingPermissionKinds.every(kind=>kind==='question'));
    const originBusy=originState.active||originHasTurnPermission||!['idle','error','closed'].includes(originState.status);
    // The wait names the source writer first, whichever workspace it is writing
    // in: an origin author attached to the review workspace and one working
    // elsewhere are the same handover condition. Only then is another active
    // thread in the selected workspace named.
    const originReason=originBusy||(!originProof&&busyEntries.some(entry=>entry.id===origin.id))
      ?`Origin author thread ${origin.id} still has an active or uncertain turn`:'';
    const busyReason=owned?'Workspace already has Queue ownership labels'
      :originReason||(busyEntries.length?'Workspace has an active turn or permission request':'');
    return {directory:workspace.directory,originWorkspaceId:origin.workspaceId,busyReason,busyTransient:!owned};
  }
  async verifyReview(task: Task, run: Run, result: import("../../shared/contracts").Completion, reviewer?: import("../forge/index").ReviewerSetting) {
    const authorId = task.agentId ?? task.retiredWorkers.at(-1)?.agentId;
    const worker = authorId ? await this.host.observe(authorId) : null, reviewerObservation = await this.host.observe(run.agentId!);
    const model = authorModelKey;
    // One author evidence derivation, shared with reviewer selection and the
    // retained-restart guard; the live observation of the task's author agent
    // adds its current model.
    const authors = taskAuthorModelKeys(task);
    if (worker?.model) authors.add(model(worker.model));
    // A workerless external-PR review entry has no Queue worker, so its declared
    // and observed external authors are the current author rather than an
    // unknown one. An actual worker with no recorded model stays unknown, and
    // unknown current-author evidence refuses whether or not a known model
    // collides. A provider-qualified `provider/unknown` is opaque, not concrete.
    const currentModel = worker?.model ? model(worker.model) : queueAuthorModelKey(task);
    const currentAuthorModels = currentModel === null ? authors : new Set([currentModel]);
    const reviewerModel = model(reviewerObservation.model);
    const reviewerRequest = task.profileRequests?.reviewer;
    const requested = reviewerRequest?.required === true ? reviewerRequest.profileId : undefined;
    const independence = reviewerIndependence({
      site: 'verify', authors, currentAuthorModels, reviewerModel,
      namedRequired: Boolean(requested && run.profile?.id === requested && model(run.profile.model) === reviewerModel),
      ownerRouted: Boolean(requested && isOwnerRoutedReviewer(task, requested)),
    });
    if (independence === 'unknown')
      throw new Error("Underlying review model is not independent of the worker");
    // Spec 036: the reviewer is never an agent that authored the task.
    const authorAgents = new Set([task.agentId,...(task.resolution?.externalOwnerRevisions?.length?[task.originAgentId,...task.resolution.externalOwnerRevisions.flatMap(receipt=>[receipt.actor.agentId,receipt.ownerScope?.ownerAgentId])]:[]), ...proofExecutorAgents(task), ...task.retiredWorkers.map(w => w.agentId)].filter(Boolean));
    if (authorAgents.has(run.agentId!)) throw new Error("Reviewer agent authored this task; review is not independent");
    if (independence === 'collision') {
      // Spec 036: an earlier author's model passes only for the operator's
      // explicitly requested reviewer profile. Spec 050 (Tom 2026-10-13)
      // extends this to the current author's model when the owner `route`
      // (which writes the `ownerRoute` marker) named that reviewer: the
      // owner_control event records the waived independence. Any other
      // same-model request stays refused for the current author's model.
      throw new Error("Underlying review model is not independent of the worker");
    }
    return forge.verifyReview(task, run, result, reviewer);
  }
  async continueWorker(task: Task, intentId: string, text: string, issueBinding?: () => { runId: string; token: string }) {
    if (!task.agentId || !task.workspaceId || !task.runId) throw new Error('Checkpoint continuation requires the retained worker and workspace');
    const workspace = await this.host.preflightWorkerContinuation(task);
    if (!workspace.available) throw new ProvenPreSendRefusalError(workspace.reason);
    const agent = this.host.messageHost.retainedAgentRef(task.agentId); await agent.refresh();
    if (!agent.current() || agent.archivedAt || agent.workspaceId !== task.workspaceId) throw new ProvenPreSendRefusalError('Retained worker identity changed; no continuation was sent');
    // The retained worker's reporting binding must name the durable task run. A
    // rotated identity leaves the worker's own tool naming an earlier run, so
    // the same binding path the live session already holds is re-issued from
    // the durable run before the continuation is sent (Contract 003). A matched
    // binding is left untouched, so an ordinary continuation never rotates a
    // credential the running session already holds.
    const key = wireLabel(agent.current()?.labels, "mcpBinding");
    if (key && key !== task.runId && issueBinding) {
      const issued = issueBinding();
      this.host.binding(key, task, issued.runId, issued.token);
    }
    // The durable intent id is the message identity: an at-most-once replay reuses it.
    const ticketPath = runTicketPath({ helperPath: this.host.helperPath }, task.runId);
    const quotedTicketPath = `'${ticketPath.replaceAll("'", "'\\''")}'`;
    const identity = `Current continuation identity: run ${task.runId}; ticket ${ticketPath}. The retained shell may have stale NUCLEUS_RUN_ID and NUCLEUS_TICKET values. For every Nucleus CLI command or helper in this continuation, set NUCLEUS_CONTINUATION_RUN_ID=${task.runId} and NUCLEUS_CONTINUATION_TICKET=${quotedTicketPath}. Helpers prefer this continuation identity and refuse if the ticket names another run.`;
    await agent.send(`${identity}\n\n${text}`, { messageId: `ns-checkpoint-${intentId}` });
  }

  /** Resume one retained reviewer/coordinator run in place; its existing callback binding stays intact. */
  async continueRun(run: Run, messageId: string, text: string) {
    if (!run.agentId) throw new ProvenPreSendRefusalError('Retained run has no agent; no continuation was sent');
    const agent = this.host.messageHost.retainedAgentRef(run.agentId); await agent.refresh();
    if (!agent.current() || agent.archivedAt || agent.workspaceId !== run.workspaceId)
      throw new ProvenPreSendRefusalError('Retained run identity changed; no provider continuation was sent');
    await agent.send(text, { messageId });
  }

  /** Deliver only to the existing, idle reviewer after same-workspace/model and fence checks. */
  async continueReviewer(task: Task, run: Run, messageId: string, text: string, allowed: () => Promise<boolean>, stillAllowed: () => boolean, beforeSend?: () => void): Promise<{ sent: true } | { sent: false; reason: string }> {
    const refuse = (reason: string) => ({ sent: false as const, reason });
    let sendInvoked = false;
    const source={workspaceId:task.workspaceId,directory:task.directory,branch:task.branch};
    if (!run.agentId || !run.profile || !source.directory || !source.workspaceId || run.workspaceId !== source.workspaceId)
      return refuse('Original reviewer workspace identity is incomplete or changed; no delivery was sent');
    try {
      const placed = await retainedWorkspacePlacement(this.host.workspaceHost.workspaceRef(source.workspaceId), task, run, source, 'before continuation dispatch');
      if (!placed.placed) return refuse(placed.reason);
      const agent = this.host.messageHost.retainedAgentRef(run.agentId);
      if (!await agent.refresh()) return refuse('Original reviewer identity is unavailable; no delivery was sent');
      const current = agent.current(), runtime = agent.runtimeInfo;
      if (!current || agent.archivedAt || agent.workspaceId !== run.workspaceId)
        return refuse('Original reviewer identity or workspace changed; no delivery was sent');
      if (agent.status !== 'idle' || agent.activeTurn || (agent.pendingPermissions?.length ?? 0) > 0)
        return refuse('Original reviewer is not idle and permission-free; no delivery was sent');
      const actualProvider = runtime?.provider ?? current.provider;
      const actualModel = runtime?.model ?? current.model;
      if (reviewerRuntimeChanged(run.profile, { provider: actualProvider, model: actualModel, modeId: runtime?.modeId, thinkingOptionId: runtime?.thinkingOptionId }))
        return refuse('Original reviewer model/profile identity is unknown or changed; no delivery was sent');
      if (!await allowed()) return refuse('A Queue or exact-head fence changed before delivery; no delivery was sent');
      // Cleanliness first, then placement as the LAST await: it refreshes the
      // workspace record and re-reads Git identity, so no awaited proof can
      // leave those facts stale. Detached ordinary source is proved inside
      // placement. Only synchronous Queue checks run after it.
      if (!await agent.refresh()) return refuse('Original reviewer identity disappeared during exact-head verification; no delivery was sent');
      const finalCurrent = agent.current(), finalRuntime = agent.runtimeInfo;
      const finalProvider = finalRuntime?.provider ?? finalCurrent?.provider;
      const finalModel = finalRuntime?.model ?? finalCurrent?.model;
      if (!finalCurrent || agent.archivedAt || agent.workspaceId !== run.workspaceId || agent.status !== 'idle' || agent.activeTurn || (agent.pendingPermissions?.length ?? 0) > 0)
        return refuse('Original reviewer became active, permission-bound or unavailable during exact-head verification; no delivery was sent');
      if (reviewerRuntimeChanged(run.profile, { provider: finalProvider, model: finalModel, modeId: finalRuntime?.modeId, thinkingOptionId: finalRuntime?.thinkingOptionId }))
        return refuse('Original reviewer model/profile changed during exact-head verification; no delivery was sent');
      const rechecked = await retainedWorkspacePlacement(this.host.workspaceHost.workspaceRef(source.workspaceId), task, run, source, 'during exact-head verification');
      if (!rechecked.placed) return refuse(rechecked.reason);
      // Nothing is awaited from here: identity is re-asserted from the filesystem
      // and the Queue fence is stillAllowed, so a dirty or moved checkout after
      // the last await is refused without another spawn.
      const boundaryCurrent = agent.current(), boundaryRuntime = agent.runtimeInfo;
      if (!boundaryCurrent || agent.archivedAt || agent.workspaceId !== run.workspaceId || agent.status !== 'idle' || agent.activeTurn || (agent.pendingPermissions?.length ?? 0) > 0)
        return refuse('Original reviewer became active, permission-bound or unavailable during workspace placement verification; no delivery was sent');
      if (reviewerRuntimeChanged(run.profile, { provider: boundaryRuntime?.provider ?? boundaryCurrent.provider, model: boundaryRuntime?.model ?? boundaryCurrent.model, modeId: boundaryRuntime?.modeId, thinkingOptionId: boundaryRuntime?.thinkingOptionId }))
        return refuse('Original reviewer model/profile changed during workspace placement verification; no delivery was sent');
      if (!stillAllowed()) return refuse('A Queue fence changed immediately before delivery; no delivery was sent');
      if (run.ordinaryDetached) assertOrdinaryReviewIdentity(task, run.head, true);
      // Once send is invoked its outcome can be uncertain. Callers retain the
      // durable intent and must reconcile from this exact message ID, never retry.
      beforeSend?.();
      sendInvoked = true;
      await agent.send(text, { messageId });
      return { sent: true };
    } catch (error) {
      if (sendInvoked) throw error;
      return refuse(`Reviewer delivery preflight failed before send: ${String(error).slice(0, 600)}`);
    }
  }

}

async function retainedWorkspacePlacement(workspace: { directory?: string | null; refresh: () => Promise<unknown>; current: () => { projectRootPath: string } | null | undefined },
  task: Task, run: Run, source: { workspaceId?: string | null; directory?: string | null }, phase: string): Promise<{ placed: true } | { placed: false; reason: string }> {
  const refuse = (reason: string) => ({ placed: false as const, reason });
  if (!source.workspaceId || !source.directory) return refuse(`Original reviewer workspace identity is incomplete or changed ${phase}; no delivery was sent`);
  await workspace.refresh();
  const record = workspace.current();
  if (!record || !workspace.directory || !existsSync(workspace.directory) || workspace.directory !== source.directory)
    return refuse(`Original reviewer workspace is missing or changed ${phase}; no delivery was sent`);
  if (run.ordinaryDetached) await ordinaryReviewSource(task, run.head, true);
  if (record.projectRootPath === task.repoPath) return { placed: true };
  // Only the primary task checkout has a second legitimate placement: a distinct
  // run workspace keeps the canonical project
  // proof, and its own checkout root never stands in for the task's repository.
  if (run.workspaceId !== task.workspaceId || source.directory !== task.directory || record.projectRootPath !== source.directory)
    return refuse(`Original reviewer workspace changed project placement ${phase}; no delivery was sent`);
  const common = await repoCommonDir(task.repoPath).catch(() => null);
  let checkout;
  try { checkout = readGitCheckout(source.directory); }
  catch { return refuse(`Retained reviewer checkout is unreadable ${phase}; no delivery was sent`); }
  if (!common || common !== checkout.commonDir)
    return refuse(`Retained reviewer checkout is not a worktree of the task repository ${phase}; no delivery was sent`);
  if (run.ordinaryDetached) await ordinaryReviewSource(task, run.head, true);
  if (checkout.branch !== (run.ordinaryDetached ? '' : task.branch) || checkout.head !== run.head)
    return refuse(`Retained reviewer checkout is not the reviewed branch and head ${phase}; no delivery was sent`);
  // The workspace descriptor was sampled before those awaited Git reads, so it is
  // re-read here and must describe the same placement, and the Git evidence is
  // then re-asserted from the filesystem. Neither a descriptor that changes during
  // the reads nor a checkout that changes during the re-read can leave this proof
  // stale, and the caller sends with nothing awaited after it.
  await workspace.refresh();
  const settled = workspace.current();
  if (!settled || !workspace.directory || !existsSync(workspace.directory) || workspace.directory !== source.directory ||
      settled.projectRootPath !== record.projectRootPath)
    return refuse(`Original reviewer workspace changed project placement ${phase}; no delivery was sent`);
  try {
    const settledCheckout = readGitCheckout(source.directory);
    if (settledCheckout.commonDir !== checkout.commonDir ||
        settledCheckout.branch !== checkout.branch || settledCheckout.head !== checkout.head)
      return refuse(`Retained reviewer checkout is not the reviewed branch and head ${phase}; no delivery was sent`);
  } catch {
    return refuse(`Retained reviewer checkout is unreadable ${phase}; no delivery was sent`);
  }
  return { placed: true };
}
