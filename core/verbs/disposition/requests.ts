import type { Completion, Disposition, Task, WorkDisposition } from "../../../shared/contracts";
import { cancellationWithdrawalRefusal, dispositionWorkPolicy } from "../../../shared/contracts";
import { digest, now, type Store } from "../../store/store";
import type { DispositionDeps, DispositionRequest } from "./types";
import { dispositionsInFlight } from "./state";
import { progressDisposition } from "./effects";

const samePayload = (current: Disposition, req: NormalizedRequest) =>
  current.kind === req.action && current.reason === req.reason &&
  (current.replacementTaskId ?? null) === (req.replacementTaskId ?? null) &&
  current.workDisposition === req.workDisposition;

interface NormalizedRequest extends DispositionRequest {
  reason: string;
  workDisposition: WorkDisposition;
}

function normalize(task: Task, req: DispositionRequest): NormalizedRequest {
  const dispatched = task.workspaceIntent || task.agentIntent || task.workspaceId || task.agentId || task.completion || task.resolution.currentRunId;
  const reason = (req.reason ?? "").trim() || (task.phase === "queued" && !dispatched ? "Cancelled before dispatch" : "");
  if (!reason) throw new Error("Cancellation requires an operator reason");
  if (req.action === "supersede" && !req.replacementTaskId) throw new Error("Supersession requires the retained replacement task ID");
  if (req.action !== "supersede" && req.replacementTaskId) throw new Error("A replacement task is only valid for supersession");
  const workDisposition = req.workDisposition ?? "archive_if_empty";
  if (workDisposition === "retained_by_replacement" && req.action !== "supersede")
    throw new Error("Retained-by-replacement disposition is only valid for supersession");
  return { ...req, reason, workDisposition };
}

function replacementEvidence(store: Store, task: Task, replacementTaskId: string) {
  if (replacementTaskId === task.id) throw new Error("A task cannot supersede itself");
  let replacement: Task;
  try {
    replacement = store.task(replacementTaskId);
  } catch {
    throw new Error(`Replacement task does not exist: ${replacementTaskId}. Name the retained task by ID, not title.`);
  }
  if (replacement.removedAt && replacement.phase !== "done") throw new Error("Replacement was removed before completion");
  if (replacement.repoPath !== task.repoPath) throw new Error("Replacement must name a task in the same repository");
  return replacement;
}

/**
 * One explicit owner retry of a disposition step that stopped at its workspace
 * proof or archive (Spec 050 `retry_effect`, `disposition_workspace.<id>`).
 *
 * The recorded effect identity is derived here, not supplied by the caller: the
 * task must still be waiting on the same workspace step, and only the last
 * recorded occurrence may still be uncertain. The original supersession or
 * cancellation (kind, replacement link, reason, every effect result and the
 * requested work disposition) is history and stays exactly as recorded. When
 * the recorded `retained_by_replacement` proof can no longer be produced — its
 * replacement workspace was retired — the owner may select the existing safe
 * `archive_if_empty` policy, which is appended as one attributed transition
 * and still proves clean published source before any archive.
 */
export interface DispositionWorkspaceReopen {
  taskId: string; version: number; workspaceId: string;
  /** The owner-selected proof policy; null re-runs the policy the step records now. */
  policy: WorkDisposition | null;
  reason: string;
  /** The recorded owner identity selecting the policy (board, owner thread or relaying caller). */
  by: string;
  authority: { kind: string; note: string | null };
}

export function reopenDispositionWorkspace(store: Store, input: DispositionWorkspaceReopen): Task {
  const task = store.task(input.taskId);
  if (task.removedAt) throw new Error("Task was removed from the queue");
  if (task.version !== input.version) throw new Error("Task changed; refresh before retrying");
  const disposition = task.disposition;
  if (!disposition) throw new Error("This task has no recorded disposition to recover");
  if (!task.workspaceId || task.workspaceId !== input.workspaceId)
    throw new Error("The recorded disposition workspace does not match this effect");
  if (disposition.status === "preserving") {
    // A replay after a lost reply: this step already reopened, and the recorded
    // transition is that request's own durable identity. Nothing is written
    // twice; the resumed step finishes through the ordinary disposition pass.
    if (input.policy && input.policy !== dispositionWorkPolicy(disposition))
      throw new Error("The disposition workspace step already reopened under another proof policy");
    return task;
  }
  // Only the workspace step reopens. A fence that already completed, or that
  // stopped on a thread, PR or hook effect, is never re-driven from here.
  if (disposition.status !== "needs_attention") throw new Error(`The ${disposition.kind} disposition is ${disposition.status}, not waiting on a workspace step`);
  const occurrences = disposition.effects.filter(effect => (effect.kind === "workspace_proof" || effect.kind === "archive_workspace")
    && effect.target === input.workspaceId);
  const last = occurrences.at(-1);
  if (!last || !last.uncertain)
    throw new Error(`No uncertain workspace proof or archive is recorded for workspace ${input.workspaceId}`);
  const previous = dispositionWorkPolicy(disposition);
  if (input.policy && input.policy !== previous && input.policy !== "archive_if_empty")
    throw new Error("A disposition workspace recovery can only select the existing archive_if_empty proof policy");
  const reason = input.reason.trim();
  if (!reason) throw new Error("Retrying a disposition workspace step requires the owner's reason");
  const policy: WorkDisposition | null = input.policy && input.policy !== previous ? input.policy : null;
  const proofPolicies = policy
    ? [...disposition.proofPolicies, { policy, previous, at: now(), by: input.by, authority: input.authority.kind,
        note: input.authority.note, reason }]
    : disposition.proofPolicies;
  return store.transaction(() => {
    const current = store.task(input.taskId);
    if (current.version !== input.version) throw new Error("Task changed; refresh before retrying");
    const detail = `${input.workspaceId}: owner retry of ${last.kind} under ${policy ?? previous}${policy ? ` (was ${previous})` : ""}; recorded attention: ${disposition.attention || last.result || last.kind}`;
    const reopened = store.update(current.id, {
      disposition: { ...disposition, proofPolicies, status: "preserving", attention: "", completedAt: null },
    }, "disposition_workspace_retry_requested", detail);
    if (policy) store.event(current.id, "disposition_proof_policy", JSON.stringify(proofPolicies.at(-1)));
    return reopened;
  });
}

/** Withdraw a cancellation before any effect beyond pending thread-stop requests has landed, or out of a parked attention fence. */
export async function withdrawCancellation(store: Store, taskId: string, version: number, reason: string, withdrawnBy = "operator control"): Promise<Task> {
  const prior = dispositionsInFlight.get(taskId);
  const step = (prior ? prior.catch(() => undefined) : Promise.resolve()).then(() => {
    const task = store.task(taskId);
    if (task.removedAt) throw new Error("Task was removed from the queue");
    if (task.version !== version) throw new Error("Task changed; refresh before retrying");
    // One shared rule with `next` (nucleus#1000): intent and draining withdraw
    // while only pending thread-stop requests exist, and a fence parked in
    // needs_attention withdraws so an uncertain step can never strand the task.
    const refusal = cancellationWithdrawalRefusal(task);
    if (refusal) throw new Error(refusal);
    const disposition = task.disposition!;

    const normalizedReason = reason.trim();
    if (!normalizedReason) throw new Error("Withdrawing a cancellation requires an operator reason");
    const actor = withdrawnBy.slice(0, 240) || "operator control";
    return store.update(task.id, { disposition: null }, "disposition_withdrawn",
      `Cancellation withdrawn by ${actor}: ${normalizedReason}; cancelled because: ${disposition.reason}`);
  });
  dispositionsInFlight.set(taskId, step);
  try { return await step; }
  finally { if (dispositionsInFlight.get(taskId) === step) dispositionsInFlight.delete(taskId); }
}

/**
 * One versioned operator action. Persists the disposition fence before any
 * remote effect, then reconciles toward the terminal state. A byte-identical
 * repeat at the same or returned version reports the stored disposition;
 * a conflicting request or stale pre-disposition version fails unchanged.
 */
/** Persist only the hard fence. Bulk controls use this to fence every target atomically before any remote effect. */
export function fenceDisposition(store: Store, req: DispositionRequest): Task {
  const task = store.task(req.taskId);
  if (task.removedAt) throw new Error("Task was removed from the queue");
  if (task.phase === "done") throw new Error("Task is already done; disposition is not available");
  if (task.phase === "cancelled" && task.disposition?.status === "complete") {
    const normalized = normalize(task, req);
    if (samePayload(task.disposition, normalized)) return task;
    throw new Error("Task disposition is already complete");
  }
  const normalized = normalize(task, req);
  const existing = task.disposition;
  if (existing) {
    if (samePayload(existing, normalized)) return task;
    // A disposition parked in needs_attention re-runs its own fence when the
    // request names the same kind (nucleus#1000): the recorded reason,
    // replacement link and work disposition stay exactly as fenced, so nothing
    // replaces the recorded fence — the fresh request is recorded as this
    // retry's own event and the driver reconciles the parked step again. A
    // supersession re-run must name the same retained replacement.
    const sameKindReRun = normalized.action === existing.kind
      && (existing.kind === "cancel" || normalized.replacementTaskId === existing.replacementTaskId);
    if (existing.status === "needs_attention" && sameKindReRun) {
      if (req.version !== task.version) throw new Error("Task changed; refresh before retrying");
      const requestedBy = (req.requestedBy ?? "operator control").slice(0, 240) || "operator control";
      store.event(task.id, "disposition_retry_requested",
        `${normalized.action} re-run requested by ${requestedBy}: ${normalized.reason}; the parked step re-runs under the recorded fence`);
      return task;
    }
    if (req.version !== task.version) throw new Error("Task changed; refresh before retrying");
    throw new Error("A conflicting disposition request cannot replace the recorded fence");
  }
  if (req.version !== task.version) throw new Error("Task changed; refresh before retrying");
  const replacement = normalized.action === "supersede" ? replacementEvidence(store, task, normalized.replacementTaskId!) : null;
  const requestedBy = (req.requestedBy ?? "operator control").slice(0, 240) || "operator control";
  // The initial transaction increments the task version: this is the hard
  // orchestration fence. Every engine entry point checks it before creating
  // or resuming workers, reviewers, verifiers, coordinators, closeout agents,
  // hooks, notices, merges or integration work.
  const fenced = store.update(task.id, {
    disposition: {
      kind: normalized.action,
      status: "intent",
      requestedAt: now(),
      requestedBy,
      reason: normalized.reason,
      replacementTaskId: replacement?.id ?? null,
      replacementBranch: replacement?.branch ?? null,
      replacementWorkspaceId: replacement?.workspaceId ?? null,
      workDisposition: normalized.workDisposition,
      workspaceId: null,
      workspaceArchived: false,
      workspaceEvidence: "",
      hookEmitted: false,
      effects: [],
      completedAt: null,
      attention: "",
      refSnapshot: null,
      postDispositionRefs: [],
      proofPolicies: [],
    },
  }, "disposition_requested", `${normalized.action} requested by ${requestedBy}: ${normalized.reason}`);
  return fenced;
}

export async function requestDisposition(store: Store, deps: DispositionDeps, req: DispositionRequest): Promise<Task> {
  const fenced = fenceDisposition(store, req);
  if (fenced.phase === "cancelled" && fenced.disposition?.status === "complete") return fenced;
  return progressDisposition(store, deps, fenced.id);
}

/** A late authenticated callback is durable evidence without authority: it cannot advance a fenced task. */
export function recordLateCallbackEvidence(store: Store, input: Completion, token: string): { accepted: true; eventId: string } {
  return store.transaction(() => {
    const duplicate = store.receipt(input, token);
    if (duplicate) return duplicate;
    const response = { accepted: true as const, eventId: input.eventId };
    store.setCompletionReceipt(input.eventId, input.taskId, input.runId, digest(JSON.stringify(input)), JSON.stringify(response));
    store.event(input.taskId, "late_callback_evidence", `${input.status}: ${input.summary} (received after disposition; no authority)`);
    return response;
  });
}
