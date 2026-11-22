import {
  explicitResolutionSchema,
  OPERATOR_BOARD_CALLER,
  taskControlInputSchema,
  type DecisionView,
  type ExplicitCommand,
  type Task,
  type TaskControlInput,
  type TaskControlTask,
} from "../../shared/contracts";
import { TASK_PROGRESSING_REASON } from "../../shared/task-stop";
import { isT3OperatorIdentity } from "../../shared/operator-identity";
import {
  appliedMergeVerdict,
  escalationOutlived,
  readyReviewAtHead,
} from "../recovery/task-reasons";
import { Decisions } from "../planning/decisions";
import type { Resolution } from "../resolution";
import type { Store } from "../store/store";
import {
  decodeEscalationChoice,
  escalationAnswerControl,
  escalationContinuationInstruction,
  escalationVerbChoices,
  extractDecisionIdCandidates,
  extractFirstIsoTimestamp,
  extractTaskReferenceCandidates,
  plannerEscalations,
  type EscalationVerbChoice,
  type LadderEvent,
  type PlannerEscalation,
} from "./ladder";
import { closeEscalationFollowups } from "./ladder/continuation";
import {
  collectOwnerVerbFacts,
  ownerPendingEffects,
  ownerVerbViews,
} from "../verbs/owner-verbs";
import {
  HostReadRefusalError,
  ProvenPreSendRefusalError,
} from "../host/errors";

function escalationPayload(
  events: readonly LadderEvent[],
  id: string,
): Record<string, unknown> | null {
  const event = events.find(
    (item) =>
      item.kind === "planner_escalation_payload" &&
      item.detail.startsWith(`${id}:`),
  );
  if (!event) return null;
  try {
    const parsed: unknown = JSON.parse(
      event.detail.slice(event.detail.indexOf(":") + 1),
    );
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Retire an escalation's owned stop, waits, followups, and optionally its open
 * operator-classification decision so the scheduler cannot re-park the task on
 * a settled or cause-cleared escalation.
 */
function retireEscalationSurfaces(
  store: Store,
  taskId: string,
  escalationId: string,
  detail: string,
  options: { withdrawDecision?: boolean } = {},
): void {
  closeEscalationFollowups(store, taskId, escalationId);
  for (const questionId of [
    `ns-escalation-${escalationId}`,
    `ns-escalation-${escalationId}-project`,
    `ns-decider-${escalationId}`,
  ]) {
    const key = `delegation:${questionId}`;
    const qEvents = store.eventsAll(key);
    if (
      qEvents.length &&
      !qEvents.some((event) => event.kind === "delegated_closed")
    )
      store.event(
        key,
        "delegated_closed",
        `Escalation ${escalationId} closed: ${detail}`.slice(0, 4000),
      );
  }
  const events = store.eventsAll(taskId);
  const activeWaits = events.filter(
    (event) =>
      event.kind === "planner_escalation_wait" &&
      event.detail.startsWith(`${escalationId}:`) &&
      !events.some(
        (sup) =>
          sup.kind === "planner_escalation_wait_superseded" &&
          sup.id > event.id &&
          sup.detail.startsWith(`${escalationId}:`),
      ),
  );
  if (activeWaits.length > 0)
    store.event(
      taskId,
      "planner_escalation_wait_superseded",
      `${escalationId}: ${detail}`.slice(0, 4000),
    );
  if (options.withdrawDecision) {
    const linked = events.findLast(
      (event) =>
        event.kind === "planner_escalation_decision_linked" &&
        event.detail.startsWith(`${escalationId}:`),
    );
    const decisionId = linked?.detail.match(/decision ([0-9a-f-]{36})/)?.[1];
    if (decisionId) {
      try {
        const stored = store.decision(decisionId);
        if (stored.status === "open") {
          const decisions = new Decisions(store);
          const withdrawInput = {
            id: stored.id,
            version: stored.version,
            reason: `Escalation ${escalationId} closed automatically: ${detail}`,
            withdrawnBy: "nucleus",
          };
          if (store.db.isTransaction)
            decisions.withdrawInTransaction(withdrawInput);
          else decisions.withdraw(withdrawInput);
        }
      } catch {
        /* A missing or concurrently closed decision needs no withdrawal. */
      }
    }
  }
  const latest = store.task(taskId);
  if (
    latest.resolution.stop?.fact?.code === "escalation" &&
    latest.resolution.stop.fact.subject === escalationId
  ) {
    store.update(
      taskId,
      {
        resolution: { ...latest.resolution, stop: null },
        ...(![
          "done",
          "cancelled",
          "blocked",
          "error",
          "needs_attention",
        ].includes(latest.phase)
          ? { reason: TASK_PROGRESSING_REASON }
          : {}),
      },
      "planner_escalation_stop_cleared",
      `${escalationId}: ${detail}`.slice(0, 4000),
    );
  }
}

/**
 * Spec 067 batch 4: list the explicit resolution commands that resolve an
 * escalation's cause with their arguments filled. Choosing one runs the
 * command through its ordinary RPC instead of writing an escalation answer.
 */
export function escalationExplicitCommandChoices(
  store: Store,
  task: Task,
  escalationId: string,
  events: LadderEvent[],
  pendingEffectIds: readonly string[] = [],
): EscalationVerbChoice[] {
  const escalation = plannerEscalations(events).find(
    (item) => item.id === escalationId,
  );
  const payload = escalationPayload(events, escalationId);
  const options: EscalationVerbChoice[] = [];
  const push = (label: string, command: ExplicitCommand) => {
    options.push({
      label,
      verb: "explicit",
      args: {},
      command: { ...command, version: task.version },
    });
  };
  if (payload?.reviewContinuation) {
    const reader =
      typeof payload.reader === "string" ? payload.reader : undefined;
    push(
      `Explicit command: run.start role=reviewer agent=fresh${reader ? ` replacing=${reader}` : ""}`,
      {
        action: "run.start",
        role: "reviewer",
        agent: "fresh",
        ...(reader ? { replacing: reader } : {}),
        accept: [],
      },
    );
  }
  if (
    typeof payload?.commit === "string" &&
    typeof payload?.head === "string"
  ) {
    push(`Explicit command: closeout.now mergedCommit=${payload.commit}`, {
      action: "closeout.now",
      mergedCommit: payload.commit,
      accept: [],
    });
  }
  const runIds = [
    ...new Set(
      [
        escalation?.runId,
        typeof payload?.reader === "string" ? payload.reader : null,
        task.resolution.currentRunId,
      ].filter((value): value is string => Boolean(value)),
    ),
  ];
  for (const runId of runIds) {
    const run = store.run(runId);
    if (run && !run.released)
      push(`Explicit command: run.release run=${runId}`, {
        action: "run.release",
        run: runId,
        accept: [],
      });
  }
  const incident = task.resolution.incident;
  if (incident && incident.status !== "resolved")
    push(`Explicit command: record.clear kind=incident id=${incident.id}`, {
      action: "record.clear",
      kind: "incident",
      id: incident.id,
      accept: [],
    });
  for (const effectId of new Set(pendingEffectIds))
    push(`Explicit command: record.clear kind=effect id=${effectId}`, {
      action: "record.clear",
      kind: "effect",
      id: effectId,
      accept: [],
    });
  push(`Explicit command: record.clear kind=escalation id=${escalationId}`, {
    action: "record.clear",
    kind: "escalation",
    id: escalationId,
    accept: [],
  });
  return options;
}

/** Combine ordinary offered owner verbs and explicit command options for an escalation. */
export function escalationOfferedChoices(
  store: Store,
  task: Task,
  escalationId: string,
  events: LadderEvent[],
): EscalationVerbChoice[] {
  const facts = collectOwnerVerbFacts(store, task);
  return [
    ...escalationVerbChoices(ownerVerbViews(facts)),
    ...escalationExplicitCommandChoices(
      store,
      task,
      escalationId,
      events,
      ownerPendingEffects(facts).map((effect) => effect.effect),
    ),
  ];
}

/**
 * Spec 067 batch 4: an open escalation closes itself when its recorded cause
 * clears. Each typed cause uses its own clearance condition and never falls
 * through to a generic run check.
 */
export function escalationCauseClearedReason(
  store: Store,
  task: Task,
  escalation: PlannerEscalation,
  events: readonly LadderEvent[],
): string | null {
  if (escalation.answered) return null;
  if (task.removedAt) return "the task was removed";
  if (escalationOutlived(task)) return "the task merged or ended";
  const intentEvent = events.find(
    (item) =>
      item.kind === "planner_escalation" &&
      item.detail.startsWith(`${escalation.id}:`),
  );
  const payload = escalationPayload(events, escalation.id);
  if (payload?.reviewContinuation) {
    if (readyReviewAtHead(task))
      return "a ready review verdict arrived for the current head";
    if (typeof payload.reader === "string") {
      const reader = store.run(payload.reader);
      if (
        !reader ||
        reader.released ||
        (task.resolution.currentRunId &&
          task.resolution.currentRunId !== payload.reader)
      )
        return "the stopped reviewer run was released or replaced";
    }
    return null;
  }
  if (typeof payload?.commit === "string" && typeof payload?.head === "string")
    return appliedMergeVerdict(task, payload.head)
      ? "review or operator source acceptance arrived for the merged head"
      : null;
  if (typeof payload?.revisionCap === "number")
    return readyReviewAtHead(task)
      ? "a ready review verdict arrived for the current head"
      : null;
  if (payload?.cause === "recovery-pending")
    return !task.resolution.incident ||
      task.resolution.incident.status === "resolved"
      ? "the escalated incident cleared"
      : null;
  if (escalation.runId) {
    const raisingRun = store.run(escalation.runId);
    if (
      raisingRun?.explicitlyReleasedAt &&
      (!intentEvent ||
        Date.parse(raisingRun.explicitlyReleasedAt) >=
          Date.parse(intentEvent.at))
    )
      return `the raising ${raisingRun.role} run (${raisingRun.id}) was explicitly released`;
  }
  if (intentEvent) {
    const clearedEffects = events.flatMap((item) => {
      if (item.id <= intentEvent.id || item.kind !== "owner_resolution")
        return [];
      try {
        const detail = JSON.parse(item.detail) as {
          command?: string;
          arguments?: { kind?: string; id?: string };
        };
        return detail.command === "record.clear" &&
          detail.arguments?.kind === "effect" &&
          typeof detail.arguments.id === "string"
          ? [detail.arguments.id]
          : [];
      } catch {
        return [];
      }
    });
    if (clearedEffects.length > 0) {
      if (escalation.runId) {
        const run = store.run(escalation.runId);
        if (
          run &&
          !["intent", "uncertain"].includes(run.status) &&
          clearedEffects.some(
            (effectId) =>
              effectId.replace(/^run-delivery\./, "") === escalation.runId,
          )
        )
          return "the escalated run-delivery effect was cleared";
        const deliveries = run?.reviewDeliveries ?? [];
        const hasPendingDelivery = deliveries.some(
          (d) => d.status === "reserved" || d.status === "uncertain",
        );
        const clearedRunDelivery = clearedEffects.some((effectId) => {
          const deliveryId = effectId.replace(/^review-delivery\./, "");
          return deliveries.some(
            (d) => d.deliveryId === deliveryId && d.status === "refused",
          );
        });
        if (clearedRunDelivery && !hasPendingDelivery)
          return "the escalated delivery effect was cleared";
      }
      if (ownerPendingEffects(collectOwnerVerbFacts(store, task)).length === 0)
        return "the escalated pending effect was cleared";
    }
  }
  if (
    intentEvent &&
    (payload?.source === "worker" || payload?.source === "revision") &&
    !escalation.refusal &&
    task.completion?.status === "ready_for_review" &&
    events.some(
      (item) =>
        item.id > intentEvent.id &&
        item.detail.includes(task.completion!.eventId),
    )
  )
    return "a ready result arrived after the blocker escalation";
  const currentRun = task.resolution.currentRunId
    ? store.run(task.resolution.currentRunId)
    : null;
  if (
    intentEvent &&
    currentRun &&
    currentRun.status === "running" &&
    !currentRun.released &&
    !currentRun.completion &&
    currentRun.role !== "recovery" &&
    currentRun.id !== escalation.runId &&
    Date.parse(currentRun.createdAt) > Date.parse(intentEvent.at)
  )
    return `a new ${currentRun.role} run (${currentRun.id}) took over the task`;
  return null;
}

/** Close any open escalations on this task whose cause has already cleared, and finish retiring interrupted resolutions. */
export function closeClearedEscalations(store: Store, task: Task): string[] {
  const current = store.taskOrNull(task.id);
  if (!current) return [];
  const events = store.eventsAll(current.id) as LadderEvent[];
  const closed: string[] = [];
  for (const escalation of plannerEscalations(events)) {
    if (escalation.answered) {
      // Durability: if a process crashed after writing `planner_escalation_resolved`
      // but before retiring the escalation's stop, owned wait or open decision,
      // finish retiring those surfaces atomically on the next maintenance pass.
      const resolvedEvent = events.findLast(
        (event) =>
          event.kind === "planner_escalation_resolved" &&
          event.detail.startsWith(`${escalation.id}:`),
      );
      if (resolvedEvent) {
        const detail = resolvedEvent.detail
          .slice(escalation.id.length + 1)
          .trim();
        const repair = () =>
          retireEscalationSurfaces(store, current.id, escalation.id, detail, {
            withdrawDecision: true,
          });
        if (store.db.isTransaction) repair();
        else store.transaction(repair);
      }
      continue;
    }
    const cleared = escalationCauseClearedReason(
      store,
      current,
      escalation,
      events,
    );
    if (!cleared) continue;
    const apply = () => {
      store.event(
        current.id,
        "planner_escalation_resolved",
        `${escalation.id}: closed automatically; ${cleared}`,
      );
      retireEscalationSurfaces(store, current.id, escalation.id, cleared, {
        withdrawDecision: true,
      });
    };
    if (store.db.isTransaction) apply();
    else store.transaction(apply);
    closed.push(escalation.id);
  }
  return closed;
}

export type EscalationExplicitOutcome = NonNullable<
  TaskControlTask["explicitResolution"]
> & { taskVersion: number };

type Answerer =
  | { role: "planner" | "decider"; agentId: string }
  | { role: "operator" };

/** Legacy receipts carry only a display label; decode it at the boundary. */
function answererFromLabel(who: string): Answerer {
  const match = /^(planner|decider) (.*)$/.exec(who);
  return match
    ? {
        role: match[1] as "planner" | "decider",
        agentId: match[2]!.split(" ")[0] || "unknown",
      }
    : { role: "operator" };
}

/** Applies and reconciles recorded planner escalation answers. */
export class EscalationSettlement {
  private readonly escalationSettlements = new Map<
    string,
    Promise<string | null>
  >();
  constructor(readonly resolution: Resolution) {}
  get store() {
    return this.resolution.store;
  }
  settlePlannerEscalation(
    t: Task,
    id: string,
    answer: string,
    who: string,
    offered: EscalationVerbChoice[] = [],
    questionId = `ns-escalation-${id}`,
    answerer: Answerer = answererFromLabel(who),
    version?: number,
  ): Promise<string | null> {
    const key = `${t.id}:${id}`;
    const existing = this.escalationSettlements.get(key);
    if (existing) return existing;
    const settlement = this.settlePlannerEscalationOnce(
      t,
      id,
      answer,
      who,
      offered,
      questionId,
      answerer,
      version,
    ).then((result) => {
      if (
        !result &&
        plannerEscalations(this.store.eventsAll(t.id)).some(
          (item) => item.id === id && item.answered,
        )
      )
        closeEscalationFollowups(this.store, t.id, id);
      return result;
    });
    this.escalationSettlements.set(key, settlement);
    const cleanup = () => {
      if (this.escalationSettlements.get(key) === settlement)
        this.escalationSettlements.delete(key);
    };
    settlement.then(cleanup, cleanup);
    return settlement;
  }
  /**
   * Spec 067 batch 4: apply an explicit resolution command carried inside an
   * escalation answer through the batch 1 contract with the answerer's
   * authority. Warnings and stale versions change nothing and return directly
   * so the caller can repeat with `accept` or the current version.
   */
  async settleExplicitEscalationCommand(
    t: Task,
    id: string,
    command: ExplicitCommand,
    reason: string,
    who: string,
    answerer: Answerer = answererFromLabel(who),
    version?: number,
  ): Promise<EscalationExplicitOutcome> {
    const current = this.store.task(t.id);
    if (!escalationOutlived(current))
      closeClearedEscalations(this.store, current);
    if (
      plannerEscalations(this.store.eventsAll(t.id) as LadderEvent[]).find(
        (item) => item.id === id,
      )?.answered
    )
      throw Error(`Escalation ${id} is already settled; read next again`);
    if (!this.resolution.applyExplicitResolution)
      throw Error("No explicit resolution applier is bound");
    const fresh = this.store.task(t.id);
    const caller =
      answerer.role === "operator" ? OPERATOR_BOARD_CALLER : answerer.agentId;
    const { version: commandVersion, accept, ...commandArgs } = command;
    const explicitInput = explicitResolutionSchema.parse({
      ...commandArgs,
      taskId: fresh.id,
      version: version ?? commandVersion ?? fresh.version,
      reason: reason.slice(0, 4000),
      accept: accept ?? [],
      caller,
    });
    const resolved =
      await this.resolution.applyExplicitResolution(explicitInput);
    const outcome = resolved.explicitResolution;
    if (!outcome)
      throw Error("Explicit resolution did not return a resolution outcome");
    if (outcome.status === "applied") {
      const oldNext = this.resolution.describeExplicitNext?.(resolved) ?? "";
      const diagnosticPrefix =
        oldNext && outcome.next.endsWith(oldNext)
          ? outcome.next.slice(0, -oldNext.length).trim()
          : "";
      closeClearedEscalations(this.store, this.store.task(fresh.id));
      const afterTask = this.store.task(fresh.id);
      const updatedNext =
        this.resolution.describeExplicitNext?.(afterTask) ?? outcome.next;
      const next = [diagnosticPrefix, updatedNext].filter(Boolean).join(" ");
      return { ...outcome, next, taskVersion: afterTask.version };
    }
    return { ...outcome, taskVersion: resolved.version };
  }
  /**
   * Spec 067 batch 4: when a board or native-inbox decision answer chooses a
   * listed explicit command option of a linked open escalation, dispatch the
   * command through its ordinary RPC without persisting a decision answer.
   */
  dispatchDecisionExplicitCommand(
    input: {
      id: string;
      version: number;
      answer: string;
      answeredBy: string;
      relayed: boolean;
      note?: string;
    },
    trustedT3 = false,
  ): Promise<EscalationExplicitOutcome> | null {
    let decision;
    try {
      decision = this.store.decision(input.id);
    } catch {
      return null;
    }
    if (decision.status !== "open") return null;
    const answerText = input.answer.trim();
    if (!answerText) return null;
    for (const taskId of decision.links.tasks) {
      const events = this.store.eventsAll(taskId) as LadderEvent[];
      const linked = events.filter(
        (event) =>
          event.kind === "planner_escalation_decision_linked" &&
          event.detail.includes(decision.id),
      );
      for (const link of linked) {
        const escalationId = link.detail.slice(0, link.detail.indexOf(":"));
        const escalation = plannerEscalations(events).find(
          (item) => item.id === escalationId && !item.answered,
        );
        if (!escalation) continue;
        const offerEvent = events.find(
          (event) =>
            event.kind === "planner_escalation_offered" &&
            event.detail.startsWith(`${escalationId}: `),
        );
        if (!offerEvent) continue;
        let offered: EscalationVerbChoice[];
        try {
          offered = JSON.parse(
            offerEvent.detail.slice(escalationId.length + 2),
          ) as EscalationVerbChoice[];
        } catch {
          continue;
        }
        const selected = decodeEscalationChoice(answerText, offered);
        if (selected.kind !== "owner" || !selected.choice.command) continue;
        if (isT3OperatorIdentity(input.answeredBy) && !trustedT3)
          throw Error(
            "T3 operator identity requires an authenticated T3 session",
          );
        const isOp =
          input.answeredBy === "operator" ||
          input.answeredBy === "operator (board)" ||
          isT3OperatorIdentity(input.answeredBy);
        if (input.relayed && isOp)
          throw Error(
            "A relayed answer names the relaying agent, not the operator",
          );
        if (!input.relayed && !isOp)
          throw Error(
            "Only the operator answers without a relay; set relayed true and name the relaying agent",
          );
        if (input.relayed && !input.note?.trim())
          throw Error(
            "A relayed answer requires a note quoting the operator's authorization",
          );
        if (decision.version !== input.version)
          throw Error(
            `Decision ${decision.id} is at version ${decision.version}, not ${input.version}`,
          );
        const answerer: Answerer = input.relayed
          ? { role: "planner", agentId: input.answeredBy }
          : { role: "operator" };
        const command = selected.choice.command;
        return this.settleExplicitEscalationCommand(
          this.store.task(taskId),
          escalationId,
          command,
          input.note?.trim() || selected.reason,
          input.answeredBy,
          answerer,
        ).then((outcome) => {
          if (outcome.status === "warnings") {
            const ids = outcome.warnings.map((w) => w.id).join(", ");
            const texts = outcome.warnings
              .map((w) => `${w.id}: ${w.text}`)
              .join("; ");
            throw Error(
              `Explicit command ${command.action} requires accepting warnings [${ids}] at version ${outcome.taskVersion}: ${texts}. ${outcome.next}`,
            );
          }
          if (outcome.status === "stale")
            throw Error(
              `Explicit command ${command.action} is stale; task is at version ${outcome.taskVersion}. ${outcome.next}`,
            );
          return outcome;
        });
      }
    }
    return null;
  }
  /** Share a live route settlement with a duplicate receipt observer instead of declaring it uncertain. */
  async awaitDelegatedEscalationSettlement(
    taskId: string,
    id: string,
    questionId: string,
  ): Promise<
    { status: "applied" } | { status: "refused"; reason: string } | null
  > {
    const settlement = this.escalationSettlements.get(`${taskId}:${id}`);
    if (!settlement) return null;
    const pending = this.store
      .eventsAll(taskId)
      .findLast(
        (event) =>
          event.kind === "planner_escalation_answer_pending" &&
          event.detail.startsWith(`${id}:`),
      );
    if (!pending) return null;
    try {
      const intent = JSON.parse(pending.detail.slice(id.length + 1).trim()) as {
        questionId?: string;
      };
      if (intent.questionId !== questionId) return null;
    } catch {
      return null;
    }
    const refusal = await settlement;
    return refusal
      ? { status: "refused", reason: refusal }
      : { status: "applied" };
  }
  /** A worker's own in-turn ask must yield before its owner direction can pass the idle fence. */
  private async deferForWorkerAsk(
    task: Task,
    id: string,
    questionId: string,
    who: string,
    answer: string,
    input: TaskControlInput,
  ): Promise<boolean> {
    if (
      !(
        (input.action === "move" && input.to === "work") ||
        (input.action === "restart" && input.role === "worker" && !input.fresh)
      )
    )
      return false;
    const waiting = this.resolution.agentAsks.inTurnAsks.get(task.id);
    if (
      !waiting ||
      !task.agentId ||
      !task.workspaceId ||
      waiting.agentId !== task.agentId ||
      (waiting.runId !== task.runId &&
        waiting.runId !== task.resolution.currentRunId)
    )
      return false;
    const observed = await this.resolution.onTaskHost(task, () =>
      this.resolution.host.observe(task.agentId!),
    );
    if (
      observed.id !== task.agentId ||
      observed.workspaceId !== task.workspaceId ||
      !(observed.active || observed.activeTurnId)
    )
      return false;
    this.store.transaction(() => {
      const current = this.store.task(task.id);
      if (
        current.version !== task.version ||
        this.resolution.agentAsks.inTurnAsks.get(task.id) !== waiting
      )
        throw Error(
          "Task or worker question changed during escalation answer; read next again",
        );
      if (current.resolution.deferredVerb)
        throw Error("Another owner direction is already deferred");
      const { version: _version, ...rest } = input;
      const marker = {
        askId: waiting.askId,
        runId: waiting.runId,
        agentId: task.agentId,
        workspaceId: task.workspaceId,
        escalationId: id,
        questionId,
        who,
        answer,
      };
      this.store.event(
        task.id,
        "planner_escalation_answer_pending",
        `${id}: ${JSON.stringify({ questionId, who, answer, control: input })}`,
      );
      this.store.update(
        task.id,
        {
          reason:
            "Owner direction recorded; waiting for the worker turn to release",
          resolution: {
            ...current.resolution,
            deferredVerb: {
              input: { ...rest, __workerAsk: marker },
              at: new Date().toISOString(),
              why: "held",
              target: null,
            },
          },
        },
        "owner_verb_deferred",
        JSON.stringify({
          action: input.action,
          role: "worker",
          why: "worker_ask",
          target: marker,
        }),
      );
      this.store.event(
        task.id,
        "agent_ask_yield",
        `${waiting.askId}: owner direction is waiting for the worker turn`,
      );
    });
    this.resolution.wakeDeferredDirection?.(task.id);
    return true;
  }
  private async settlePlannerEscalationOnce(
    t: Task,
    id: string,
    answer: string,
    who: string,
    offered: EscalationVerbChoice[],
    questionId: string,
    answerer: Answerer,
    version?: number,
  ): Promise<string | null> {
    const delegatedAnswer = answerer.role !== "operator";
    const latestTask = this.store.task(t.id);
    if (!escalationOutlived(latestTask))
      closeClearedEscalations(this.store, latestTask);
    if (
      plannerEscalations(this.store.eventsAll(t.id) as LadderEvent[]).find(
        (item) => item.id === id,
      )?.answered
    ) {
      if (delegatedAnswer)
        throw Error(`Escalation ${id} is already settled; read next again`);
      return null;
    }
    if (escalationOutlived(this.store.task(t.id))) {
      this.store.event(
        t.id,
        "planner_escalation_answer_pending",
        `${id}: ${JSON.stringify({ questionId, who, answer, control: null })}`,
      );
      this.store.event(
        t.id,
        "planner_escalation_answered",
        `${id}: answered by ${who}: ${answer.slice(0, 4000)}`,
      );
      this.store.event(
        t.id,
        "planner_escalation_applied",
        `${id}: nothing to apply; the task merged or ended first`,
      );
      return null;
    }
    const control = escalationAnswerControl(answer);
    const selected = decodeEscalationChoice(answer, offered);
    const reason = selected.reason;
    const current = this.store.task(t.id);
    const grant = delegatedAnswer
      ? {
          caller: answerer.agentId,
          delegated: true,
          note: `Delegated answer to escalation ${id} by ${who}: ${answer.slice(0, 1200)}`,
        }
      : {
          caller: current.agentId ?? undefined,
          relayed: true,
          note: `The operator answered escalation ${id}: ${answer}`.slice(
            0,
            4000,
          ),
        };
    try {
      if (version !== undefined && version !== current.version) {
        const staleMessage = `Task is now at version ${current.version}. Repeat with that version.`;
        this.store.event(
          current.id,
          "planner_escalation_refused",
          `${id}: ${staleMessage}`,
        );
        return staleMessage;
      }
      if (!this.resolution.applyOperatorControl)
        throw Error("No control applier is bound");
      const escalation = plannerEscalations(this.store.eventsAll(t.id)).find(
        (item) => item.id === id,
      );
      const namedSource = escalation?.runId
        ? this.store.run(escalation.runId)
        : null;
      const reviewerIncident = current.resolution.incident;
      const source =
        namedSource?.role === "reviewer"
          ? namedSource
          : (!namedSource || namedSource.role === "recovery") &&
              reviewerIncident?.role === "reviewer" &&
              reviewerIncident.status !== "resolved" &&
              reviewerIncident.runId
            ? this.store.run(reviewerIncident.runId)
            : null;
      const workerChoice =
        selected.kind === "owner" &&
        ((selected.choice.verb === "move" &&
          selected.choice.args.to === "work") ||
          ((selected.choice.verb === "restart" ||
            selected.choice.verb === "route") &&
            selected.choice.args.role === "worker"));
      if (
        source?.role === "reviewer" &&
        (workerChoice ||
          (selected.kind === "other" && control.action === "work"))
      ) {
        const deliverDirection = async (agentId = source.agentId) => {
          if (!agentId) throw Error("The reviewer direction has no recipient");
          const prior = this.store
            .eventsAll(t.id)
            .findLast(
              (event) =>
                [
                  "reviewer_escalation_direction_intent",
                  "reviewer_escalation_direction_sent",
                  "reviewer_escalation_direction_refused",
                ].includes(event.kind) && event.detail.startsWith(`${id}:`),
            );
          if (prior && prior.kind !== "reviewer_escalation_direction_refused")
            throw Error(
              "Reviewer direction delivery is already recorded or uncertain; inspect it before retrying",
            );
          this.store.event(
            t.id,
            "reviewer_escalation_direction_intent",
            `${id}: ${agentId}`,
          );
          try {
            await this.resolution.onTaskHost(current, () => {
              const adapter = this.resolution.adapter;
              const send = adapter.steerOrNotify ?? adapter.enqueueMessage;
              if (!send)
                throw new ProvenPreSendRefusalError(
                  "This host cannot steer or queue the reviewer direction",
                );
              return send.call(
                adapter,
                agentId,
                `ns-escalation-direction-${id}`,
                `Owner direction for your review: ${answer}`,
              );
            });
          } catch (error) {
            if (error instanceof ProvenPreSendRefusalError)
              this.store.event(
                t.id,
                "reviewer_escalation_direction_refused",
                `${id}: ${error.message}`,
              );
            throw error;
          }
          this.store.event(
            t.id,
            "reviewer_escalation_direction_sent",
            `${id}: ${agentId}`,
          );
        };
        if (source.released || source.completion) {
          // The move persists its reason as the next reviewer run's prompt;
          // bind the direction to that role, not to a historical agent ID.
          const reviewerInput = taskControlInputSchema.parse({
            taskId: current.id,
            version: current.version,
            action: "move",
            to: "review",
            reason: answer.slice(0, 4000),
            ...grant,
          });
          this.store.event(
            t.id,
            "planner_escalation_answer_pending",
            `${id}: ${JSON.stringify({ questionId, who, answer, control: reviewerInput })}`,
          );
          await this.resolution.applyOperatorControl(reviewerInput);
          const after = this.store.task(current.id);
          const active = after.resolution.currentRunId
            ? this.store.run(after.resolution.currentRunId)
            : null;
          const queued =
            after.resolution.pendingReviewReason === reviewerInput.reason ||
            after.resolution.deferredVerb?.input.reason ===
              reviewerInput.reason ||
            (active?.role === "reviewer" &&
              active.reviewReason === reviewerInput.reason);
          if (!queued) {
            if (
              !active ||
              active.role !== "reviewer" ||
              active.released ||
              active.completion
            )
              throw Error(
                "No current reviewer is bound to receive the direction",
              );
            await deliverDirection(active.agentId);
          }
          this.store.event(
            t.id,
            "planner_escalation_answered",
            `${id}: answered by ${who}: ${answer.slice(0, 4000)}`,
          );
          this.store.event(
            t.id,
            "planner_escalation_applied",
            `${id}: returned to the retained reviewer`,
          );
          return null;
        }
        if (!source.agentId || !source.workspaceId)
          throw Error(
            "The reviewer binding cannot be observed; read next and choose a reviewer continuation",
          );
        const observed = await this.resolution.onTaskHost(current, () =>
          this.resolution.host.observe(source.agentId!),
        );
        if (
          observed.id !== source.agentId ||
          observed.workspaceId !== source.workspaceId
        )
          throw Error(
            "The reviewer identity cannot be observed; no instruction was sent",
          );
        if (
          this.store.task(current.id).version !== current.version ||
          JSON.stringify(this.store.run(source.id)) !== JSON.stringify(source)
        )
          throw Error(
            "Task or reviewer changed during escalation answer; read next again",
          );
        if (observed.active || observed.activeTurnId || observed.permissions) {
          this.store.event(
            t.id,
            "planner_escalation_answer_pending",
            `${id}: ${JSON.stringify({ questionId, who, answer, control: null })}`,
          );
          await deliverDirection();
          this.store.event(
            t.id,
            "planner_escalation_answered",
            `${id}: answered by ${who}: ${answer.slice(0, 4000)}`,
          );
          this.store.event(
            t.id,
            "planner_escalation_applied",
            `${id}: direction delivered to the retained reviewer`,
          );
          return null;
        }
        const reviewerInput = taskControlInputSchema.parse({
          taskId: current.id,
          version: current.version,
          action: "restart",
          role: "reviewer",
          instruction: answer.slice(0, 12000),
          reason,
          ...grant,
        });
        this.store.event(
          t.id,
          "planner_escalation_answer_pending",
          `${id}: ${JSON.stringify({ questionId, who, answer, control: reviewerInput })}`,
        );
        await this.resolution.applyOperatorControl(reviewerInput);
        this.store.event(
          t.id,
          "planner_escalation_answered",
          `${id}: answered by ${who}: ${answer.slice(0, 4000)}`,
        );
        this.store.event(
          t.id,
          "planner_escalation_applied",
          `${id}: reviewer continuation requested`,
        );
        return null;
      }
      if (selected.kind === "owner") {
        const choice = selected.choice;
        if (choice.command) {
          const outcome = await this.settleExplicitEscalationCommand(
            current,
            id,
            choice.command,
            reason,
            who,
            answerer,
            version,
          );
          if (outcome.status === "applied") return null;
          if (outcome.status === "warnings")
            return (
              outcome.warnings.map((warning) => warning.text).join(" ") ||
              outcome.next
            );
          return outcome.next;
        }
        const controlInput = taskControlInputSchema.parse({
          ...choice.args,
          taskId: current.id,
          version: current.version,
          action: choice.verb,
          reason,
          ...grant,
        });
        if (
          await this.deferForWorkerAsk(
            current,
            id,
            questionId,
            who,
            answer,
            controlInput,
          )
        )
          return null;
        this.store.event(
          t.id,
          "planner_escalation_answer_pending",
          `${id}: ${JSON.stringify({ questionId, who, answer, label: choice.label, control: controlInput })}`,
        );
        await this.resolution.applyOperatorControl(controlInput);
        this.store.event(
          current.id,
          "planner_escalation_answered",
          `${id}: answered by ${who}: ${answer.slice(0, 4000)}`,
        );
        this.store.event(
          current.id,
          "planner_escalation_applied",
          `${id}: ${choice.label}`,
        );
        return null;
      }
      if (selected.kind === "task") {
        let prerequisite: Task | null = null;
        try {
          // The reason may carry a note after the reference; only the first
          // matching token is the target, and it must resolve or the answer
          // is refused (a later token in the note never substitutes for it).
          const candidates = extractTaskReferenceCandidates(reason);
          const target = candidates.length ? candidates[0]! : reason;
          prerequisite = this.resolution.messageRecipientTask(current, target);
        } catch (error) {
          throw Error(
            `Wait for a task (put its reference in Reason) could not read target "${reason}": ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const controlInput = taskControlInputSchema.parse({
          taskId: current.id,
          version: current.version,
          action: "set_prerequisite_wait",
          waitsFor: [prerequisite.id],
          reason: `Escalation ${id}: waiting for ${prerequisite.reference ?? prerequisite.id}`,
        });
        this.store.event(
          t.id,
          "planner_escalation_answer_pending",
          `${id}: ${JSON.stringify({ questionId, who, answer, control: controlInput })}`,
        );
        await this.resolution.applyOperatorControl(controlInput);
        const waiting = this.store.task(current.id);
        this.store.event(
          current.id,
          "planner_escalation_wait",
          `${id}: ${JSON.stringify({ kind: "task", target: prerequisite.id, waitId: waiting.prerequisiteWait?.id })}`,
        );
        this.resolution.waiting(
          waiting,
          `Escalation ${id}: waiting for task ${prerequisite.reference ?? prerequisite.id} to settle`,
          "prerequisite",
        );
        this.store.event(
          current.id,
          "planner_escalation_answered",
          `${id}: answered by ${who}: ${answer.slice(0, 4000)}`,
        );
        this.store.event(
          current.id,
          "planner_escalation_applied",
          `${id}: waiting for task ${prerequisite.reference ?? prerequisite.id}`,
        );
        return null;
      }
      if (selected.kind === "time") {
        // The reason may carry a note after the timestamp; the first ISO timestamp with a timezone is the target.
        const timestamp = extractFirstIsoTimestamp(reason) ?? reason.trim();
        const at = Date.parse(timestamp);
        if (
          !Number.isFinite(at) ||
          at <= Date.now() ||
          !/(?:Z|[+-]\d\d:?\d\d)$/i.test(timestamp)
        )
          throw Error(
            `Wait until a time (put an ISO timestamp in Reason) could not read target "${reason}": name a future ISO timestamp with a timezone`,
          );
        const target = new Date(at).toISOString();
        this.store.event(
          t.id,
          "planner_escalation_answer_pending",
          `${id}: ${JSON.stringify({ questionId, who, answer, control: { kind: "time", target } })}`,
        );
        if (
          !this.resolution.ladder.establishEscalationWait(current.id, id, {
            kind: "time",
            target,
          })
        )
          throw Error(
            "The time wait could not be established against the current task",
          );
        this.store.event(
          current.id,
          "planner_escalation_answered",
          `${id}: answered by ${who}: ${answer.slice(0, 4000)}`,
        );
        this.store.event(
          current.id,
          "planner_escalation_applied",
          `${id}: waiting until ${target}`,
        );
        return null;
      }
      if (selected.kind === "decision") {
        let decision: DecisionView | null = null;
        try {
          // The reason may carry a note after the ID; only the first matching
          // token is the target, and it must resolve or the answer is refused
          // (a later token in the note never substitutes for it).
          const candidates = extractDecisionIdCandidates(reason);
          const decisions = new Decisions(this.store);
          decision = decisions.get({
            id: candidates.length ? candidates[0]! : reason.trim(),
          });
          if (decision.status !== "open")
            throw Error("the decision is not open");
        } catch (error) {
          throw Error(
            `Wait for an operator decision (put its ID in Reason) could not read target "${reason}": ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        this.store.event(
          t.id,
          "planner_escalation_answer_pending",
          `${id}: ${JSON.stringify({ questionId, who, answer, control: { kind: "decision", target: decision.id } })}`,
        );
        if (
          !this.resolution.ladder.establishEscalationWait(current.id, id, {
            kind: "decision",
            target: decision.id,
          })
        )
          throw Error(
            "The operator decision wait could not be established against the current task",
          );
        this.store.event(
          current.id,
          "planner_escalation_answered",
          `${id}: answered by ${who}: ${answer.slice(0, 4000)}`,
        );
        this.store.event(
          current.id,
          "planner_escalation_applied",
          `${id}: waiting for operator decision ${decision.id}`,
        );
        return null;
      }
      if (control.action === "wait")
        throw Error("A wait must name a task, time or operator decision");
      const input =
        control.action === "stop"
          ? {
              taskId: current.id,
              version: current.version,
              action: "stop",
              reason: `Escalation ${id} settled by ${who}: ${answer}`.slice(
                0,
                4000,
              ),
              ...(delegatedAnswer ? { caller: grant.caller } : {}),
            }
          : {
              taskId: current.id,
              version: current.version,
              action: "move",
              to: "work",
              instruction: escalationContinuationInstruction(
                id,
                who,
                control.instruction,
              ).slice(0, 12000),
              reason,
              ...grant,
            };
      const controlInput = taskControlInputSchema.parse(input);
      if (
        await this.deferForWorkerAsk(
          current,
          id,
          questionId,
          who,
          answer,
          controlInput,
        )
      )
        return null;
      this.store.event(
        t.id,
        "planner_escalation_answer_pending",
        `${id}: ${JSON.stringify({ questionId, who, answer, control: controlInput })}`,
      );
      await this.resolution.applyOperatorControl(controlInput);
      this.store.event(
        current.id,
        "planner_escalation_answered",
        `${id}: answered by ${who}: ${answer.slice(0, 4000)}`,
      );
      this.store.event(
        current.id,
        "planner_escalation_applied",
        `${id}: ${control.action === "stop" ? "stop and keep the work" : "returned to the worker with the delegated direction"}`,
      );
      if (control.action === "work") {
        const after = this.store.task(current.id);
        if (
          !after.resolution.currentRunId &&
          after.phase === "changes_requested"
        )
          this.resolution.update(
            after,
            { pendingRevisionCause: "consult" as const },
            {},
            "planner_escalation_continuation_classified",
            id,
          );
      }
      return null;
    } catch (error) {
      if (error instanceof HostReadRefusalError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.store.event(
        current.id,
        "planner_escalation_refused",
        `${id}: ${message}`.slice(0, 4000),
      );
      this.resolution.waiting(
        this.store.task(current.id),
        `Escalation ${id} is unresolved: ${message}`,
        "escalated",
      );
      return message;
    }
  }
  async applyDelegatedEscalationAnswer(
    taskId: string,
    id: string,
    questionId: string,
    answer: string,
    who: string,
    version?: number,
  ): Promise<string | null> {
    const task = this.store.task(taskId);
    const events = this.store.eventsAll(taskId);
    const followup = questionId.startsWith(`ns-escalation-refusal-${id}`)
      ? events.findLast(
          (event) =>
            event.kind === "planner_escalation_followup_offered" &&
            event.detail.startsWith(`${id}: `) &&
            (
              JSON.parse(event.detail.slice(id.length + 2)) as {
                questionId?: string;
              }
            ).questionId === questionId,
        )
      : undefined;
    if (questionId.startsWith(`ns-escalation-refusal-${id}`) && !followup)
      throw Error(
        `Escalation ${id} has no recorded offer for this follow-up; read next again`,
      );
    const offer = followup
      ? null
      : events.find(
          (event) =>
            event.kind === "planner_escalation_offered" &&
            event.detail.startsWith(`${id}: `),
        );
    const offered = followup
      ? (
          JSON.parse(followup.detail.slice(id.length + 2)) as {
            ownerChoices: EscalationVerbChoice[];
          }
        ).ownerChoices
      : offer
        ? (JSON.parse(
            offer.detail.slice(id.length + 2),
          ) as EscalationVerbChoice[])
        : [];
    return this.settlePlannerEscalation(
      task,
      id,
      answer,
      who,
      offered,
      questionId,
      answererFromLabel(who),
      version,
    );
  }

  /** Reconcile a receipt whose action crossed a service roll before its answer marker. */
  reconcileDelegatedEscalationAnswer(
    taskId: string,
    id: string,
    questionId: string,
    receiptEventId: number,
  ): "applied" | "pending" | "unknown" | null {
    const events = this.store.eventsAll(taskId);
    const pending = events.findLast(
      (event) =>
        event.kind === "planner_escalation_answer_pending" &&
        event.detail.startsWith(`${id}:`) &&
        event.id > receiptEventId,
    );
    if (!pending) return null;
    let intent: {
      questionId?: string;
      who?: string;
      answer?: string;
      label?: string;
      control?:
        | TaskControlInput
        | { kind: "time" | "decision"; target: string }
        | null;
    } = {};
    try {
      intent = JSON.parse(pending.detail.slice(id.length + 1).trim());
    } catch {
      return "unknown";
    }
    if (intent.questionId !== questionId) return "unknown";
    const deferred = this.store.task(taskId).resolution.deferredVerb?.input
      .__workerAsk as
      | { escalationId?: string; questionId?: string }
      | undefined;
    if (deferred?.escalationId === id && deferred.questionId === questionId)
      return "pending";
    const control = intent.control;
    if (!control && escalationOutlived(this.store.task(taskId))) {
      this.store.event(
        taskId,
        "planner_escalation_answered",
        `${id}: answered by ${intent.who ?? "delegated planner"}: the task ended before the answer action`,
      );
      this.store.event(
        taskId,
        "planner_escalation_applied",
        `${id}: nothing to apply; the task merged or ended first`,
      );
      closeEscalationFollowups(this.store, taskId, id);
      return "applied";
    }
    if (control && !("action" in control)) {
      const waitControl = control as {
        kind: "time" | "decision";
        target: string;
      };
      const waitEvent = events.findLast(
        (event) =>
          event.kind === "planner_escalation_wait" &&
          event.detail.startsWith(`${id}:`) &&
          (() => {
            try {
              const wait = JSON.parse(event.detail.slice(id.length + 2)) as {
                kind?: string;
                target?: string;
              };
              return (
                wait.kind === waitControl.kind &&
                wait.target === waitControl.target
              );
            } catch {
              return false;
            }
          })(),
      );
      let recordedWait: {
        stopDetail?: string;
        stopReason?: "lifecycle" | "escalated";
      } = {};
      try {
        if (waitEvent)
          recordedWait = JSON.parse(
            waitEvent.detail.slice(id.length + 2),
          ) as typeof recordedWait;
      } catch {
        return "unknown";
      }
      const established = this.resolution.ladder.establishEscalationWait(
        taskId,
        id,
        { ...waitControl, ...recordedWait },
        pending.id,
      );
      if (!established) return "unknown";
      if (
        !events.some(
          (event) =>
            event.kind === "planner_escalation_answered" &&
            event.detail.startsWith(`${id}:`) &&
            event.id > pending.id,
        )
      )
        this.store.event(
          taskId,
          "planner_escalation_answered",
          `${id}: answered by ${intent.who ?? "delegated planner"}: recovered ${waitControl.kind} wait ${waitControl.target}`,
        );
      if (
        !events.some(
          (event) =>
            event.kind === "planner_escalation_applied" &&
            event.detail.startsWith(`${id}:`) &&
            event.id > pending.id,
        )
      )
        this.store.event(
          taskId,
          "planner_escalation_applied",
          `${id}: waiting for ${waitControl.kind} ${waitControl.target}`,
        );
      closeEscalationFollowups(this.store, taskId, id);
      return "applied";
    }
    if (!control || !("action" in control)) return "unknown";
    const expected = control;
    const recorded = events.find(
      (event) =>
        event.kind === "owner_control" &&
        event.id > pending.id &&
        (() => {
          try {
            const actual = JSON.parse(event.detail) as {
              verb?: string;
              caller?: string | null;
              reason?: string | null;
              identities?: Record<string, unknown>;
            };
            if (
              actual.verb !== expected.action ||
              actual.caller !== (expected.caller ?? null) ||
              actual.reason !== (expected.reason ?? null)
            )
              return false;
            const identities = actual.identities as
              | {
                  taskId?: string;
                  version?: number;
                  move?: { to?: string | null };
                  restart?: { role?: string | null; fresh?: boolean };
                  route?: {
                    role?: string | null;
                    profileId?: string | null;
                    now?: boolean;
                  };
                  effect?: string | null;
                }
              | undefined;
            if (
              identities?.taskId !== taskId ||
              identities.version !== expected.version
            )
              return false;
            if (expected.action === "move")
              return identities.move?.to === (expected.to ?? null);
            if (expected.action === "restart")
              return (
                identities.restart?.role === (expected.role ?? null) &&
                identities.restart?.fresh === (expected.fresh ?? false)
              );
            if (expected.action === "route")
              return (
                identities.route?.role === (expected.role ?? null) &&
                identities.route?.profileId === (expected.profileId ?? null) &&
                identities.route?.now === (expected.now ?? false)
              );
            if (expected.action === "retry_effect")
              return identities.effect === (expected.effect ?? null);
            return true;
          } catch {
            return false;
          }
        })(),
    );
    if (!recorded) return "unknown";
    if (
      !events.some(
        (event) =>
          event.kind === "planner_escalation_answered" &&
          event.detail.startsWith(`${id}:`) &&
          event.id > pending.id,
      )
    )
      this.store.event(
        taskId,
        "planner_escalation_answered",
        `${id}: answered by ${intent.who ?? "delegated planner"}: reconciled from owner_control event ${recorded.id}`,
      );
    if (
      !events.some(
        (event) =>
          event.kind === "planner_escalation_applied" &&
          event.detail.startsWith(`${id}:`) &&
          event.id > pending.id,
      )
    )
      this.store.event(
        taskId,
        "planner_escalation_applied",
        `${id}: ${intent.label ?? expected.action} (recovered from owner_control event ${recorded.id})`,
      );
    closeEscalationFollowups(this.store, taskId, id);
    return "applied";
  }
}
