import { proofActivationRefusal } from '../qa/proof-activation';
import { FORCE_CALLER_REFUSAL, FORCE_REASON_REFUSAL, FORCE_ACTION_REFUSAL, FORCE_MOVE_REFUSAL, FORCE_MERGED_REFUSAL, FORCE_PAUSED_REFUSAL, FORCE_MERGE_UNAVAILABLE_REFUSAL, FORCE_HOLD_REFUSAL, FORCE_MERGE_OBSERVATION_REFUSAL, FORCE_EFFECT_REQUIRED_REFUSAL, FORCE_PUBLICATION_REFUSAL, missingForcedEffectRefusal } from '../verbs/verb-refusal-text';
import { completeStateRefusal, moveStateRefusal, stopStateRefusal, routeStateRefusal } from '../verbs/control-refusals';
import { DISPOSITION_CONTROL_REFUSAL, REMOVED_TASK_REFUSAL } from '../verbs/control-refusals';
import { isDispositionActive, cancellationWithdrawalRefusal, holdsOf, type Task, type TaskControlInput } from "../../shared/contracts";
import type { Engine } from "../engine";
import { verifyAcceptedEnclosingOperation } from "../planning/enclosing-operation";
import { observationAdvanceSince } from "../recovery/observation-advance";
import { collectOwnerVerbFacts, ownerPendingEffects } from "../verbs/owner-verbs";

/**
 * The owner closeout boundary's refusal for an operator source acceptance that
 * no boundary can host: the same fact `reconcileRetainedExternalMerge` reads
 * after it has proved the merge at the forge.
 */
export const OUTSIDE_CLOSEOUT_BOUNDARY =
  'An operator source acceptance in a closeout applies only to a never-dispatched review-entry task at its boundary or a dispatched task with a retained worker, workspace and recorded PR source; this task is outside that boundary';

/**
 * Which controls owe the version gate. A cancellation or supersession replayed
 * with the payload already recorded on the task is answered by that record
 * whatever version the caller holds (`fenceDisposition` returns it), and the
 * fence the first attempt wrote is itself what advanced the version, so the
 * version is not a refusal of that verb.
 */
const VERSION_REFUSES: ReadonlySet<TaskControlInput["action"]> = new Set([
  "move", "restart", "route", "retry_effect", "complete", "proof", "withdraw_cancel", "amend_brief", "stop",
]);

/**
 * The refusals one owner control owes from stored facts alone, or `null` when it
 * would be accepted (nucleus#927).
 *
 * #912 put the host wait in one place — `Engine.performTaskControl` and the
 * durable operation lane that reaches it — but a control entered that wait
 * before its own refusals had run, so an invalid control sat "Waiting for host
 * …" until the recorded host returned. This projection runs first, in that same
 * one place: every refusal below reads the store as it stands and needs no host
 * observation, while a control that only the host can refuse (a PR head, a live
 * participant, a forge proof) still waits for it and refuses then.
 *
 * The wording is each verb's own, so an offline refusal and the verb's later
 * refusal say the same thing about the same fact.
 */
export function hostIndependentControlRefusal(engine: Pick<Engine, 'store' | 'resolution' | 'forceCallerAuthorized' | 'selfForceRole'>, input: TaskControlInput, operationId?: string): string | null {
  const store = engine.store;
  // An unknown task refuses here: no host could ever answer for it.
  const task = store.task(input.taskId);
  // A forced control is an explicit override of the ordinary gates, so only what
  // force itself refuses applies — its authorization, its reason, which actions
  // it settles — and every one of those facts is a store read too.
  if (input.force === true) return forcedControlRefusal(engine, task, input);
  if (task.removedAt) return REMOVED_TASK_REFUSAL;
  // A completion the task already recorded at the caller's version is the verb's
  // own idempotent answer (`completeTask` returns it before any gate), so it owes
  // no version or terminal refusal here; the acceptances themselves are compared
  // by the verb.
  if (input.action === "complete" && task.phase === "done" && task.reportAcceptance?.taskVersion === input.version) return null;
  const version = versionRefusal(task, input);
  if (version) return version;
  if (input.action === "move") {
    const refusal = moveStateRefusal(task, input.to ?? 'work');
    if (refusal) return refusal;
  } else if (input.action === "stop") return stopStateRefusal(task);
  else if (input.action === "route") return routeStateRefusal(task);
  else if (input.action === "complete") return completeStateRefusal(task, store.runs(task.id));
  else if (input.action === "proof") return proofActivationRefusal(task, [], "disposition") ?? proofActivationRefusal(task, [], "terminal");
  else {
    if (input.action === "restart" && isDispositionActive(task)) return DISPOSITION_CONTROL_REFUSAL;
    if (input.action === "withdraw_cancel") return cancellationWithdrawalRefusal(task);
  }
  return closeoutBoundaryRefusal(engine, task, input, operationId);
}

/**
 * `force: true` settles one of two effects, and every gate below is the one
 * `forceMove`/`forceSettleEffect` makes: the caller (the board, a recorded
 * planner, or the authenticated self-force run this operation carries), the
 * reason, which actions force settles, the forced move's own facts, and the
 * recorded effect a forced settle names. The two adapter gates are presence
 * checks on the resolution adapter the engine already holds, not host reads, so
 * they belong here too; every check that would observe the host still waits.
 */
function forcedControlRefusal(engine: Pick<Engine, 'store' | 'resolution' | 'forceCallerAuthorized' | 'selfForceRole'>, task: Task, input: TaskControlInput): string | null {
  if (!engine.forceCallerAuthorized(task, input.caller))
    return FORCE_CALLER_REFUSAL;
  if (!input.reason?.trim()) return FORCE_REASON_REFUSAL;
  if (input.action === "retry_effect") return forcedEffectRefusal(engine, task, input);
  if (input.action !== "move") return FORCE_ACTION_REFUSAL;
  const version = versionRefusal(task, input);
  if (version) return version;
  if (task.removedAt || !input.to) return FORCE_MOVE_REFUSAL;
  if (input.to === "merge" && task.resolution.mergedCommit)
    return FORCE_MERGED_REFUSAL;
  if (input.to === "merge" && engine.store.getMeta("paused") === true)
    return FORCE_PAUSED_REFUSAL;
  if (input.to === "merge" && !adapterGate(engine, 'merge'))
    return FORCE_MERGE_UNAVAILABLE_REFUSAL;
  if (engine.selfForceRole(task) && (Object.keys(holdsOf(task)).length > 0 || task.disposition))
    return FORCE_HOLD_REFUSAL;
  if (input.to === "closeout" && !adapterGate(engine, 'merged'))
    return FORCE_MERGE_OBSERVATION_REFUSAL;
  return null;
}

/**
 * One resolution-adapter capability, read as a presence check. An adapter method
 * that cannot be read inside a host context must not turn a control's refusal
 * into a transport error: only a proven absence refuses, and an unreadable one
 * leaves the control to the wait.
 */
function adapterGate(engine: Pick<Engine, 'store' | 'resolution' | 'forceCallerAuthorized' | 'selfForceRole'>, method: 'merge' | 'merged'): boolean {
  try { return Boolean(engine.resolution.adapter[method]); }
  catch { return true; }
}

/** The forced settlement of one recorded effect: it names an effect that is still pending. */
function forcedEffectRefusal(engine: Pick<Engine, 'store' | 'resolution' | 'forceCallerAuthorized' | 'selfForceRole'>, task: Task, input: TaskControlInput): string | null {
  const version = versionRefusal(task, input);
  if (version) return version;
  if (!input.effect) return FORCE_EFFECT_REQUIRED_REFUSAL;
  if (input.effect.startsWith('review_publication.'))
    return FORCE_PUBLICATION_REFUSAL;
  const effects = ownerPendingEffects(collectOwnerVerbFacts(engine.store, task));
  if (!effects.some(effect => effect.effect === input.effect)) return missingForcedEffectRefusal(input.effect);
  return null;
}

/**
 * The version the owner control was admitted at is the version the store still
 * shows, allowing only lifecycle observations since (Spec 050,
 * `observation-advance.ts`). It is the first refusal almost every verb makes,
 * and it names the version the task reached so a caller re-reads `next` once
 * instead of resending the stale payload.
 */
function versionRefusal(task: Task, input: TaskControlInput): string | null {
  if (!VERSION_REFUSES.has(input.action) || observationAdvanceSince(task, input.version)) return null;
  return `Task changed; refresh before retrying (the task is now version ${task.version}; read next again and reassess before retrying)`;
}

/**
 * Task 404/408: an operator source acceptance of an external merge is offered
 * only inside the authenticated durable move executing it — the boundary of a
 * never-dispatched review-entry task, or a dispatched task whose retained
 * worker, workspace and PR source the applied move will prove. Without that
 * invocation and that shape nothing could accept the merge once the host
 * returned, so the control refuses now instead of waiting for one.
 */
function closeoutBoundaryRefusal(engine: Pick<Engine, 'store' | 'resolution' | 'forceCallerAuthorized' | 'selfForceRole'>, task: Task, input: TaskControlInput, operationId?: string): string | null {
  if (input.action !== "move" || input.to !== "closeout" || input.qualification === undefined) return null;
  const store = engine.store;
  // The never-dispatched review-entry boundary, proved from the operation the
  // lane accepted for this exact control: this operation is the invocation, not
  // a competing writer against itself.
  const enclosing = verifyAcceptedEnclosingOperation(store, input, operationId);
  if (enclosing && store.reviewEntryUnrunBeforeFirstRun(task, enclosing)) return null;
  // The ordinary descendant-acceptance route: a task past its first dispatch
  // with the retained worker, workspace and recorded PR source its proofs read.
  // A queued or dispatching task is refused even with those fields recorded,
  // which is the same gate `reconcileRetainedExternalMerge` makes.
  if (!["queued", "dispatching"].includes(task.phase)
    && task.agentId && task.runId && task.workspaceId && task.directory && task.prHead && task.prUrl) return null;
  return OUTSIDE_CLOSEOUT_BOUNDARY;
}
