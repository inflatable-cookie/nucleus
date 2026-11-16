import type { Run, Task } from "../../../shared/contracts";
import { TaskChangedRefusal } from "../../../shared/task-version";
import type { Engine } from "../../engine";
import { DurableFenceRefusal } from "../../intake/run-settlement";
import { evidenceOnlyPr, ForeignPrIdentity, taskHasPr } from "../../forge/index";
import { runsUnchangedSince } from "../../recovery/observation-advance";
import { blockingRecoveryEffectsRefusal } from "../../recovery/recovery-effects";
import { OPERATOR_WORKER_REMAP_REASON, operatorReplacementPending } from "../../recovery/task-reasons";
import type { ContinuedPrBinding } from "../../resolution";
import { currentRouteProfile } from "../owner-verbs";
import { MOVE_WORK_AUTHOR_REFUSAL, MOVE_WORK_REPLACEMENT_REFUSAL, moveStateRefusal, REMOVED_TASK_REFUSAL } from "../control-refusals";
import { RETAINED_PREREQUISITE_REFUSAL } from "../verb-refusal-text";
import { cancelDisplacedReviewers, observeReviewerDisplacement } from "./review-displacement";

/** The owner `move to=work` request, after the verb has parsed it. */
export type WorkMoveInput = {
  taskId: string;
  version: number;
  reason: string;
  instruction?: string;
  caller?: string;
  restart?: { afterSettlement: (settled: Task) => Task; afterRevision: (revised: Task) => Task };
};

/** What the work move's guarded transaction needs from its observed prelude. */
type WorkSettlement = {
  expected: number;
  reason: string;
  displaced: Run[];
  stoppedReviewers: ReadonlySet<string>;
};

/**
 * Spec 050 `move to=work`: return the task to its author for a revision with
 * the instruction. A checkpointed or stopped reviewer run yields and is
 * superseded with history kept; a live turn refuses. A retained author takes
 * the ordinary revision turn; a gone author is replaced by a fresh one on the
 * worker route through the existing replacement machinery.
 */
export async function moveToWork(engine: Engine, input: WorkMoveInput): Promise<Task> {
  const store = engine.store;
  let task = store.task(input.taskId);
  if (task.removedAt) throw Error(REMOVED_TASK_REFUSAL);
  engine.requireOwnerControlCurrent(task, input.version, 'Task changed; refresh before retrying');
  const stateRefusal = moveStateRefusal(task, "work");
  if (stateRefusal) throw Error(stateRefusal);
  // Spec 050 (#3569): finished runs settle by observation before the run
  // fence — including a completed reviewer run, whose verdict the task already
  // carries; one that cannot settle refuses here, with nothing written.
  if (!task.agentId && !task.agentIntent && !(task.profile && task.workspaceId)) throw Error(MOVE_WORK_AUTHOR_REFUSAL);
  if (operatorReplacementPending(task) && task.phase === 'dispatching' && !task.agentId && task.agentIntent)
    throw Error(MOVE_WORK_REPLACEMENT_REFUSAL);
  if (task.prerequisiteWait && !task.prerequisiteWait.releasedAt) throw Error(RETAINED_PREREQUISITE_REFUSAL);
  // A lost workspace is re-created from the branch on origin before the move
  // reads the retained worker: the task, PR and approval stay, and the author
  // continues on a fresh thread in the recovered worktree.
  task = await recreateLostWorkspace(engine, task, `move to work: ${input.reason}`);
  if (!task.agentId && !currentRouteProfile(task, 'worker') && !task.profile) throw Error('Starting a fresh author requires the worker route or the retained profile');
  // A callback landing while the runs are observed refuses below; cancelling a
  // turn writes only events, so it never trips this guard.
  const runsBeforeMove = store.runs(task.id);
  const displacement = await observeReviewerDisplacement(engine, task.id);
  // Project-d #117 (Tom, 2026-10-23): a retained author's revision on a PR the
  // task knows only from a reported completion binds that PR in the accepting
  // transaction, verified as the revision continuation verifies it. A failed
  // proof refuses here, before any turn is cancelled or anything is written.
  let continuedPr: ContinuedPrBinding | null = null;
  let foreignCompletion: string | null = null;
  if (task.agentId) {
    try { continuedPr = await engine.resolution.verifyContinuedPr(task); }
    catch (error) {
      if (error instanceof ForeignPrIdentity && task.completion && evidenceOnlyPr(task)) foreignCompletion = task.completion.eventId;
      else throw Error(`Move to work cannot bind PR #${evidenceOnlyPr(task)}, which the task knows only from its ${task.completion?.status} report: ${error instanceof Error ? error.message : String(error)}. Nothing was written`);
    }
  }
  engine.assertUnchangedBeforeCancel(task.id, task.version, runsBeforeMove);
  await cancelDisplacedReviewers(engine, task.id, displacement, 'move work');
  const instruction = input.instruction?.trim()
    || 'Continue the existing task under its current approved instruction source and within its approved scope.';
  // Spec 050 atomic verbs: the fences the move supersedes settle inside the
  // guarded transaction, after every check that can refuse, so a refused move
  // changes nothing. Task and run identities captured before observation must
  // still match when the move commits; an intervening callback or owner edit refuses.
  const expected = task.version;
  return engine.control(async () => {
    const current = store.task(task.id);
    engine.requireOwnerControlCurrent(current, expected, 'Task or run changed; refresh before retrying');
    if (!runsUnchangedSince(runsBeforeMove, store.runs(task.id))) throw Error('Task or run changed; refresh before retrying');
    // The fresh-author refusal derives from the recorded route and profile,
    // which the settlement never touches: check it before anything is written.
    if (!current.agentId) {
      const routeProfileId = currentRouteProfile(current, 'worker');
      if (!routeProfileId && !current.profile) throw Error('Starting a fresh author requires the worker route or the retained profile');
    }
    const settlement: WorkSettlement = { expected, reason: input.reason, displaced: displacement.displaced, stoppedReviewers: displacement.stoppedReviewers };
    if (current.agentId)
      return reviseRetainedAuthor(engine, task.id, input, settlement, { instruction, continuedPr, foreignCompletion });
    return replaceAbsentAuthor(engine, task.id, input, settlement, instruction);
  }, `task:${task.id}`);
}

/**
 * The settlement every work move commits before its action: the fences it
 * supersedes, the prerequisite wait it resumes and the stopped reviewer it
 * releases. Runs inside the caller's transaction.
 */
function settleWorkMove(engine: Engine, taskId: string, move: WorkSettlement): Task {
  const store = engine.store;
  const latest = store.task(taskId);
  engine.requireOwnerControlCurrent(latest, move.expected, 'Task changed; refresh before retrying');
  engine.settleVerbFences(taskId, { detail: `move work: ${move.reason}`, runIds: [], displacedRunIds: move.displaced.map(run => run.id) });
  engine.resumeReleasedPrerequisiteWait(taskId);
  if (store.runs(latest.id).some(run => !run.released && !move.stoppedReviewers.has(run.id))) throw Error('A run started during the move; refresh before retrying');
  const stoppedReviewer = store.runs(latest.id).find(run => run.role === 'reviewer' && !run.completion && !run.released && move.stoppedReviewers.has(run.id));
  if (stoppedReviewer) {
    store.deleteCredential(stoppedReviewer.id);
    store.putRun({ ...stoppedReviewer, status: 'superseded', released: true, active: false });
    store.event(latest.id, 'move_work_reviewer_settled', `${stoppedReviewer.id}: ${move.reason}`.slice(0, 2000));
    store.update(latest.id, { resolution: { ...latest.resolution, currentRunId: null, reviewerAgentId: null, reviewerProfile: null } }, 'move_work_reviewer_settled', stoppedReviewer.id);
  }
  return store.task(taskId);
}

/** A retained author takes the ordinary revision turn, binding any proven PR first. */
function reviseRetainedAuthor(engine: Engine, taskId: string, input: WorkMoveInput, move: WorkSettlement,
  pending: { instruction: string; continuedPr: ContinuedPrBinding | null; foreignCompletion: string | null }): Task {
  const store = engine.store;
  return store.transaction(() => {
    let settledTask = settleWorkMove(engine, taskId, move);
    if (input.restart) settledTask = input.restart.afterSettlement(settledTask);
    if (pending.foreignCompletion) {
      if (settledTask.completion?.eventId !== pending.foreignCompletion) throw Error('Reported PR evidence changed during the move');
      settledTask = store.update(taskId, { completion: null }, 'foreign_completion_cleared', JSON.stringify({ eventId: pending.foreignCompletion, reason: input.reason }));
    }
    if (pending.continuedPr && !engine.resolution.bindContinuedPrInTx(taskId, pending.continuedPr, `move work: ${input.reason}`))
      throw Error('The task PR evidence changed during the move; refresh before retrying');
    // No instruction keeps the pending one or the review findings, as revise did.
    const result = settledTask.resolution.currentRunId ? store.run(settledTask.resolution.currentRunId)?.completion : null;
    const findings = result?.status === 'changes_required' ? result.reviewText || result.summary : undefined;
    let revised = engine.resolution.retry(store.task(taskId), true, input.instruction?.trim() || settledTask.resolution.pendingWorkerInstruction || findings || undefined, true, false, !taskHasPr(settledTask));
    if (settledTask.completion?.status === 'report_ready') {
      const report = settledTask.completion;
      store.event(taskId, 'report_returned_to_work', JSON.stringify({ eventId: report.eventId, summary: report.summary, artifact: report.artifact,
        instruction: revised.resolution.pendingWorkerInstruction ?? input.instruction?.trim() ?? '' }));
      revised = store.update(taskId, { completion: null }, 'report_ready_completion_cleared', report.eventId);
    }
    return input.restart ? input.restart.afterRevision(revised) : revised;
  });
}

/**
 * The author is gone: a fresh author starts on the worker route through the
 * existing replacement machinery; selection reads `replacementProfile`.
 */
function replaceAbsentAuthor(engine: Engine, taskId: string, input: WorkMoveInput, move: WorkSettlement, instruction: string): Task {
  const store = engine.store;
  return store.transaction(() => {
    const settledTask = settleWorkMove(engine, taskId, move);
    if (settledTask.completion?.status === 'report_ready') {
      const report = settledTask.completion;
      store.event(taskId, 'report_returned_to_work', JSON.stringify({ eventId: report.eventId, summary: report.summary, artifact: report.artifact, instruction }));
    }
    const routeProfileId = currentRouteProfile(settledTask, 'worker');
    const latest = store.task(taskId);
    if (latest.version !== settledTask.version) throw new TaskChangedRefusal('Task changed during the move; refresh before retrying', settledTask.version, latest.version);
    const failoverReason = `${OPERATOR_WORKER_REMAP_REASON}. Continue the existing task: ${instruction}`.slice(0, 2000);
    if (routeProfileId && settledTask.profileRequests?.worker?.ownerRoute)
      store.event(taskId, 'worker_route_honoured', `move to=work selected pending worker route ${routeProfileId}`);
    return store.update(latest.id, {
      phase: 'changes_requested', ...(settledTask.completion?.status === 'report_ready' ? { completion: null } : {}),
      reason: 'Owner moved the task to a fresh author revision on the worker route',
      failoverReason,
      replacementProfile: { profileId: routeProfileId ?? latest.profile!.id, reason: input.reason.slice(0, 4000) },
      resolution: { ...latest.resolution, currentRunId: null, attention: false, recoveryActive: false, recoveryAttempts: 0,
        pendingWorkerInstruction: instruction, ...(taskHasPr(latest) ? {} : { prePrResumeInstruction: instruction }) },
    }, input.caller ? 'move_work_requested' : 'owner_control', JSON.stringify({ verb: 'move', to: 'work', phaseBefore: settledTask.phase, reason: input.reason }));
  });
}

/**
 * A recorded workspace can be gone while its branch is still on origin. The
 * owner verbs that continue a worker (`move to=work`, `restart role=worker`)
 * re-create the worktree from that published branch before they touch the
 * retained thread: the task, its PR and its approval stay, the runs that lived
 * in the lost workspace settle as superseded history, and the role starts on a
 * fresh thread because a thread's cwd and binding belong to its old workspace
 * (nucleus#964, nucleus#974). Returns the same task when its workspace is
 * available, so every other move keeps its current path.
 */
export async function recreateLostWorkspace(engine: Engine, task: Task, reason: string): Promise<Task> {
  const store = engine.store;
  const available = engine.adapter.workspaceAvailable;
  if (!task.workspaceId || !available || await available(task.workspaceId)) return task;
  if (!engine.adapter.recoverTaskWorkspace)
    throw Error('The recorded task workspace is gone and this host cannot re-create a worktree; restore the workspace before continuing');
  const blocking = blockingRecoveryEffectsRefusal(store, task);
  if (blocking) throw new DurableFenceRefusal(blocking);
  // The worker resumes from its published branch, so the recovery reads the
  // branch on origin rather than the accepted PR head. A workspace whose
  // registration survives but whose directory is gone is re-created, never
  // rebound: the recovery proves a live clean checkout at that head.
  const workspace = await engine.adapter.recoverTaskWorkspace(task, { target: 'branch' });
  const lost = task.workspaceId;
  const apply = () => {
    const current = store.task(task.id);
    for (const run of store.runs(task.id).filter(run => !run.released && run.workspaceId === lost)) {
      const why = engine.runDurableFence(current, run);
      if (why) throw new DurableFenceRefusal(engine.displaceRefusal({ run, why }));
      store.deleteCredential(run.id);
      store.putRun({ ...run, status: 'superseded', released: true, active: false });
      store.event(current.id, 'workspace_worker_retired', `${run.role} ${run.id}: recorded workspace ${lost} was gone; the source was re-created at ${workspace.directory}`);
    }
    const retired = current.agentId && current.profile
      ? [...current.retiredWorkers, { agentId: current.agentId, runId: current.runId ?? '', profile: current.profile,
          reason: `Recorded workspace ${lost} was gone; re-created the worktree from the branch on origin. ${reason}`.slice(0, 2000) }]
      : current.retiredWorkers;
    return store.update(current.id, {
      workspaceId: workspace.id, directory: workspace.directory, agentId: null, runId: null, agentIntent: false,
      agentActive: false, lastAgentStatus: null, lastObservedAt: null, idleSince: null, transientProviderRetry: undefined,
      retiredWorkers: retired,
      resolution: { ...current.resolution, currentRunId: null, reviewerAgentId: null, reviewerProfile: null, stalledTurnStop: null },
    }, 'task_workspace_recreated', `${lost} → ${workspace.id} at ${workspace.directory}; ${reason}`.slice(0, 2000));
  };
  return store.db.isTransaction ? apply() : store.transaction(apply);
}
