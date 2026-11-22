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
import { escalationOutlived } from "../recovery/task-reasons";
import { Decisions } from "../planning/decisions";
import type { Resolution } from "../resolution";
import {
  decodeEscalationChoice,
  escalationAnswerControl,
  escalationContinuationInstruction,
  extractDecisionIdCandidates,
  extractFirstIsoTimestamp,
  extractTaskReferenceCandidates,
  plannerEscalations,
  type EscalationVerbChoice,
  type LadderEvent,
} from "./ladder";
import {
  closeClearedEscalations,
  closeEscalationFollowups,
} from "./ladder/continuation";
import { HostReadRefusalError, ProvenPreSendRefusalError } from "../host/errors";

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
    const {
      version: commandVersion,
      accept,
      ...commandArgs
    } = command;
    const explicitInput = explicitResolutionSchema.parse({
      ...commandArgs,
      taskId: fresh.id,
      version: commandVersion ?? version ?? fresh.version,
      reason: reason.slice(0, 4000),
      accept: accept ?? [],
      caller,
    });
    try {
      const resolved =
        await this.resolution.applyExplicitResolution(explicitInput);
      const outcome = resolved.explicitResolution;
      if (!outcome)
        throw Error("Explicit resolution did not return a resolution outcome");
      if (outcome.status === "applied") {
        this.store.event(
          fresh.id,
          "planner_escalation_answered",
          `${id}: answered by ${who}: ${command.action} — ${reason}`.slice(
            0,
            4000,
          ),
        );
        this.store.event(
          fresh.id,
          "planner_escalation_applied",
          `${id}: ${command.action}`,
        );
        closeEscalationFollowups(this.store, fresh.id, id);
      }
      return { ...outcome, taskVersion: resolved.version };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.event(
        fresh.id,
        "planner_escalation_refused",
        `${id}: ${message}`.slice(0, 4000),
      );
      throw error;
    }
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
      if (version !== undefined && version !== current.version)
        throw Error(
          `Task is now at version ${current.version}. Repeat with that version.`,
        );
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
