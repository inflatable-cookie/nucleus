import { Decisions } from "../planning/decisions";
import type { Resolution } from "../resolution";
import { busyGoAnswerRefusal } from "../qa/proof-only-go";
import { operatorQuestionFor } from "./operator-question";
import {
  delegatedDecisionRouteRecords,
  operatorQuestionRecords,
  queueAskPayloads,
  type OperatorQuestionRecord,
} from "./question-events";
import { questionRoute } from "./question-route";

/**
 * Owns the question service's recovery sweep: resuming a recorded answer, a board
 * decision and a delegated route after a restart, and cancelling the observations
 * this process holds. Its facts come from `question-events.ts`; the settle and
 * raise paths it resumes belong to `question-answers.ts` and `question-raises.ts`.
 */
export class QuestionRecovery {
  constructor(readonly resolution: Resolution) {}
  get store() {
    return this.resolution.store;
  }
  get adapter() {
    return this.resolution.adapter;
  }
  async resumeBusyProofGoAnswers(): Promise<void> {
    for (const candidate of this.store.maintenanceTasks(true)) {
      if (this.resolution.paused()) return;
      const task = this.store.task(candidate.id);
      if (
        task.entrypoint !== "proof" ||
        task.removedAt ||
        !["blocked", "error", "needs_attention"].includes(task.phase)
      )
        continue;
      if (this.store.runs(task.id).some((run) => !run.released)) continue;
      const events = this.store.eventsAll(task.id);
      const intent = [...operatorQuestionRecords(events).values()].find(
        (record) => record.intent?.kind === "release",
      );
      const id = intent?.id;
      if (!id || !intent?.kinds.has("operator_question_answered")) continue;
      if (intent.kinds.has("operator_question_applied")) continue;
      if (!intent.refusal || !busyGoAnswerRefusal(intent.refusal)) continue;
      const decisionId = intent.link?.decisionId ?? null;
      if (!decisionId) continue;
      const decision = new Decisions(this.store).get({ id: decisionId });
      if (decision.status !== "answered" || !decision.answer) continue;
      const question = operatorQuestionFor(this.store, task);
      if (!question || question.id !== id) continue;
      this.resolution.queueAskRaiseAnsweredBy.set(
        id,
        decision.answer.answeredBy,
      );
      try {
        if (task.hostId && this.resolution.hostAvailable(task))
          await this.resolution.withHost(task.hostId, () =>
            this.resolution.settleOperatorQuestion(
              task.id,
              question,
              decision.answer!.text,
              false,
            ),
          );
      } finally {
        this.resolution.queueAskRaiseAnsweredBy.delete(id);
      }
    }
  }
  async resumeAskQuestions(scopedTaskId?: string): Promise<void> {
    if (this.resolution.paused()) return;
    if (!scopedTaskId) {
      for (const task of this.store.maintenanceTasks(true))
        if (task.hostId && this.resolution.hostAvailable(task))
          await this.resolution.withHost(task.hostId, () =>
            this.resumeAskQuestions(task.id),
          );
      this.resolution.agentAsks.resumePendingAskAnswers();
      return;
    }
    for (const candidate of [this.store.task(scopedTaskId)]) {
      const task = this.store.task(candidate.id);
      await this.resolution.ladder.resumeEscalationWaits(task);
      this.resolution.agentAsks.resumeAgentAsks(task);
      let events = this.store.eventsAll(task.id);
      this.resolution.ladder.resumeDelegations(task);
      for (const view of new Decisions(this.store).list({
        task: task.id,
        status: "answered",
      })) {
        if (!view.answer) continue;
        const activeRaises = new Set(this.resolution.queueAskRaises.keys());
        this.resolution.operatorDecisionAnswered(view);
        // operatorDecisionAnswered records a linked operator question's answer
        // itself, synchronously. Re-read events so the guards below observe that
        // answer and never record the same question answered twice.
        events = this.store.eventsAll(task.id);
        for (const record of operatorQuestionRecords(events).values()) {
          if (!record.link || record.link.decisionId !== view.id) continue;
          const id = record.id;
          if (
            activeRaises.has(id) ||
            this.resolution.recoveringQueueAsks.has(id)
          )
            continue;
          const marked = (kind: string) => record.kinds.has(kind);
          this.resolution.recoveringQueueAsks.add(id);
          try {
            this.resolution.queueAskRaiseAnsweredBy.set(
              id,
              view.answer.answeredBy,
            );
            if (
              marked("operator_question") &&
              !marked("operator_question_answered")
            ) {
              const question = operatorQuestionFor(
                this.store,
                this.store.task(task.id),
              );
              if (question?.id === id)
                await this.resolution.settleOperatorQuestion(
                  task.id,
                  question,
                  view.answer.text,
                );
              else {
                // The original stop is gone or changed. Record the ruling to close
                // its gate, but never apply its controls to a different state.
                this.store.event(
                  task.id,
                  "operator_question_answered",
                  `${id}: ${view.answer.text} — answered by ${view.answer.answeredBy}`,
                );
              }
            } else if (
              marked("responsible_question") &&
              !marked("responsible_question_answered") &&
              !marked("responsible_question_superseded")
            ) {
              this.resolution.settleJointQuestion(
                task.id,
                id,
                view.answer.text,
              );
            }
          } finally {
            this.resolution.queueAskRaiseAnsweredBy.delete(id);
            this.resolution.recoveringQueueAsks.delete(id);
          }
        }
      }
      for (const entry of delegatedDecisionRouteRecords(events)) {
        // A route recorded before an unreadable one has already started above;
        // the unreadable record names itself instead of hiding its predecessors.
        if (!entry.route)
          throw Error(
            `Delegated decision route ${entry.eventId} is not readable JSON`,
          );
        const { decision, request } = entry.route;
        const recorded = operatorQuestionRecords(events).get(decision.id);
        if (
          this.resolution.queueAskRaises.has(decision.id) ||
          this.resolution.responsibleQuestions.has(decision.id) ||
          this.resolution.recoveringQueueAsks.has(decision.id) ||
          this.finishedRoute(recorded) ||
          recorded?.noAnswerMissed ||
          (recorded?.delegationUnknown &&
            !this.resolution.recoverableDelegation(
              [
                `queue-delegate-${decision.id}`,
                `queue-delegate-${decision.id}-project`,
                `ns-decider-${decision.id}`,
              ],
              false,
            )) ||
          (!recorded?.kinds.has("operator_question_delegation_wait") &&
            !this.resolution.recoverableDelegation([
              `queue-delegate-${decision.id}`,
              `queue-delegate-${decision.id}-project`,
              `ns-decider-${decision.id}`,
            ]))
        )
          continue;
        if (request && recorded?.kinds.has("operator_question_decided"))
          continue;
        this.resolution.recoveringQueueAsks.add(decision.id);
        void this.resolution
          .delegateDecision(
            task.id,
            decision,
            request,
            new AbortController().signal,
            async (fresh, answer) => {
              if (request)
                await this.adapter.answerTaskDecision!(fresh, {
                  ...request,
                  answer,
                });
              const question = operatorQuestionFor(this.store, fresh);
              if (question?.id === decision.id)
                await this.resolution.settleOperatorQuestion(
                  task.id,
                  question,
                  answer,
                );
              else if (
                operatorQuestionRecords(this.store.eventsAll(task.id))
                  .get(decision.id)
                  ?.kinds.has("responsible_question")
              )
                this.resolution.settleJointQuestion(
                  task.id,
                  decision.id,
                  answer,
                );
            },
          )
          .catch((error) => {
            if (!this.resolution.stopped())
              this.store.event(
                task.id,
                "operator_question_delegation_unknown",
                `${decision.id}: ${error instanceof Error ? error.message : String(error)}`,
              );
          })
          .finally(() =>
            this.resolution.recoveringQueueAsks.delete(decision.id),
          );
      }
      // A Queue-originated delegate send may have landed before shutdown. Its
      // established recovery path keeps the linked board question available.
      const board =
        questionRoute(this.adapter, task.profile?.provider) === "board";
      for (const question of queueAskPayloads(events)) {
        const record = operatorQuestionRecords(events).get(question.id);
        const marked = (kind: string) => record?.kinds.has(kind) ?? false;
        if (board) {
          if (
            !this.resolution.queueAskRaises.has(question.id) &&
            !this.resolution.recoveringQueueAsks.has(question.id) &&
            !record?.kinds.has("operator_question_decision") &&
            !marked("operator_question_answered") &&
            !marked("responsible_question_answered")
          )
            this.resolution.ensureQueueRaiseDecision(
              task,
              question,
              "the task host cannot take a native question",
            );
          void this.resolution.questionRaiseRoutes.notifyPlannerOfBoardQuestion(
            task,
            question,
          );
          continue;
        }
        if (
          this.resolution.queueAskRaises.has(question.id) &&
          !marked("operator_question_answered") &&
          !marked("responsible_question_answered")
        )
          await this.resolution.deliverQueueAsk(
            this.store.task(task.id),
            question,
          );
        if (
          !this.resolution.queueAskRaises.has(question.id) &&
          !this.resolution.recoveringQueueAsks.has(question.id) &&
          !record?.kinds.has("operator_question_decision") &&
          !marked("operator_question_answered") &&
          !marked("responsible_question_answered")
        )
          this.resolution.ensureQueueRaiseDecision(
            task,
            question,
            "the previous delivery or answer could not be observed",
          );
      }
      if (board) {
        for (const view of new Decisions(this.store).list({
          task: task.id,
          status: "open",
        })) {
          const record = [...operatorQuestionRecords(events).values()].find(
            (item) => item.link?.decisionId === view.id,
          );
          if (!record) continue;
          const id = record.id;
          if (
            [
              "operator_question_answered",
              "responsible_question_answered",
              "operator_question_superseded",
            ].some((kind) => record.kinds.has(kind))
          )
            continue;
          const current = operatorQuestionFor(
            this.store,
            this.store.task(task.id),
          );
          if (current?.id === id) {
            const reason = record.link?.why || undefined;
            void this.resolution.questionRaiseRoutes.notifyPlannerOfBoardQuestion(
              task,
              {
                id: current.id,
                kind: current.kind,
                question: current.question,
                options: current.choices.map((choice) => choice.label),
              },
              reason,
            );
          }
        }
      }
    }
    // Task 562: pending asks collect their joined answers and every recorded
    // answer resumes its asking agent, even when the in-turn wait already left.
  }
  /** A route is settled when any of its answer marks is recorded. */
  private finishedRoute(recorded: OperatorQuestionRecord | undefined): boolean {
    return (
      recorded?.kinds.has("operator_question_answered") === true ||
      recorded?.kinds.has("responsible_question_answered") === true ||
      recorded?.kinds.has("operator_question_stale_answered") === true ||
      recorded?.kinds.has("responsible_question_stale_answered") === true
    );
  }
  abortResponsibleQuestions() {
    for (const controller of this.resolution.responsibleQuestions.values())
      controller.abort();
    this.resolution.responsibleQuestions.clear();
    for (const [questionId, raise] of this.resolution.queueAskRaises) {
      this.resolution.queueAskRaises.delete(questionId);
      this.resolution.queueAskRaiseAnsweredBy.delete(questionId);
      raise.reject(
        Error(
          "Nucleus ask observation cancelled; delivery or answer may be unknown",
        ),
      );
    }
  }
}
