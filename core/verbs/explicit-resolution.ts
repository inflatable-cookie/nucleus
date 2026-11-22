import { sameCallerIdentity } from "../../shared/agent-identity";
import {
  holdsOf,
  OPERATOR_BOARD_CALLER,
  syncHoldProjection,
  type Task,
} from "../../shared/contracts";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import type { QueueOperation } from "../../shared/operations";
import type {
  ExplicitResolution,
  ResolutionWarningId,
  TaskControlTask,
} from "../../shared/schema/task-control";
import {
  TASK_PROGRESSING_REASON,
  isWaitingTaskStop,
} from "../../shared/task-stop";
import type { Engine } from "../engine";
import { signalProcessGroupByLeader } from "../machine/process-group";
import {
  reattachRefusal,
  reattachStoredTaskCheckout,
} from "../git/checkout-reattach";
import { closeEscalationFollowups } from "../questions/ladder/continuation";
import { plannerEscalations } from "../questions/ladder/records";
import { blockingRecoveryEffects } from "../recovery/recovery-effects";
import { plannerIdMatches } from "../recovery/task-reasons";
import { reviewPublicationKey } from "../review/review-publication";
import { now, type Store } from "../store/store";
import { threadServesAnotherTask } from "../workspaces/thread-ownership";
import { collectOwnerVerbFacts, ownerPendingEffects } from "./owner-verbs";
import { splitOwnerEffectKey } from "./owner-effects";

import {
  messageSendPlan,
  phaseSetPlan,
  preflightExplicitRunStart,
  resolveMessageTarget,
  runStartPlan,
} from "./explicit-run-start";
import {
  closeoutNowPlan,
  mergeNowPlan,
  OPERATOR_ONLY_WARNINGS,
  preflightExplicitIntegration,
  turnReleasePlan,
  turnTakePlan,
} from "./explicit-integration";

type Source = "operator_board" | "project_planner" | "coordinator";
export type ExplicitWarning = { id: ResolutionWarningId; text: string };
export type ExplicitChange = { patch?: Partial<Task>; before: unknown };
export type ExplicitFinishResult = {
  issues: string[];
  runId?: string;
  delivery?: "delivered" | "queued" | "unknown";
};
export type ExplicitPlan = {
  warnings: ExplicitWarning[];
  apply(): ExplicitChange;
  finish?(): Promise<ExplicitFinishResult>;
};
type Warning = ExplicitWarning;
type Plan = ExplicitPlan;

const plannerWarnings = new Set<ResolutionWarningId>([
  "hold_owner",
  "route_policy",
  "two_writers",
]);
const missing = (kind: string, id: string): never => {
  throw Error(`No current ${kind} ${id} belongs to this task`);
};
const unfinished = (operation: QueueOperation) =>
  ["pending", "running", "needs_attention"].includes(operation.state);

function settleOperation(
  store: Store,
  operation: QueueOperation,
  reason: string,
) {
  const at = now();
  store.putOperation({
    ...operation,
    state: "failed",
    settledAt: at,
    diagnostic: reason,
    settlement: {
      id: operation.id,
      inputHash: operation.inputHash,
      attempt: operation.attempts,
      intentAt: operation.effect?.intentAt ?? operation.startedAt,
      evidence: reason,
      kind: "superseded",
    },
    effect: operation.effect
      ? {
          ...operation.effect,
          status: "reconciled",
          result: reason.slice(0, 2000),
          resultAt: at,
        }
      : null,
  });
}

/**
 * Planner authority comes from the registered thread and the caller's
 * authenticated identity. Host observation only decides where a message is
 * delivered, so an `unverified` planner (its host not yet proven after a roll)
 * still holds authority; the delivery route waits for the host on its own.
 */
export async function livePlannerMatches(
  engine: Engine,
  task: Task,
  caller: string,
  queue = false,
): Promise<boolean> {
  const project = queue
    ? engine.store.queueProject()
    : engine.store.projectFor(
        task.repoPath,
        normalizeRepositoryOrigin(task.repository ?? ""),
      );
  if (!project) return false;
  const { thread, shortlist } =
    await engine.resolution.responsibleThread(project);
  return Boolean(
    thread &&
      shortlist.some((candidate) =>
        sameCallerIdentity(
          thread.agentId,
          candidate.agentId,
          thread.hostId,
          candidate.hostId,
        ),
      ) &&
      plannerIdMatches(
        thread.agentId,
        caller,
        thread.hostId,
        engine.legacyPaseoHostId(),
      ),
  );
}

/** Names the real reason an explicit command's caller lacks authority. */
function explicitAuthorityRefusal(
  task: Task,
  caller: string | undefined,
): string {
  const who = task.critical
    ? "its live responsible planner or the operator board"
    : "this task's coordinator, its live responsible planner or the operator board";
  const why = caller
    ? "this caller is not one of them"
    : "no authenticated caller was given";
  return task.critical
    ? `A critical task requires ${who}; ${why}`
    : `Explicit resolution requires ${who}; ${why}`;
}

async function authority(
  engine: Engine,
  task: Task,
  caller: string | undefined,
): Promise<Source> {
  if (caller === OPERATOR_BOARD_CALLER) return "operator_board";
  if (caller && (await livePlannerMatches(engine, task, caller)))
    return "project_planner";
  const recovery = task.resolution.recovery;
  const run = recovery?.runId ? engine.store.run(recovery.runId) : null;
  if (
    !task.critical &&
    run &&
    run.taskId === task.id &&
    run.role === "recovery" &&
    !run.released &&
    !run.completion &&
    sameCallerIdentity(
      run.agentId,
      caller,
      run.hostId ?? task.hostId,
      engine.legacyPaseoHostId(),
    )
  )
    return "coordinator";
  throw Error(explicitAuthorityRefusal(task, caller));
}

/** Each command reads and applies its own records within the same transaction. */
export async function resolveExplicitly(
  engine: Engine,
  input: ExplicitResolution,
  describeNext: (task: Task) => string,
): Promise<TaskControlTask> {
  const store = engine.store;
  const id = store.resolveTaskId(input.taskId);
  const before = store.task(id);
  const source = await authority(engine, before, input.caller);
  const messageTarget =
    input.action === "message.send"
      ? await resolveMessageTarget(engine, before, input.role)
      : null;
  const runStartPreflight =
    input.action === "run.start" &&
    input.version === before.version &&
    !before.removedAt
      ? await preflightExplicitRunStart(engine, before, input)
      : undefined;
  const integrationPreflight =
    (input.action === "turn.take" ||
      input.action === "turn.release" ||
      input.action === "merge.now" ||
      input.action === "closeout.now") &&
    input.version === before.version &&
    !before.removedAt
      ? await preflightExplicitIntegration(engine, before, input)
      : undefined;
  const result = store.transaction(() => {
    const task = store.task(id);
    const reply = (
      status: "stale" | "warnings",
      warnings: Warning[] = [],
    ): { task: Task; status: typeof status; warnings: Warning[] } => ({
      task,
      status,
      warnings,
    });
    if (input.version !== task.version) return reply("stale");
    if (task.removedAt) throw Error("Task was removed from the queue");
    if (
      source === "coordinator" &&
      input.accept.some((id) => plannerWarnings.has(id))
    )
      throw Error(
        "Only the live responsible planner or operator board can accept hold_owner, route_policy or two_writers",
      );
    if (
      source !== "operator_board" &&
      input.accept.some((id) => OPERATOR_ONLY_WARNINGS.has(id))
    )
      throw Error("Only the operator board can accept unverified_merge");

    const inHost = <T>(fn: () => T): T =>
      task.hostId ? engine.withHost(task.hostId, fn) : fn();
    const plan =
      input.action === "run.release"
        ? releasePlan(engine, task, input)
        : input.action === "record.clear"
          ? clearPlan(engine, task, input)
          : input.action === "run.start"
            ? inHost(() => runStartPlan(engine, task, input, runStartPreflight))
            : input.action === "phase.set"
              ? phaseSetPlan(engine, task, input)
              : input.action === "message.send"
                ? messageSendPlan(engine, task, input, messageTarget!)
                : input.action === "turn.take"
                  ? turnTakePlan(engine, task, input)
                  : input.action === "turn.release"
                    ? turnReleasePlan(engine, task, input)
                    : input.action === "merge.now"
                      ? mergeNowPlan(engine, task, input, integrationPreflight)
                      : closeoutNowPlan(
                          engine,
                          task,
                          input,
                          integrationPreflight,
                        );
    if (plan.warnings.some((warning) => !input.accept.includes(warning.id)))
      return reply("warnings", plan.warnings);

    const { patch, before } =
      input.action === "run.start" ? inHost(() => plan.apply()) : plan.apply();
    const {
      caller,
      accept,
      reason,
      taskId: _identity,
      version,
      action,
      ...args
    } = input;
    const saved = store.update(
      task.id,
      patch ?? {},
      "owner_resolution",
      JSON.stringify({
        command: action,
        arguments: args,
        version,
        caller,
        source,
        warnings: plan.warnings,
        accepted: plan.warnings
          .filter((warning) => accept.includes(warning.id))
          .map((warning) => warning.id),
        reason,
        before,
      }),
    );
    return {
      task: saved,
      status: "applied" as const,
      warnings: plan.warnings,
      finish: plan.finish,
    };
  });
  const finished = "finish" in result ? await result.finish?.() : undefined;
  const latestTask = result.status === "applied" ? store.task(id) : result.task;
  const next = describeNext(latestTask);
  const deliveryNote = finished?.delivery
    ? `Message delivery: ${finished.delivery}.`
    : "";
  return {
    ...latestTask,
    explicitResolution: {
      status: result.status,
      warnings: result.warnings,
      ...(finished?.runId ? { runId: finished.runId } : {}),
      ...(finished?.delivery ? { delivery: finished.delivery } : {}),
      next: [
        result.status === "stale"
          ? `Task is now at version ${latestTask.version}. Repeat with that version.`
          : "",
        deliveryNote,
        ...(finished?.issues ?? []),
        next,
      ]
        .filter(Boolean)
        .join(" "),
    },
  };
}

export function releasePlan(
  engine: Engine,
  task: Task,
  input: Extract<ExplicitResolution, { action: "run.release" }>,
): Plan {
  const store = engine.store;
  const run = store.run(input.run);
  const initial = !run && task.runId === input.run;
  if ((!run || run.taskId !== task.id) && !initial)
    return missing("run", input.run);
  const agentId = run ? run.agentId : task.agentId;
  const hostId = run?.hostId ?? task.hostId;
  const completion = run ? run.completion : task.completion;
  const live = run
    ? !run.released &&
      (run.active !== false ||
        ["running", "intent", "uncertain"].includes(run.status))
    : task.agentActive !== false || task.agentIntent;
  const process = store.hostRun(input.run);
  const warnings: Warning[] = [];
  if (live || process?.state === "running")
    warnings.push({
      id: "live_turn",
      text: "This run may have a live turn. Stopping a worker may lose uncommitted changes.",
    });
  if (!completion && !run?.released)
    warnings.push({
      id: "unreported_result",
      text:
        run?.role === "reviewer" && run.agentId && !run.exhaustionReason
          ? "Only this reviewer's first verdict at the current exact head can still be accepted."
          : "Any later report from this run will be refused.",
    });

  return {
    warnings,
    apply() {
      const resolution = { ...task.resolution };
      const patch: Partial<Task> = { resolution };
      if (run) {
        for (const delivery of run.reviewDeliveries ?? []) {
          if (delivery.status !== "reserved" && delivery.status !== "uncertain")
            continue;
          const operation = store.operation(delivery.operationId);
          if (operation?.taskId === task.id && unfinished(operation))
            settleOperation(store, operation, input.reason);
        }
        store.putRun({
          ...run,
          active: false,
          released: true,
          explicitlyReleasedAt: now(),
          status: run.completion ? "finished" : "superseded",
          reviewDeliveries: run.reviewDeliveries?.map((delivery) =>
            delivery.status === "reserved" || delivery.status === "uncertain"
              ? {
                  ...delivery,
                  status: "refused",
                  evidence: input.reason.slice(0, 2000),
                  observedAt: now(),
                }
              : delivery,
          ),
          reviewContinuation: null,
        });
      }
      if (!run) store.deleteCredential(input.run);
      if (task.runId === input.run)
        Object.assign(patch, {
          ...(!completion ? { runId: null, agentId: null } : {}),
          agentIntent: false,
          agentActive: false,
        });
      if (resolution.currentRunId === input.run && !completion) {
        resolution.currentRunId = null;
        if (run?.role === "reviewer") {
          resolution.reviewerAgentId = null;
          resolution.reviewerProfile = null;
        }
      }
      if (resolution.restartSlotHold?.fromRunId === input.run)
        resolution.restartSlotHold = null;
      const recovery = resolution.recovery;
      if (recovery?.runId === input.run && !completion) {
        resolution.recoveryActive = false;
        resolution.recovery = {
          ...recovery,
          runId: null,
          status: "resolved",
          ...(recovery.action?.status === "pending"
            ? {
                action: {
                  ...recovery.action,
                  status: "refused",
                  reason: input.reason,
                },
              }
            : {}),
        };
      }
      return { patch, before: run ?? { id: input.run, agentId, completion } };
    },
    async finish() {
      const issues: string[] = [];
      const attempt = async (label: string, fn: () => unknown) => {
        try {
          await fn();
        } catch (error) {
          issues.push(
            `${label} could not be confirmed: ${String(error).slice(0, 500)}.`,
          );
        }
      };
      // Spec 068 §4: a release settles its run's custody of the checkout, so the
      // same reattach step runs here and reports why a detached checkout stayed
      // detached. The commit never moves.
      const reattach = await reattachStoredTaskCheckout(
        store,
        task.id,
        run?.id ?? input.run,
      );
      const reattachRefused = reattachRefusal(reattach);
      if (reattachRefused) issues.push(`Checkout reattach: ${reattachRefused}.`);
      if (process?.pid && process.processGroupId && process.startIdentity) {
        await attempt("Process-group stop", () => {
          signalProcessGroupByLeader(
            process.processGroupId!,
            process.pid!,
            process.startIdentity!,
            "SIGTERM",
          );
        });
      }
      if (agentId && (live || input.archive)) {
        const current = store.task(task.id);
        // Stop the released turn without dropping the retained worker binding.
        const releasedRetainedTurn =
          current.runId === task.runId &&
          (initial || (run?.role === "revision" && task.resolution.currentRunId === run.id));
        if (
          (current.agentId === agentId && !releasedRetainedTurn) ||
          threadServesAnotherTask(store, current, agentId)
        )
          return {
            issues: [
              ...issues,
              "Another live assignment still owns this thread.",
            ],
          };
        const onHost = async () => {
          if (live)
            await attempt("Turn cancellation", () =>
              engine.host.stopAgentTurn(agentId),
            );
          if (!input.archive) return;
          const latest = store.task(task.id);
          if (
            latest.agentId === agentId ||
            threadServesAnotherTask(store, latest, agentId)
          ) {
            issues.push(
              "The task still depends on this thread, so it remains available.",
            );
            return;
          }
          await attempt("Thread archive", () =>
            engine.host.archiveAgent(agentId),
          );
        };
        await attempt("Host contact", () =>
          hostId ? engine.withHost(hostId, onHost) : onHost(),
        );
      }
      return { issues };
    },
  };
}

function clearPlan(
  engine: Engine,
  task: Task,
  input: Extract<ExplicitResolution, { action: "record.clear" }>,
): Plan {
  const { id, kind } = input;
  const store = engine.store;
  const r = task.resolution;
  const stop = r.stop;
  const patch = (
    before: unknown,
    fields: Partial<Task>,
    warnings: Warning[] = [],
  ): Plan => ({ warnings, apply: () => ({ before, patch: fields }) });
  const clearStop = { stop: null };
  const clearStopPatch = {
    resolution: { ...r, ...clearStop },
    reason: TASK_PROGRESSING_REASON,
  };
  const ownerWarning = (owner: string | null): Warning[] =>
    owner && owner !== input.caller
      ? [{ id: "hold_owner", text: `This hold belongs to ${owner}.` }]
      : [];
  switch (kind) {
    case "stop":
      if (stop?.since === id) return patch(stop, clearStopPatch);
      break;
    case "wait":
      if (task.prerequisiteWait?.id === id && !task.prerequisiteWait.releasedAt)
        return patch(task.prerequisiteWait, { prerequisiteWait: null });
      if (stop?.since === id && isWaitingTaskStop(stop.reason))
        return patch(stop, clearStopPatch);
      break;
    case "hold": {
      const holds = { ...holdsOf(task) };
      if (id !== "dispatch" && id !== "merge") break;
      const hold = holds[id];
      if (!hold) break;
      delete holds[id];
      return patch(hold, syncHoldProjection(holds), ownerWarning(hold.owner));
    }
    case "incident":
      if (r.incident?.id === id)
        return patch(r.incident, { resolution: { ...r, incident: null } });
      break;
    case "host_wait":
      if (r.hostWait?.hostId === id)
        return patch(r.hostWait, {
          resolution: {
            ...r,
            hostWait: null,
            ...(stop?.reason === "host_unavailable" ? clearStop : {}),
          },
          ...(stop?.reason === "host_unavailable"
            ? { reason: TASK_PROGRESSING_REASON }
            : {}),
        });
      // Spec 069 §3: a host wait is worked out from the host's health when read;
      // no record is stored to clear, and it ends when the host reconnects.
      if (id === task.hostId && engine.inFlightHostWait(task))
        throw Error(
          `The host wait on ${id} is read from the host's health, not stored on the task; it clears when the host reconnects, and there is no record to clear`,
        );
      break;
    case "owner_stop":
      if (
        r.ownerStop &&
        (r.ownerStop.operationId ?? r.ownerStop.recordedAt) === id
      ) {
        const ownerStop = r.ownerStop;
        const warnings = ownerWarning(ownerStop.caller);
        if (ownerStop.cancellations.some((item) => item.status !== "settled"))
          warnings.push({
            id: "effect_may_land",
            text: "A requested cancellation may still take effect.",
          });
        return patch(
          ownerStop,
          { resolution: { ...r, ownerStop: null } },
          warnings,
        );
      }
      break;
    case "deferred_verb":
      if (r.deferredVerb?.at === id)
        return patch(r.deferredVerb, {
          resolution: { ...r, deferredVerb: null },
        });
      break;
    case "escalation": {
      const escalations = plannerEscalations(store.eventsAll(task.id));
      const escalation = escalations.find(
        (item) => item.id === id && !item.answered,
      );
      if (!escalation) break;
      return {
        warnings: [],
        apply() {
          store.event(
            task.id,
            "planner_escalation_resolved",
            `${id}: ${input.reason}`,
          );
          closeEscalationFollowups(store, task.id, id);
          return {
            before: escalation,
            patch:
              stop?.fact?.code === "escalation" && stop.fact.subject === id
                ? clearStopPatch
                : undefined,
          };
        },
      };
    }
    case "effect":
      return clearEffect(engine, task, id, input.reason);
  }
  return missing(kind, id);
}

function clearEffect(
  engine: Engine,
  task: Task,
  id: string,
  reason: string,
): Plan {
  const store = engine.store;
  const warning: Warning = {
    id: "effect_may_land",
    text: "The original effect may still complete or repeat.",
  };
  const effect = splitOwnerEffectKey(id);
  const key = effect?.identity ?? id;
  const kind = effect?.kind;
  if (kind === "hook" || kind === "merged_task_retention") {
    const hook = store
      .hookEvents(task.id)
      .find((item) => item.id === key || item.eventId === key);
    if (hook && !["result", "published", "superseded"].includes(hook.state))
      return {
        warnings: [warning],
        apply() {
          store.putHookEvent({
            ...hook,
            state: "superseded",
            updatedAt: now(),
          });
          return { before: hook };
        },
      };
  }
  const operation =
    !kind || kind === "operation" || kind === "task_control_operation"
      ? store.operation(key)
      : null;
  if (operation?.taskId === task.id && unfinished(operation)) {
    return {
      warnings: [warning],
      apply() {
        settleOperation(store, operation, reason);
        return { before: operation };
      },
    };
  }
  const notice =
    (!kind || kind === "attention-notice") &&
    store.notices(task.id).find((item) => item.id === key);
  if (notice && ["pending", "intent", "uncertain"].includes(notice.status)) {
    return {
      warnings: [warning],
      apply() {
        store.putNotice({
          ...notice,
          status: "superseded",
          error: reason,
          explicitlyClearedAt: now(),
        });
        return { before: notice };
      },
    };
  }
  if (kind === "owned_tool") {
    const held = ownerPendingEffects(collectOwnerVerbFacts(store, task)).find(
      (item) => item.effect === id,
    );
    if (held)
      return {
        warnings: [
          {
            id: "owned_tool",
            text: "The recorded tool process may still be writing.",
          },
        ],
        apply() {
          store.event(
            task.id,
            "owned_tool_settled",
            JSON.stringify({ runId: key, evidence: reason }),
          );
          return { before: held };
        },
      };
  }
  const run = !kind || kind === "run-delivery" ? store.run(key) : null;
  if (run?.taskId === task.id && ["intent", "uncertain"].includes(run.status)) {
    return {
      warnings: [warning],
      apply() {
        store.putRun({
          ...run,
          status: run.released ? "superseded" : "stopped",
        });
        return { before: run };
      },
    };
  }
  if (!kind || kind === "review-delivery") {
    for (const run of store.runs(task.id)) {
      const delivery = run.reviewDeliveries?.find(
        (item) => item.deliveryId === key,
      );
      if (
        !delivery ||
        (delivery.status !== "reserved" && delivery.status !== "uncertain")
      )
        continue;
      return {
        warnings: [warning],
        apply() {
          store.putRun({
            ...run,
            reviewDeliveries: run.reviewDeliveries?.map((item) =>
              item === delivery
                ? {
                    ...item,
                    status: "refused",
                    evidence: reason.slice(0, 2000),
                    observedAt: now(),
                  }
                : item,
            ),
          });
          return { before: delivery };
        },
      };
    }
  }
  if (kind === "review_publication" || kind === "publication") {
    const publication = store.getMeta(reviewPublicationKey(key));
    if (
      publication &&
      blockingRecoveryEffects(store, task, {
        kinds: ["publication"],
        runId: key,
      }).some((effect) => effect.identity === key)
    )
      return {
        warnings: [warning],
        apply() {
          store.deleteMeta(reviewPublicationKey(key));
          return { before: publication };
        },
      };
  }
  const r = task.resolution;
  if (
    id === "project-validation.project-validation" &&
    r.projectValidation &&
    !["passed", "superseded"].includes(r.projectValidation.state)
  )
    return {
      warnings: [warning],
      apply: () => ({
        before: r.projectValidation,
        patch: {
          resolution: {
            ...r,
            projectValidation: { ...r.projectValidation!, state: "superseded" },
          },
        },
      }),
    };
  // The merge request itself stays as durable evidence for the exact-head hard gate.
  if (
    id === "merge-response.merge-response" &&
    !r.mergedCommit &&
    (r.mergeResponseOutcome === "uncertain" ||
      r.mergeRetryOutcome === "uncertain" ||
      (r.mergeIntent && r.mergeResponseOutcome === "pending"))
  )
    return {
      warnings: [warning],
      apply: () => ({
        before: {
          intent: r.mergeIntent,
          head: r.mergeHead,
          requestedAt: r.mergeRequestedAt,
          response: r.mergeResponseOutcome,
          retry: r.mergeRetryOutcome,
        },
        patch: {
          resolution: {
            ...r,
            mergeIntent: false,
            mergeResponseOutcome: "pending",
            mergeRetryOutcome: null,
            mergeRetryAt: null,
            mergeAutoRetryExhausted: true,
          },
        },
      }),
    };
  return missing("effect", id);
}
