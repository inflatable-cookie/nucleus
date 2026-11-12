import type { Disposition, Task } from "../../../shared/contracts";
import { dispositionWorkPolicy, isDispositionActive } from "../../../shared/contracts";
import { now, type Store } from "../../store/store";
import { ForeignRecordedPr } from "../../forge/index";
import { hostProcessSweepIntent, sweepTaskHostProcesses } from "../../machine/host-process-reap";
import type { DispositionDeps } from "./types";
import { dispositionsInFlight, dispositionInFlight, ownedThreads, setDisposition } from "./state";
import { snapshotOriginRefs, observePostDispositionRefs } from "./refs";
import { settlesPreWorkspaceDispositionHook, settlesLegacyInstructionlessDispositionHook } from "./hook-evidence";

export function recordIntent(store: Store, taskId: string, kind: string, target: string): void {
  const task = store.task(taskId);
  const disposition = task.disposition;
  if (!disposition) return;
  setDisposition(store, task, { ...disposition, effects: [...disposition.effects, { kind, target, intentAt: now(), result: null, resultAt: null, uncertain: false }] }, "disposition_effect_intent", `${kind}: ${target}`);
}

export function recordResult(store: Store, taskId: string, kind: string, target: string, result: string, uncertain = false): void {
  const task = store.task(taskId);
  const disposition = task.disposition;
  if (!disposition) return;
  const effects = [...disposition.effects];
  const index = effects.map((effect) => effect.kind === kind && effect.target === target && !effect.result).lastIndexOf(true);
  const entry = { kind, target, intentAt: now(), result, resultAt: now(), uncertain };
  if (index === -1) effects.push(entry);
  else effects[index] = { ...effects[index], result, resultAt: entry.resultAt, uncertain };
  if (!uncertain) {
    setDisposition(store, task, { ...disposition, effects }, "disposition_effect_result", `${kind} ${target}: ${result}`);
    return;
  }
  // An uncertain effect stops in visible attention and retains the fence.
  // Retry reconciles the same persisted effect; it never launches recovery.
  const attention = `${kind} ${target}: ${result}`;
  store.update(task.id, { phase: "needs_attention", reason: task.reason, disposition: { ...disposition, effects, attention, status: "needs_attention" } }, "disposition_attention", attention);
}
/** A thread whose archive landed with a definite result: a resume re-reads it, it never re-archives it. */
function threadSettled(disposition: Disposition | null | undefined, agentId: string): boolean {
  return Boolean(disposition?.effects.some(effect => effect.kind === "archive_thread" && effect.target === agentId
    && effect.result !== null && !effect.uncertain));
}

function stopTurnText(task: Task): string {
  const kind = task.disposition?.kind === "supersede"
    ? `superseded by ${task.disposition.replacementTaskId}` : "cancelled";
  return `Nucleus: this task has been ${kind}. Stop immediately. Do not commit, push, tag, or create a release. End your turn now. Do not report a result.`;
}

function interruptTurnMessageId(taskId: string, agentId: string): string {
  return `ns-stop-${taskId}-${agentId}`;
}

function turnInterrupted(store: Store, taskId: string, agentId: string): boolean {
  return store.events(taskId).some(event => event.kind === "disposition_turn_interrupted" && event.detail === agentId);
}

/** One idempotent drain step, serialized per task. Safe to retry after restarts: persisted effects are reconciled, never duplicated. */
export async function progressDisposition(store: Store, deps: DispositionDeps, taskId: string): Promise<Task> {
  const task = store.task(taskId);
  if (deps.hostAvailable && !deps.hostAvailable(task)) return task;
  const prior = dispositionsInFlight.get(taskId);
  const step = (prior ? prior.catch(() => undefined) : Promise.resolve()).then(() => progressDispositionStep(store, deps, taskId));
  dispositionsInFlight.set(taskId, step);
  try { return await step; }
  finally { if (dispositionsInFlight.get(taskId) === step) dispositionsInFlight.delete(taskId); }
}

/**
 * Yield one macrotask between a disposition's durable steps (Spec 012). A
 * disposition is a multi-step quantum whose awaits otherwise resolve as
 * microtasks; a burst of them can starve timers, sockets and operator reads.
 */
const yieldDispositionTurn = () => new Promise<void>(resolve => setImmediate(resolve));

async function progressDispositionStep(store: Store, deps: DispositionDeps, taskId: string): Promise<Task> {
  let task = store.task(taskId);
  const disposition = task.disposition;
  if (!disposition || disposition.status === "complete") return task;

  // The disposition fence is durable before this call. Persist and reconcile
  // the host-run cancellation before worker drain or workspace effects can
  // advance the task past a still-running validation process.
  const validation = task.resolution.projectValidation;
  if (validation?.state === "running" && validation.hostRunId) {
    const target = validation.hostRunId;
    const prior = disposition.effects.findLast(effect => effect.kind === "cancel_project_validation" && effect.target === target);
    if (!prior || prior.result !== null) recordIntent(store, taskId, "cancel_project_validation", target);
    try {
      if (!deps.hooks.cancelProjectValidation)
        throw new Error("Project-validation cancellation is unavailable; host capacity remains reserved");
      await deps.hooks.cancelProjectValidation(store.task(taskId), disposition.reason);
      recordResult(store, taskId, "cancel_project_validation", target, "Supervisor stopped and host run settled cancelled");
    } catch (error) {
      recordResult(store, taskId, "cancel_project_validation", target,
        `Project-validation stop is uncertain: ${error instanceof Error ? error.message : String(error)}`, true);
      return store.task(taskId);
    }
    task = store.task(taskId);
  }

  // Snapshot origin refs before interrupting, so a later push is visible against the fence.
  await snapshotOriginRefs(store, deps, taskId);
  task = store.task(taskId);

  // 1. Drain owned threads. Interrupt an active turn immediately; a run lease
  // releases only after that turn is proved stopped.
  const runs = store.runs(taskId);
  const threads = ownedThreads(task, runs);
  let draining = false;
  for (const thread of threads) {
    // A thread whose archive already settled is recorded success, not a step to
    // replay: a resumed disposition (an owner retry of a later workspace step)
    // must not archive or release it again. An uncertain occurrence is not
    // settled and still reconciles through its own observation.
    if (threadSettled(task.disposition, thread.agentId)) continue;
    let stopped: boolean;
    try {
      stopped = (await deps.observeAgent(thread.agentId)).stopped;
    } catch (error) {
      if (error instanceof Error && error.message === "Agent was not found") stopped = true;
      else {
        recordResult(store, taskId, "stop_thread", thread.agentId, `Thread state is uncertain: ${error instanceof Error ? error.message : String(error)}`, true);
        return store.task(taskId);
      }
    }
    if (!stopped) {
      const current = store.task(taskId);
      if (!current.disposition?.effects.some(effect => effect.kind === "stop_thread" && effect.target === thread.agentId && effect.result === null))
        recordIntent(store, taskId, "stop_thread", thread.agentId);
      if (deps.interruptTurn && !turnInterrupted(store, taskId, thread.agentId)) {
        try {
          await deps.interruptTurn(thread.agentId, interruptTurnMessageId(taskId, thread.agentId), stopTurnText(store.task(taskId)));
          store.event(taskId, "disposition_turn_interrupted", thread.agentId);
        } catch (error) {
          recordResult(store, taskId, "stop_thread", thread.agentId,
            `Turn interrupt is uncertain: ${error instanceof Error ? error.message : String(error)}`, true);
          return store.task(taskId);
        }
      }
      draining = true;
      continue;
    }
    const run = thread.runId ? runs.find((candidate) => candidate.id === thread.runId) : undefined;
    if (run && !run.released) {
      recordIntent(store, taskId, "release_run", run.id);
      store.putRun({ ...run, released: true, status: "superseded" });
      recordResult(store, taskId, "release_run", run.id, "Turn proved stopped; lease released");
    }
    // T3 keeps every thread until the task is terminal. The ordinary terminal
    // lane archives workers and deletes support threads after this completes.
    if (deps.retainThreadsUntilCloseout?.()) continue;
    try {
      recordIntent(store, taskId, "archive_thread", thread.agentId);
      await deps.archiveAgent(thread.agentId);
      recordResult(store, taskId, "archive_thread", thread.agentId, "Thread archived after durable final state");
    } catch (error) {
      recordResult(store, taskId, "archive_thread", thread.agentId, `Thread archive is uncertain: ${error instanceof Error ? error.message : String(error)}`, true);
      return store.task(taskId);
    }
  }
  task = store.task(taskId);
  await observePostDispositionRefs(store, deps, taskId);
  task = store.task(taskId);
  if (draining) {
    if (task.disposition && task.disposition.status !== "needs_attention" && task.disposition.status !== "draining") {
      const interrupted = threads.some(thread => turnInterrupted(store, taskId, thread.agentId));
      setDisposition(store, task, { ...task.disposition, status: "draining" }, "disposition_draining", interrupted
        ? "Interrupted owned turns; waiting for them to stop; no replacement work is launched"
        : "Waiting for owned threads to stop; no replacement work is launched");
    }
    return store.task(taskId);
  }
  if (task.resolution.recoveryActive) {
    const current = store.task(taskId);
    store.update(current.id, { resolution: { ...current.resolution, recoveryActive: false, recoveryAttempts: 0, recovery: null } }, "disposition_recovery_cleared", "Owned turns drained; stale recovery budget cleared");
  }

  // 2. Close only this cancelled task's recorded PR; supersession has separate replacement rules.
  // A recorded PR the forge proves foreign (its head branch or repository does
  // not match the task) was only ever a foreign stored result (nucleus#1000):
  // the step records that it has no PR of its own to close, definitely, and the
  // disposition continues. Only an unobservable forge leaves the outcome
  // uncertain and parks the fence.
  task = store.task(taskId);
  if (task.disposition!.kind === "cancel" && (task.completion?.prNumber || task.resumePrNumber) &&
      !task.disposition!.effects.some(effect => effect.kind === "close_pr" && effect.result && !effect.uncertain)) {
    const target = String(task.completion?.prNumber ?? task.resumePrNumber);
    if (!task.disposition!.effects.some(effect => effect.kind === "close_pr" && effect.target === target && !effect.result))
      recordIntent(store, taskId, "close_pr", target);
    try {
      const result = await deps.settleCancelledPr(store.task(taskId));
      recordResult(store, taskId, "close_pr", target, result);
    } catch (error) {
      if (error instanceof ForeignRecordedPr) {
        recordResult(store, taskId, "close_pr", target, `${error.message}; no PR of its own to close`);
      } else {
        recordResult(store, taskId, "close_pr", target, `PR outcome is uncertain: ${error instanceof Error ? error.message : String(error)}`, true);
        return store.task(taskId);
      }
    }
  }

  // 3. Preserve work evidence and apply the requested workspace disposition.
  await yieldDispositionTurn();
  task = store.task(taskId);
  if (task.disposition && ["intent", "draining"].includes(task.disposition.status))
    setDisposition(store, store.task(taskId), { ...store.task(taskId).disposition!, status: "preserving" }, "disposition_preserving", "Owned threads drained; preserving work evidence");
  task = store.task(taskId);
  const workDisposition = dispositionWorkPolicy(task.disposition!);
  if (task.workspaceId && !task.disposition!.workspaceArchived && task.disposition!.effects.some(effect => effect.kind === "archive_workspace" && effect.target === task.workspaceId)) {
    try {
      if (await deps.observeWorkspaceArchived(task)) {
        const detail = `${task.disposition!.workspaceEvidence}; workspace archive observed`;
        task = setDisposition(store, task, { ...task.disposition!, workspaceArchived: true, workspaceEvidence: detail }, "disposition_workspace_archived", detail);
        recordResult(store, taskId, "archive_workspace", task.workspaceId!, "Workspace archive observed after delayed response");
      }
    } catch (error) {
      recordResult(store, taskId, "archive_workspace", task.workspaceId!, `Workspace archive observation is uncertain: ${error instanceof Error ? error.message : String(error)}`, true);
      return store.task(taskId);
    }
  }
  if (task.workspaceId) {
    if (task.disposition!.workspaceArchived) {
      // An acknowledged archive is terminal evidence even when its directory has gone.
    } else if (task.reviewEntry) {
      const detail = "Review-entry workspace preserved; Nucleus never archives externally owned work";
      task = setDisposition(store, task, { ...task.disposition!, workspaceId: task.workspaceId, workspaceEvidence: detail }, "disposition_workspace_preserved", detail);
    } else if (workDisposition === "preserve") {
      const detail = "Operator requested preserve; workspace, branch, commits and PR remain intact";
      task = setDisposition(store, task, { ...task.disposition!, workspaceId: task.workspaceId, workspaceEvidence: detail }, "disposition_workspace_preserved", detail);
    } else {
      const workspaceId: string = task.workspaceId;
      let proof: { empty: boolean; detail: string; uncertain?: string };
      try {
        proof = workDisposition === "retained_by_replacement"
          ? await proveRetainedForArchive(store, deps, task)
          : await deps.proveWorkspaceEmpty(task);
      } catch (error) {
        recordResult(store, taskId, "workspace_proof", workspaceId, `Work evidence is uncertain: ${error instanceof Error ? error.message : String(error)}`, true);
        return store.task(taskId);
      }
      if (proof.uncertain) {
        recordResult(store, taskId, "workspace_proof", workspaceId, proof.uncertain, true);
        return store.task(taskId);
      }
      if (!proof.empty) {
        task = setDisposition(store, store.task(taskId), { ...store.task(taskId).disposition!, workspaceId: task.workspaceId, workspaceEvidence: proof.detail }, "disposition_workspace_preserved", proof.detail);
      } else if (!task.disposition!.workspaceArchived) {
        // The worktree is preserved until the retention gate settles. A refusal,
        // failure, timeout or uncertain result is a hold with the hook's own
        // evidence; the disposition keeps its current status and is re-attempted
        // on the next pass, so `retry_effect` re-runs the gate and a pass then
        // archives.
        try { await sweepTaskHostProcesses(store, store.task(taskId), { force: true }); }
        catch (error) { store.event(taskId, "host_process_sweep_warning", `Host process sweep could not run: ${error instanceof Error ? error.message : String(error)}`); }
        const retention = await deps.hooks.preArchive?.(store.task(taskId));
        if (retention?.hold) {
          const current = store.task(taskId);
          task = store.update(current.id, {
            reason: retention.detail,
            disposition: { ...current.disposition!, workspaceId: task.workspaceId, workspaceEvidence: retention.detail },
          }, "disposition_retention_hold", retention.detail);
          return store.task(taskId);
        }
        task = setDisposition(store, store.task(taskId), { ...store.task(taskId).disposition!, status: "archiving", workspaceId: task.workspaceId, workspaceEvidence: proof.detail }, "disposition_archiving", proof.detail);
        try {
          const effects = task.disposition!.effects;
          const lastCleanupRetry = effects.findLastIndex(effect => effect.kind === "retry_build_output_cleanup" && effect.target === workspaceId);
          const priorAttempts = effects.slice(lastCleanupRetry + 1).filter(effect => effect.kind === "archive_workspace" && effect.target === workspaceId).length;
          let archived = priorAttempts ? await deps.observeWorkspaceArchived(task) : false;
          for (let attempts = priorAttempts; !archived && attempts < 2; attempts++) {
            recordIntent(store, taskId, "archive_workspace", workspaceId);
            try { archived = await deps.archiveWorkspace(store.task(taskId)); }
            catch { /* Observe the durable effect before deciding whether to retry. */ }
            if (!archived) archived = await deps.observeWorkspaceArchived(store.task(taskId));
            if (!archived) recordResult(store, taskId, "archive_workspace", workspaceId, "Workspace still present after archive request");
          }
          if (!archived) {
            const detail = `${proof.detail}; workspace remains present after one proven archive retry`;
            recordResult(store, taskId, "archive_workspace", workspaceId, detail);
            task = setDisposition(store, store.task(taskId), { ...store.task(taskId).disposition!, workspaceEvidence: detail }, "disposition_workspace_preserved", detail);
          } else {
            task = setDisposition(store, store.task(taskId), { ...store.task(taskId).disposition!, workspaceArchived: true, workspaceEvidence: `${proof.detail}; workspace archived` }, "disposition_workspace_archived", `Workspace ${workspaceId} archived after empty-work proof`);
            recordResult(store, taskId, "archive_workspace", workspaceId, "Workspace archived after empty-work proof");
          }
        } catch (error) {
          recordResult(store, taskId, "archive_workspace", workspaceId, `Workspace archive is uncertain: ${error instanceof Error ? error.message : String(error)}`, true);
          return store.task(taskId);
        }
      }
    }
  } else {
    task = setDisposition(store, task, { ...task.disposition!, workspaceEvidence: "No task workspace was created" }, "disposition_workspace_preserved", "No task workspace was created");
  }

  // 4. Fire the cancellation hook once, after preservation and before the terminal transition.
  await yieldDispositionTurn();
  task = store.task(taskId);
  if (!task.disposition!.hookEmitted) {
    recordIntent(store, taskId, "cancellation_hook", "task.cancelled");
    let emission: { hold: boolean; attention: boolean; records: unknown[] };
    try {
      emission = deps.hooks.cancellationEmissionSettled?.(taskId)
        ? { hold: false, attention: false, records: [] }
        : await deps.hooks.emit("task.cancelled", store.task(taskId), {
        event: "task.cancelled",
        summary: task.disposition!.kind === "supersede" ? `Superseded by ${task.disposition!.replacementTaskId}: ${task.disposition!.reason}` : task.disposition!.reason,
      });
    } catch (error) {
      recordResult(store, taskId, "cancellation_hook", "task.cancelled", `Hook outcome is uncertain: ${error instanceof Error ? error.message : String(error)}`, true);
      return store.task(taskId);
    }
    const preWorkspaceRefusal = settlesPreWorkspaceDispositionHook(store, store.task(taskId), emission.records);
    const legacyInstructionRefusal = settlesLegacyInstructionlessDispositionHook(store, store.task(taskId), emission.records);
    if ((emission.hold || emission.attention) && (preWorkspaceRefusal || legacyInstructionRefusal)) {
      const result = preWorkspaceRefusal
        ? "Pre-workspace hook refusal retained as evidence; no task-owned delivery existed"
        : "Legacy instructionless hook refusal retained as evidence; preserved task work is unchanged";
      const detail = preWorkspaceRefusal
        ? "task.cancelled could not affect a task rejected before any workspace, agent, run or PR existed"
        : "task.cancelled repeated the required task.blocked refusal for the missing legacy instruction artifact";
      recordResult(store, taskId, "cancellation_hook", "task.cancelled", result);
      task = setDisposition(store, store.task(taskId), { ...store.task(taskId).disposition!, status: "preserving", attention: "", hookEmitted: true },
        "disposition_hook_refusal_reconciled", detail);
    } else if (emission.hold || emission.attention) {
      recordResult(store, taskId, "cancellation_hook", "task.cancelled", "Repository hook holds the cancellation transition", true);
      return store.task(taskId);
    } else {
      task = setDisposition(store, store.task(taskId), { ...store.task(taskId).disposition!, hookEmitted: true }, "disposition_hook_emitted", "task.cancelled hook settled");
      recordResult(store, taskId, "cancellation_hook", "task.cancelled", "Hook settled");
    }
  }

  // 5. Terminal transition. Only done satisfies dependants; cancelled keeps them waiting.
  await yieldDispositionTurn();
  task = store.task(taskId);
  await observePostDispositionRefs(store, deps, taskId);
  task = store.task(taskId);
  if (task.siblingPins.length) {
    try { await deps.archiveSiblings?.(task); }
    catch (error) {
      store.event(taskId, "sibling_cleanup_uncertain", `Sibling worktree cleanup is uncertain: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const finalDisposition = task.disposition!;
  const reason = finalDisposition.kind === "supersede"
    ? `Superseded by ${finalDisposition.replacementTaskId}: ${finalDisposition.reason}`
    : finalDisposition.reason === "Cancelled before dispatch" ? finalDisposition.reason : `Cancelled: ${finalDisposition.reason}`;
  const completed = store.transaction(() => {
    const current = store.task(taskId);
    for (const notice of store.notices(taskId)) if (["pending", "intent"].includes(notice.status))
      store.putNotice({ ...notice, status: "superseded", error: "Task disposition completed before notice settlement" });
    const completed = store.update(current.id, {
      phase: "cancelled",
      reason,
      resolution: { ...current.resolution, attention: false, finishedHook: { phase: "cancelled", at: now() }, hostProcessSweep: hostProcessSweepIntent("cancelled") },
      disposition: { ...current.disposition!, status: "complete", completedAt: now(), attention: "" },
    }, "disposition_complete", reason);
    store.event(current.id, "attention_episode_resolved", "Completed disposition is terminal for task projection");
    return completed;
  });
  // The advisory finished-task runtime stop runs once the cancelled task is
  // terminal. A retained worktree gets one run of the repository's stop; a
  // worktree the disposition already archived is noted and skipped. Failure or
  // uncertainty is a task-history warning and never reopens the task.
  try { await deps.hooks.finished?.(completed); }
  catch (error) { store.event(taskId, "finished_hook_warning", `task.finished could not run: ${error instanceof Error ? error.message : String(error)}`); }
  try { await sweepTaskHostProcesses(store, store.task(taskId)); }
  catch (error) { store.event(taskId, "host_process_sweep_warning", `Host process sweep could not run: ${error instanceof Error ? error.message : String(error)}`); }
  // The stop and sweep clear their durable intents, so re-read the latest projection.
  return store.task(taskId);
}

async function proveRetainedForArchive(store: Store, deps: DispositionDeps, task: Task): Promise<{ empty: boolean; detail: string; uncertain?: string }> {
  const replacement = store.task(task.disposition!.replacementTaskId!);
  const proof = await deps.proveRetainedByReplacement(task, replacement);
  if (proof.uncertain || !proof.retained) return { empty: false, detail: proof.uncertain ?? proof.detail, uncertain: proof.uncertain };
  const empty = await deps.proveWorkspaceEmpty(task);
  if (empty.uncertain) return empty;
  if (!empty.empty) return { empty: false, detail: `Replacement retains the work, but the task workspace is not empty: ${empty.detail}` };
  return { empty: true, detail: `${proof.detail}; ${empty.detail}` };
}

/** Engine restart scans incomplete dispositions before normal task resolution. */
export async function resumeDispositions(store: Store, deps: DispositionDeps): Promise<void> {
  for (const task of store.maintenanceTasks()) {
    const current = store.task(task.id);
    if (!isDispositionActive(current)) continue;
    // A step already running owns this disposition; the pass never queues a second one behind it.
    if (dispositionInFlight(current.id)) continue;
    const validationStopPending = current.disposition?.effects.some(effect => effect.kind === "cancel_project_validation"
      && (effect.result === null || effect.uncertain)) ?? false;
    if (current.disposition?.status === "needs_attention" && !validationStopPending && !deps.hooks.cancellationEmissionSettled?.(current.id)) {
      // A cancellation occurrence held only by an exact operational base race is
      // re-evaluated through its normal emission path before recovery engages.
      const held = deps.hooks.heldAutomaticReplay?.(current);
      if (!held || held.record.event !== "task.cancelled" || held.ordinal === null) continue;
      if (!deps.hooks.automaticReplayAvailable?.(current)) continue;
    }
    if (task.hostId && deps.withHost) await deps.withHost(task.hostId, () => progressDisposition(store, deps, task.id));
    else await progressDisposition(store, deps, task.id);
  }
}
