import { delegateQuestion, plannerWindows } from "./planner-delegation";
import { taskControlInputSchema } from "../../shared/contracts";
import { Decisions } from "../planning/decisions";
import {
  applyBinaryApproval,
  parseNativeDelegatedReply,
} from "./question-delegation";
import type { Resolution } from "../resolution";
import { DelegatedHostUnavailable } from "./delegation";
import { retainedProgressRun } from "../dispatch/retained-work";
import { digest } from "../store/store";
import { qualifyLegacyAgentId } from "../../shared/agent-identity";
import type { AnsweredQuestionRead } from "../../shared/host";
import {
  HostReadRefusalError,
  ProvenPreSendRefusalError,
} from "../host/errors";
import { operatorQuestionRecords } from "./question-events";
import { HOST_KIND_LABELS, hostKindOf } from "../../shared/host-kind";

/**
 * Where one native question stands, read from its own latest outcome event. `open`
 * has no outcome; `operator` waits for the operator's decision; `refused` was proven
 * not sent and may be delivered again from its recorded answer; `intent` may have
 * reached the host and is never resent; `settled` is final.
 */
export type NativeQuestionState =
  | "open"
  | "operator"
  | "refused"
  | "intent"
  | "settled";

const NATIVE_QUESTION_SETTLED = new Set([
  "native_question_answered",
  "native_question_stale_answered",
  "native_question_unknown",
  "native_question_unanswered",
]);

export function nativeQuestionState(
  events: ReadonlyArray<{ kind: string; detail: string }>,
  id: string,
): NativeQuestionState {
  let state: NativeQuestionState = "open";
  for (const event of events) {
    if (!event.detail.startsWith(`${id}:`)) continue;
    if (event.kind === "native_question_response_intent") state = "intent";
    else if (event.kind === "native_question_refused") state = "refused";
    else if (event.kind === "native_question_operator") state = "operator";
    else if (NATIVE_QUESTION_SETTLED.has(event.kind)) state = "settled";
  }
  return state;
}

/** The planner overtakes one answer carries; a recovered answer keeps them. */
export interface NativeOvertake {
  ids: string[];
  label: string;
}

/**
 * The answers and overtakes a native question's durable response intent recorded
 * before its send. A recovered delivery sends these exact answers and asks nobody.
 */
export function recordedNativeAnswer(
  events: ReadonlyArray<{ kind: string; detail: string }>,
  id: string,
): { answers: Record<string, string>; overtakes: NativeOvertake[] } | null {
  const event = [...events]
    .reverse()
    .find(
      (row) =>
        row.kind === "native_question_response_intent" &&
        row.detail.startsWith(`${id}:`),
    );
  const match = event
    ? /; answers (\{.*\})(?:; overtakes (\[.*\]))?$/s.exec(event.detail)
    : null;
  if (!match) return null;
  try {
    const answers = JSON.parse(match[1]!) as unknown;
    const overtakes = match[2]
      ? (JSON.parse(match[2]) as NativeOvertake[])
      : [];
    if (
      !answers ||
      typeof answers !== "object" ||
      Object.values(answers).some((value) => typeof value !== "string")
    )
      return null;
    return { answers: answers as Record<string, string>, overtakes };
  } catch {
    return null;
  }
}

/** The one Nucleus decision a native question's escalated question raises on the task. */
export const operatorDecisionIdFor = (id: string, index: number): string =>
  `native-question-${id}-${index}`;

/** What an answered native question on a blocked worker or reviewer thread does. */
export type AnsweredQuestionOutcome =
  | { kind: "skip" }
  | { kind: "unknown_agent_changed"; from: string; to: string }
  | { kind: "refuse_no_applier" }
  | { kind: "resume_worker" }
  | { kind: "resume_reviewer" };

/**
 * Worker checks agent identity before blocked evidence; reviewer checks blocked
 * evidence first. A skip writes nothing; the other arms record a durable outcome.
 */
export function answeredQuestionOutcome(facts: {
  seen: boolean;
  phaseOk: boolean;
  unreleasedRun: boolean;
  watchKind: "worker" | "reviewer";
  stillBlocked: boolean;
  watchAgentId: string;
  currentAgentId: string | null;
  hasApplier: boolean;
}): AnsweredQuestionOutcome {
  if (facts.seen || !facts.phaseOk || facts.unreleasedRun)
    return { kind: "skip" };
  if (facts.watchKind === "worker") {
    if (facts.currentAgentId !== facts.watchAgentId)
      return {
        kind: "unknown_agent_changed",
        from: facts.watchAgentId,
        to: facts.currentAgentId ?? "none",
      };
    if (!facts.stillBlocked) return { kind: "skip" };
  } else {
    if (!facts.stillBlocked) return { kind: "skip" };
    if (facts.currentAgentId !== facts.watchAgentId)
      return {
        kind: "unknown_agent_changed",
        from: facts.watchAgentId,
        to: facts.currentAgentId ?? "none",
      };
  }
  if (!facts.hasApplier) return { kind: "refuse_no_applier" };
  return {
    kind: facts.watchKind === "worker" ? "resume_worker" : "resume_reviewer",
  };
}

export class NativeQuestions {
  constructor(readonly resolution: Resolution) {}
  get store() {
    return this.resolution.store;
  }
  get adapter() {
    return this.resolution.adapter;
  }
  async delegateNativeQuestions(scopedHost?: string): Promise<void> {
    if (!scopedHost) {
      const hosts = new Set(
        this.store
          .maintenanceTasks(true)
          .flatMap((task) => (task.hostId ? [task.hostId] : [])),
      );
      for (const host of hosts)
        await this.resolution.withHost(host, () =>
          this.delegateNativeQuestions(host),
        );
      return;
    }
    if (!this.resolution.originHostAvailable(scopedHost)) return;
    if (
      this.resolution.paused() ||
      !this.adapter.pendingQuestions ||
      !this.adapter.answerNativeQuestion
    )
      return;
    for (const candidate of this.store.maintenanceTasks(true)) {
      const task = this.store.task(candidate.id);
      if (task.hostId !== scopedHost) continue;
      if (task.removedAt || ["done", "cancelled"].includes(task.phase))
        continue;
      const reviewer = task.resolution.reviewerAgentId;
      const reviewerRun = reviewer
        ? this.store
            .runs(task.id)
            .filter(
              (run) =>
                run.role === "reviewer" &&
                run.agentId === reviewer &&
                run.hostId === scopedHost,
            )
            .at(-1)
        : null;
      const watches = [
        { agentId: task.agentId, workspaceId: task.workspaceId },
        { agentId: reviewer, workspaceId: reviewerRun?.workspaceId },
      ];
      for (const watch of watches) {
        if (!watch.agentId || !watch.workspaceId) continue;
        let pending: Awaited<
          ReturnType<NonNullable<typeof this.adapter.pendingQuestions>>
        >;
        try {
          pending = await this.adapter.pendingQuestions(watch.agentId);
        } catch {
          continue;
        }
        // An operator card or a refused answer settles once its permission leaves the thread.
        this.settleAbandonedQuestions(
          task.id,
          watch.agentId,
          new Set(pending.map((request) => request.requestId)),
        );
        for (const request of pending) {
          // Queue's own marked questions already have their own delegation and durable intent.
          if (
            request.questions.some((q) =>
              q.question.startsWith("[Queue decision "),
            )
          )
            continue;
          const events = this.store.eventsAll(task.id);
          const legacyId = digest(
            `native-question:${watch.agentId}:${request.requestId}`,
          );
          // Old event and delivery IDs are durable fences; continue the same
          // occurrence if this task already recorded it, never mint a new send.
          const hasLegacy = events.some(
            (event) =>
              event.kind.startsWith("native_question_") &&
              event.detail.startsWith(`${legacyId}:`),
          );
          const id = hasLegacy
            ? legacyId
            : digest(
                JSON.stringify([
                  "native-question-v2",
                  qualifyLegacyAgentId(watch.agentId, scopedHost),
                  request.requestId,
                ]),
              );
          if (this.resolution.responsibleQuestions.has(id)) continue;
          // An intent that may have reached the host, or a settled question, is never
          // asked or sent again. A refused intent is sent again from its own record, and
          // an operator escalation resumes only once its decision is answered.
          const state = nativeQuestionState(events, id);
          if (state === "settled" || state === "intent") continue;
          if (
            state === "operator" &&
            !this.operatorEscalationAnswered(task.id, id)
          )
            continue;
          if (
            state === "open" &&
            events.some(
              (event) =>
                event.kind === "native_question_delegated" &&
                event.detail.startsWith(`${id}:`),
            ) &&
            this.resolution.delegatedDelivery(`queue-native-${id}-0`) &&
            !this.resolution.recoverableDelegation([
              `queue-native-${id}-0`,
              `queue-native-${id}-0-project`,
              `ns-decider-${id}-0`,
            ])
          )
            continue;
          if (
            !events.some(
              (event) =>
                event.kind === "native_question_delegated" &&
                event.detail.startsWith(`${id}:`),
            )
          )
            this.store.event(
              task.id,
              "native_question_delegated",
              `${id}: ${watch.agentId}; permission ${request.requestId}`,
            );
          const controller = new AbortController();
          this.resolution.responsibleQuestions.set(id, controller);
          void this.resolution
            .answerNativeQuestions(
              task.id,
              watch.agentId,
              watch.workspaceId,
              id,
              request,
              controller.signal,
            )
            .catch((error) => {
              if (
                !(error instanceof DelegatedHostUnavailable) &&
                !this.resolution.stopped()
              )
                this.store.event(
                  task.id,
                  "native_question_unknown",
                  `${id}: ${error instanceof Error ? error.message : String(error)}`.slice(
                    0,
                    4000,
                  ),
                );
            })
            .finally(() => this.resolution.responsibleQuestions.delete(id));
        }
      }
    }
  }
  async answerNativeQuestions(
    taskId: string,
    agentId: string,
    workspaceId: string,
    id: string,
    request: {
      requestId: string;
      questions: Array<{ header: string; question: string; options: string[] }>;
    },
    signal: AbortSignal,
  ): Promise<void> {
    const task = this.store.task(taskId);
    if (
      !task.hostId ||
      !this.resolution.withHost(task.hostId, () =>
        this.resolution.originHostAvailable(task.hostId),
      )
    )
      throw new DelegatedHostUnavailable(
        "Native question host is unavailable or unknown",
      );
    return this.resolution.withHost(task.hostId, () =>
      this.answerNativeQuestionsOnHost(
        taskId,
        agentId,
        workspaceId,
        id,
        request,
        signal,
      ),
    );
  }
  private async answerNativeQuestionsOnHost(
    taskId: string,
    agentId: string,
    workspaceId: string,
    id: string,
    request: {
      requestId: string;
      questions: Array<{ header: string; question: string; options: string[] }>;
    },
    signal: AbortSignal,
  ): Promise<void> {
    const task = this.store.task(taskId);
    // A refused answer already holds its recorded answers: deliver those, and ask nobody.
    const recorded = nativeQuestionState(this.store.eventsAll(taskId), id);
    if (recorded === "refused") {
      const intent = recordedNativeAnswer(this.store.eventsAll(taskId), id);
      if (!intent) return;
      await this.sendNativeAnswer({
        taskId,
        hostId: task.hostId,
        agentId,
        workspaceId,
        id,
        requestId: request.requestId,
        answers: intent.answers,
        plannerOvertakes: intent.overtakes,
        records: [
          `Recovered the recorded answer after a refused delivery: ${JSON.stringify(intent.answers)}`,
        ],
        recordIntent: false,
      });
      return;
    }
    // Task 1109: the task's own planner is asked first; the project planner is the fallback rung.
    const { rungs, issue } = await this.resolution.plannerRungsFor(task);
    const answers: Record<string, string> = {};
    const records: string[] = [];
    const plannerOvertakes: NativeOvertake[] = [];
    for (const [index, question] of request.questions.entries()) {
      const planners = plannerWindows(
        this.resolution,
        `queue-native-${id}-${index}`,
        rungs,
      );
      // An operator's answer to this question is the answer; no planner is asked again.
      const decided = this.operatorAnswerFor(taskId, id, index);
      if (decided !== null) {
        Object.defineProperty(answers, question.header, {
          value: decided,
          enumerable: true,
          configurable: true,
        });
        records.push(`Answered by operator: ${decided}`);
        continue;
      }
      if (issue) {
        const detail = `${id}: ${issue}`;
        if (
          !this.store
            .eventsAll(taskId)
            .some(
              (event) =>
                event.kind === "native_question_delegate_wait" &&
                event.detail === detail,
            )
        )
          this.store.event(taskId, "native_question_delegate_wait", detail);
        if (
          !planners.length &&
          !this.resolution.delegatedDelivery(`ns-decider-${id}-${index}`)
        )
          return;
      }
      const input = {
        question: question.question,
        choices: question.options,
        context: this.resolution.decisionContext(task),
      };
      let unknown = false;
      const result = await delegateQuestion(this.resolution, task, {
        planners,
        decisionId: `${id}-${index}`,
        context: input,
        signal,
        parse: parseNativeDelegatedReply,
        onIntent: (role, recipient, rung) =>
          this.store.event(
            taskId,
            "native_question_delegate_intent",
            `${id}: ${role}${role === "planner" ? ` (${rung ?? "project"} rung)` : ""} ${recipient ?? "requested"}; question ${index}`,
          ),
        onSkip: (rung, recipient, detail) =>
          this.store.event(
            taskId,
            "native_question_delegate_skipped",
            `${id}: ${rung} planner ${recipient} skipped: ${detail}`.slice(
              0,
              4000,
            ),
          ),
        onMiss: () => {},
        onUnknown: (role, recipient, error) => {
          unknown = true;
          this.store.event(
            taskId,
            "native_question_unknown",
            `${id}: ${role} ${recipient ?? ""}: ${error instanceof Error ? error.message : String(error)}`.slice(
              0,
              4000,
            ),
          );
        },
      });
      if (unknown) return;
      const reply = result?.reply;
      const role = result?.role;
      if (signal.aborted) return;
      if (!reply) {
        this.store.event(
          taskId,
          "native_question_unanswered",
          `${id}: no usable delegate answer`,
        );
        return;
      }
      if (reply.kind === "operator") {
        this.store.event(
          taskId,
          "native_question_operator",
          `${id}: agent ${agentId}; permission ${request.requestId}; Operator decision needed — ${reply.reason}`.slice(
            0,
            4000,
          ),
        );
        // One decision on the task raises the question on its parent card; its answer
        // applies to this same permission, once, through the resumed answer above.
        this.resolution.ensureQueueRaiseDecision(
          this.store.task(taskId),
          {
            id: operatorDecisionIdFor(id, index),
            kind: "process",
            question: question.question,
            options: question.options,
          },
          `The ${HOST_KIND_LABELS[hostKindOf(task.hostId)]} native question needs the operator: ${reply.reason}`.slice(
            0,
            1000,
          ),
        );
        return;
      }
      const approved = applyBinaryApproval(
        question.question,
        question.options,
        reply.answer,
        reply.reason,
      );
      Object.defineProperty(answers, question.header, {
        value: approved?.choice ?? reply.answer,
        enumerable: true,
        configurable: true,
      });
      records.push(
        `Answered by ${role}: ${approved?.choice ?? reply.answer} — ${approved ? approved.reason : reply.reason}`,
      );
      if (role === "planner" && reply.overtakes?.length)
        plannerOvertakes.push({
          ids: reply.overtakes,
          label: `Planner answer to ${question.header}: ${reply.answer}`.slice(
            0,
            240,
          ),
        });
    }
    await this.sendNativeAnswer({
      taskId,
      hostId: task.hostId,
      agentId,
      workspaceId,
      id,
      requestId: request.requestId,
      answers,
      plannerOvertakes,
      records,
      recordIntent: true,
    });
  }

  /** The operator's answer to one escalated question, or null while it is unanswered. */
  private operatorAnswerFor(
    taskId: string,
    id: string,
    index: number,
  ): string | null {
    return this.operatorDecisions(taskId, id).get(index)?.answer ?? null;
  }

  /** Whether every operator escalation of one native question has its answer. */
  private operatorEscalationAnswered(taskId: string, id: string): boolean {
    const decisions = [...this.operatorDecisions(taskId, id).values()];
    return (
      decisions.length > 0 && decisions.every((row) => row.answer !== null)
    );
  }

  /** The decisions one native question raised on its task, keyed by question index. */
  private operatorDecisions(
    taskId: string,
    id: string,
  ): Map<
    number,
    { viewId: string; version: number; answer: string | null }
  > {
    const events = this.store.eventsAll(taskId);
    const prefix = `native-question-${id}-`;
    const decisions = new Map<
      number,
      { viewId: string; version: number; answer: string | null }
    >();
    for (const [decisionId, record] of operatorQuestionRecords(events)) {
      if (!decisionId.startsWith(prefix) || !record.link) continue;
      const index = Number(decisionId.slice(prefix.length));
      if (!Number.isInteger(index)) continue;
      let view;
      try {
        view = new Decisions(this.store).get({ id: record.link.decisionId });
      } catch {
        continue;
      }
      decisions.set(index, {
        viewId: view.id,
        version: view.version,
        answer:
          view.status === "answered" && view.answer ? view.answer.text : null,
      });
    }
    return decisions;
  }

  /**
   * A native question whose permission left the thread settles without a send. An operator
   * card is withdrawn, so the parent card clears; a refused answer is closed as stale. Either
   * way the escalation or refusal ends with no second answer.
   */
  private settleAbandonedQuestions(
    taskId: string,
    agentId: string,
    pendingIds: Set<string>,
  ): void {
    for (const event of this.store.eventsAll(taskId)) {
      if (
        event.kind !== "native_question_operator" &&
        event.kind !== "native_question_refused"
      )
        continue;
      const match = /^([^:]+): agent (\S+); permission (\S+); /.exec(
        event.detail,
      );
      if (!match || match[2] !== agentId) continue;
      const id = match[1]!;
      const requestId = match[3]!;
      const state = nativeQuestionState(this.store.eventsAll(taskId), id);
      if (pendingIds.has(requestId) || state !== (event.kind === "native_question_operator" ? "operator" : "refused"))
        continue;
      if (event.kind === "native_question_operator")
        this.withdrawOperatorCards(taskId, id);
      this.store.event(
        taskId,
        "native_question_stale_answered",
        `${id}: permission ${requestId}; ${event.kind === "native_question_operator" ? "operator decision withdrawn" : "refused answer not sent"}; no effect because the permission was already answered on the thread`.slice(
          0,
          4000,
        ),
      );
    }
  }

  /** Withdraw every open operator card one native question raised. */
  private withdrawOperatorCards(taskId: string, id: string): void {
    for (const row of this.operatorDecisions(taskId, id).values()) {
      if (row.answer !== null) continue;
      try {
        new Decisions(this.store).withdraw({
          id: row.viewId,
          version: row.version,
          reason: "The permission was answered on the thread",
          withdrawnBy: "nucleus",
        });
      } catch {
        /* the decision already moved on; its own record stands */
      }
    }
  }

  /**
   * The one pre-send path for a native answer, shared by a new answer and a recovered one.
   * A new answer records its intent first. A recovered answer reuses the intent it recorded
   * (proven refused, so never sent): nothing is re-asked and no second intent is written.
   */
  private async sendNativeAnswer(input: {
    taskId: string;
    hostId: string | null | undefined;
    agentId: string;
    workspaceId: string;
    id: string;
    requestId: string;
    answers: Record<string, string>;
    plannerOvertakes: NativeOvertake[];
    records: string[];
    recordIntent: boolean;
  }): Promise<void> {
    const {
      taskId,
      agentId,
      workspaceId,
      id,
      requestId,
      answers,
      plannerOvertakes,
      records,
    } = input;
    const current = this.store.task(taskId);
    if (
      current.removedAt ||
      ["done", "cancelled"].includes(current.phase) ||
      current.hostId !== input.hostId ||
      !current.hostId ||
      (current.agentId !== agentId &&
        current.resolution.reviewerAgentId !== agentId)
    )
      return;
    if (
      !this.resolution.withHost(current.hostId, () =>
        this.resolution.originHostAvailable(current.hostId),
      )
    )
      throw new DelegatedHostUnavailable("Native question host is offline");
    // A permission that has left the thread was answered there: that answer wins.
    // A proved incomplete host read preserves the recorded answer without sending
    // or declaring an unknown outcome; any other read failure defaults safe.
    let stillPending = true;
    if (this.adapter.pendingQuestions) {
      try {
        stillPending = (await this.adapter.pendingQuestions(agentId)).some(
          (item) => item.requestId === requestId,
        );
      } catch (error) {
        if (error instanceof HostReadRefusalError)
          throw new DelegatedHostUnavailable(error.message);
        stillPending = true;
      }
    }
    if (!stillPending) {
      this.store.event(
        taskId,
        "native_question_stale_answered",
        `${id}: ${records.join("; ")}; no effect because the permission was already answered on the thread`.slice(
          0,
          4000,
        ),
      );
      return;
    }
    if (
      !this.resolution.withHost(current.hostId, () =>
        this.resolution.originHostAvailable(current.hostId),
      )
    )
      throw new DelegatedHostUnavailable("Native question host is offline");
    if (input.recordIntent)
      this.store.event(
        taskId,
        "native_question_response_intent",
        `${id}: agent ${agentId}; permission ${requestId}; answers ${JSON.stringify(answers)}${
          plannerOvertakes.length
            ? `; overtakes ${JSON.stringify(plannerOvertakes)}`
            : ""
        }`,
      );
    try {
      await this.adapter.answerNativeQuestion!(
        agentId,
        workspaceId,
        requestId,
        answers,
      );
    } catch (error) {
      // Only a proven pre-send refusal or transient incomplete read is
      // recoverable: nothing was written, so the recorded answer stays preserved
      // without marking the intent `unknown`.
      if (error instanceof HostReadRefusalError) {
        this.recordRefusedAnswer(taskId, id, agentId, requestId, error.message);
        throw new DelegatedHostUnavailable(error.message);
      }
      if (!(error instanceof ProvenPreSendRefusalError)) throw error;
      this.recordRefusedAnswer(taskId, id, agentId, requestId, error.message);
      return;
    }
    if (plannerOvertakes.length)
      this.store.transaction(() => {
        const decisions = new Decisions(this.store);
        const reference = {
          kind: "planner_answer" as const,
          id: taskId,
          sourceId: id,
          label: plannerOvertakes
            .map((item) => item.label)
            .join("; ")
            .slice(0, 240),
          at: new Date().toISOString(),
        };
        for (const decisionId of [
          ...new Set(plannerOvertakes.flatMap((item) => item.ids)),
        ].slice(0, 100)) {
          try {
            decisions.markOvertaken(decisionId, reference);
            this.store.event(
              taskId,
              "native_question_overtakes",
              `${id}: ${decisionId}`,
            );
          } catch (error) {
            this.store.event(
              taskId,
              "native_question_overtakes_refused",
              `${id}: ${decisionId}: ${error instanceof Error ? error.message : String(error)}`.slice(
                0,
                1000,
              ),
            );
          }
        }
      });
    for (const record of records)
      this.store.event(
        taskId,
        "native_question_answered",
        `${id}: ${record}`.slice(0, 4000),
      );
  }

  /** A proven refusal is recorded once per distinct reason; the next pass delivers the recorded answer. */
  private recordRefusedAnswer(
    taskId: string,
    id: string,
    agentId: string,
    requestId: string,
    reason: string,
  ): void {
    const detail =
      `${id}: agent ${agentId}; permission ${requestId}; ${reason}; no answer was sent; the recorded answer is delivered again`.slice(
        0,
        4000,
      );
    const last = [...this.store.eventsAll(taskId)]
      .reverse()
      .find(
        (event) =>
          event.kind === "native_question_refused" &&
          event.detail.startsWith(`${id}:`),
      );
    if (last?.detail === detail) return;
    this.store.event(taskId, "native_question_refused", detail);
  }
  async resumeResponsibleAnsweredQuestions(scopedHost?: string): Promise<void> {
    if (this.resolution.paused()) return;
    if (!scopedHost) {
      await this.resolution.resumeBusyProofGoAnswers();
      const hosts = new Set(
        this.store
          .maintenanceTasks(true)
          .flatMap((task) => (task.hostId ? [task.hostId] : [])),
      );
      for (const host of hosts)
        await this.resolution.withHost(host, () =>
          this.resumeResponsibleAnsweredQuestions(host),
        );
      return;
    }
    if (!this.resolution.originHostAvailable(scopedHost)) return;
    if (!this.adapter.answeredQuestions) return;
    for (const candidate of this.store.maintenanceTasks(true)) {
      if (this.resolution.paused()) return;
      const task = this.store.task(candidate.id);
      if (task.hostId !== scopedHost) continue;
      if (!task.agentId || task.removedAt) continue;
      if (!["blocked", "error", "needs_attention"].includes(task.phase))
        continue;
      const runs = this.store.runs(task.id);
      if (runs.some((run) => !run.released)) continue;
      const workerBlocked =
        retainedProgressRun(this.store, task) ??
        (task.completion &&
        ["blocked", "error"].includes(task.completion.status) &&
        task.completion.runId === task.runId
          ? task.completion
          : null);
      const reviewerBlockedRun =
        runs
          .filter(
            (run) =>
              run.role === "reviewer" &&
              run.completion &&
              ["blocked", "error"].includes(run.completion.status),
          )
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
          .at(-1) ?? null;
      if (!workerBlocked && !reviewerBlockedRun) continue;
      const watches: Array<{ kind: "worker" | "reviewer"; agentId: string }> =
        [];
      if (workerBlocked && task.agentId)
        watches.push({ kind: "worker", agentId: task.agentId });
      if (reviewerBlockedRun) {
        const reviewerAgent =
          reviewerBlockedRun.agentId ?? task.resolution.reviewerAgentId ?? null;
        if (reviewerAgent)
          watches.push({ kind: "reviewer", agentId: reviewerAgent });
      }
      for (const watch of watches) {
        // A host read that refuses, or throws, is an unknown observation: it is
        // recorded as unknown once and never read as "the operator answered
        // nothing", which would silently keep the task blocked.
        const read = await this.adapter.answeredQuestions!(watch.agentId).catch(
          (error): AnsweredQuestionRead => ({
            ok: false,
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
        if (!read.ok) {
          const unknownKind = `${watch.kind}_question_read_unknown`;
          const detail = `${watch.agentId}: ${read.reason}`.slice(0, 4000);
          const events = this.store.eventsAll(task.id);
          if (
            !events.some(
              (event) => event.kind === unknownKind && event.detail === detail,
            )
          )
            this.store.event(task.id, unknownKind, detail);
          continue;
        }
        for (const item of read.answered) {
          if (!item.requestId.trim() || !Object.keys(item.answers).length)
            continue;
          const answeredKind = `${watch.kind}_question_answered`;
          const resumedKind = `${watch.kind}_question_resumed`;
          const unknownKind = `${watch.kind}_question_unknown`;
          const refusedKind = `${watch.kind}_question_refused`;
          const events = this.store.eventsAll(task.id);
          const seen = (kind: string) =>
            events.some(
              (event) =>
                event.kind === kind &&
                event.detail.startsWith(`${item.requestId}:`),
            );
          if (
            seen(answeredKind) ||
            seen(resumedKind) ||
            seen(unknownKind) ||
            seen(refusedKind)
          )
            continue;
          // Re-read fresh state before consuming the question. A version change
          // between enumeration and now is not a refusal: the control below is
          // built from the fresh version, so the still-blocked task continues.
          // Transient conditions (phase moved on, an unreleased run appeared,
          // the blocked evidence cleared) skip without recording, so a later
          // sweep retries; once the answered event is written every exit path
          // records a durable outcome (resumed, refused or unknown).
          const current = this.store.task(task.id);
          const freshRuns = this.store.runs(current.id);
          const freshWorkerBlocked =
            retainedProgressRun(this.store, current) ??
            (current.completion &&
            ["blocked", "error"].includes(current.completion.status) &&
            current.completion.runId === current.runId
              ? current.completion
              : null);
          const freshReviewerBlocked =
            freshRuns
              .filter(
                (run) =>
                  run.role === "reviewer" &&
                  run.completion &&
                  ["blocked", "error"].includes(run.completion.status),
              )
              .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
              .at(-1) ?? null;
          const answerText = Object.entries(item.answers)
            .map(([key, value]) => `${key}: ${value}`)
            .join("; ");
          const apply = this.resolution.applyOperatorControl;
          const outcome = answeredQuestionOutcome({
            seen: false,
            phaseOk: ["blocked", "error", "needs_attention"].includes(
              current.phase,
            ),
            unreleasedRun: freshRuns.some((run) => !run.released),
            watchKind: watch.kind,
            stillBlocked:
              watch.kind === "worker"
                ? Boolean(freshWorkerBlocked)
                : Boolean(freshReviewerBlocked),
            watchAgentId: watch.agentId,
            currentAgentId:
              watch.kind === "worker"
                ? (current.agentId ?? null)
                : (freshReviewerBlocked?.agentId ??
                  current.resolution.reviewerAgentId ??
                  null),
            hasApplier: Boolean(apply),
          });
          if (outcome.kind === "skip") continue;
          this.store.event(
            task.id,
            answeredKind,
            `${item.requestId}: ${item.question} :: ${answerText}`.slice(
              0,
              4000,
            ),
          );
          if (outcome.kind === "unknown_agent_changed") {
            this.store.event(
              task.id,
              unknownKind,
              `${item.requestId}: ${watch.kind} agent changed from ${outcome.from} to ${outcome.to}; the answer was not applied to the new ${watch.kind}`.slice(
                0,
                4000,
              ),
            );
            continue;
          }
          if (outcome.kind === "refuse_no_applier" || !apply) {
            this.store.event(
              task.id,
              refusedKind,
              `${item.requestId}: no control applier is bound`,
            );
            continue;
          }
          try {
            if (outcome.kind === "resume_worker") {
              const instruction =
                `The operator answered your native question "${item.question}" on this thread: ${answerText}. Continue the work in the same run with these answers.`.slice(
                  0,
                  12000,
                );
              await apply(
                taskControlInputSchema.parse({
                  taskId: current.id,
                  version: current.version,
                  action: "move",
                  to: "work",
                  instruction,
                  reason:
                    `The operator answered the worker's native question ${item.requestId}; the task resumes with those answers`.slice(
                      0,
                      4000,
                    ),
                  caller: current.agentId ?? undefined,
                  relayed: true,
                  note: `The operator answered the worker's native question ${item.requestId} on this task's thread: ${answerText}`.slice(
                    0,
                    4000,
                  ),
                }),
              );
            } else {
              const instruction =
                `The operator answered your native question "${item.question}" on this thread: ${answerText}. Continue the retained review with these answers.`.slice(
                  0,
                  12000,
                );
              await apply(
                taskControlInputSchema.parse({
                  taskId: current.id,
                  version: current.version,
                  action: "restart",
                  role: "reviewer",
                  instruction,
                  reason:
                    `The operator answered the reviewer's native question ${item.requestId}; the retained review continues with those answers`.slice(
                      0,
                      4000,
                    ),
                  caller: current.agentId ?? undefined,
                  relayed: true,
                  note: `The operator answered the reviewer's native question ${item.requestId} on this task's thread: ${answerText}`.slice(
                    0,
                    4000,
                  ),
                }),
              );
            }
            this.store.event(
              task.id,
              resumedKind,
              `${item.requestId}: resumed ${watch.kind} with answers`.slice(
                0,
                4000,
              ),
            );
          } catch (error) {
            this.store.event(
              task.id,
              unknownKind,
              `${item.requestId}: ${error instanceof Error ? error.message : String(error)}`.slice(
                0,
                4000,
              ),
            );
          }
        }
      }
    }
  }
}
