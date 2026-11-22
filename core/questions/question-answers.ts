import {
  type DecisionView,
  type Task,
  type TaskControlInput,
} from "../../shared/contracts";
import { taskControlInputSchema } from "../../shared/contracts";
import type { Resolution } from "../resolution";
import { plannerEscalations, type LadderEvent } from "./ladder";
import {
  operatorQuestionFor,
  type OperatorQuestion,
  type OperatorQuestionChoice,
  type OperatorQuestionKind,
} from "./operator-question";
import {
  delegatedAuthorityNote,
  type DelegatedAnswer,
} from "./question-delegation";
import {
  decisionAnswerLinks,
  intentNamesQuestion,
  operatorQuestionRecord,
  operatorQuestionRecords,
  questionRecordKinds,
} from "./question-events";

/**
 * Owns what an answer does: the one recorded outcome, the ordinary control it
 * applies, and the reconciliation of a decision's answer against the question,
 * ask or escalation it answered. The records it reads are decoded by
 * `question-events.ts`; raising the question belongs to `question-raises.ts`.
 */
export class QuestionAnswers {
  constructor(readonly resolution: Resolution) {}
  get store() {
    return this.resolution.store;
  }
  async settleOperatorQuestion(
    taskId: string,
    question: OperatorQuestion,
    answer: string,
    recordAnswer = true,
  ): Promise<void> {
    if (this.resolution.stopped()) return;
    if (!this.resolution.queueBudgetQuestionCurrent(taskId, question)) {
      const delegated = this.resolution.delegatedAnswers.get(question.id);
      this.resolution.delegatedAnswers.delete(question.id);
      const answeredBy = this.resolution.queueAskRaiseAnsweredBy.get(
        question.id,
      );
      this.resolution.queueAskRaiseAnsweredBy.delete(question.id);
      this.store.event(
        taskId,
        "operator_question_stale_answered",
        `${question.id}: ${answer} — answered by ${delegated ? `delegated ${delegated.role} ${delegated.agentId}` : (answeredBy ?? "operator")}; no effect because the question was superseded`,
      );
      if (delegated)
        this.resolution.notifyStaleQuestionAnswer(
          taskId,
          question.id,
          `${delegated.role} ${delegated.agentId}`,
        );
      return;
    }
    // Spec 058 (task 550): the answer is recorded with who answered it — the operator, or the delegated agent.
    const delegated = this.resolution.delegatedAnswers.get(question.id) ?? null;
    this.resolution.delegatedAnswers.delete(question.id);
    const answeredBy = this.resolution.queueAskRaiseAnsweredBy.get(question.id);
    this.resolution.queueAskRaiseAnsweredBy.delete(question.id);
    // The one recorded answer is the question's outcome: a later native answer to
    // a question already settled by the planner ladder is recorded and applied
    // nowhere (papercut a1bc9fe5), never a second question or a second control.
    if (
      recordAnswer &&
      operatorQuestionRecord(
        this.store.eventsAll(taskId),
        question.id,
      )?.kinds.has("operator_question_answered")
    ) {
      this.store.event(
        taskId,
        "operator_question_late_answer",
        `${question.id}: ${answer} — answered by ${delegated ? `delegated ${delegated.role} ${delegated.agentId}` : (answeredBy ?? "operator")}; no effect because the question was already answered`,
      );
      return;
    }
    if (
      recordAnswer &&
      !operatorQuestionRecord(
        this.store.eventsAll(taskId),
        question.id,
      )?.kinds.has("operator_question_answered")
    )
      this.store.event(
        taskId,
        "operator_question_answered",
        `${question.id}: ${answer} — answered by ${delegated ? `delegated ${delegated.role} ${delegated.agentId}` : (answeredBy ?? "operator")}`,
      );
    const text = answer.trim();
    const choice =
      question.choices.find((item) => item.label === text) ??
      question.choices.find((item) => text.startsWith(item.label));
    // A free-text ruling is the answer: it is recorded for the task's own thread,
    // which asked the question, and Queue has no verb it may invent from it.
    if (!choice) return;
    // Spec 058 (task 540): only a delegated answer carries its recorded agent and note; anything else is the operator's.
    const delegation = delegated;
    if (choice.extendBudget) {
      const detail = `${question.id}: ${choice.label}${delegation ? `; ${delegatedAuthorityNote(question.id, delegation)}` : ""}`;
      this.resolution.extendTaskBudget(
        taskId,
        detail.slice(0, 4000),
        delegation ? `A delegated ${delegation.role}` : "The operator",
      );
    }
    if (!choice.control) return;
    if (!this.resolution.applyOperatorControl) {
      this.store.event(
        taskId,
        "operator_question_refused",
        `${question.id}: ${choice.label}: no control applier is bound`,
      );
      return;
    }
    try {
      await this.resolution.applyOperatorControl(
        this.resolution.operatorAnswerControl(
          this.store.task(taskId),
          question,
          choice,
          answer,
          delegation,
        ),
      );
      this.store.event(
        taskId,
        "operator_question_applied",
        `${question.id}: ${choice.label}`.slice(0, 4000),
      );
    } catch (error) {
      this.store.event(
        taskId,
        "operator_question_refused",
        `${question.id}: ${choice.label}: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          4000,
        ),
      );
    }
  }
  operatorAnswerControl(
    task: Task,
    question: OperatorQuestion,
    choice: OperatorQuestionChoice,
    answer: string,
    delegation: DelegatedAnswer | null = null,
  ): TaskControlInput {
    const control = choice.control!;
    const relayNote =
      `The operator answered Nucleus's native question ${question.id} on this task's thread: ${answer}`.slice(
        0,
        4000,
      );
    const answeredBy = delegation
      ? `A delegated ${delegation.role} (${delegation.agentId}) answered`
      : "The operator answered";
    const identity = {
      taskId: task.id,
      version: task.version,
      action: control.action,
      reason:
        `${answeredBy} Nucleus's question ${question.id}: ${choice.label}`.slice(
          0,
          4000,
        ),
    };
    // Spec 058 (task 540): a delegated answer is authorized by the answering agent and its
    // recorded note, never the board and never a relay. It is recorded as `delegated`.
    const grant = delegation
      ? {
          caller: delegation.agentId,
          delegated: true,
          note: delegatedAuthorityNote(question.id, delegation),
          ...(control.action === "owner" &&
          control.args.action === "extend_budget" &&
          delegation.budgetAuthority
            ? { budgetAuthority: delegation.budgetAuthority }
            : {}),
        }
      : { caller: task.agentId ?? undefined, relayed: true, note: relayNote };
    if (control.action === "owner")
      return taskControlInputSchema.parse({
        ...control.args,
        taskId: task.id,
        version: task.version,
        reason: identity.reason,
        ...grant,
      });
    if (control.action === "move" && control.to === "merge")
      return taskControlInputSchema.parse({
        ...identity,
        to: "merge",
        head: control.head,
        qualification:
          `${delegation ? `The delegated ${delegation.role} ${delegation.agentId}` : "The operator"} accepted the approved source head ${control.head} and deferred its named proofs in answer to Nucleus's question ${question.id}: ${answer}`.slice(
            0,
            4000,
          ),
        ...grant,
      });
    if (control.action === "move")
      return taskControlInputSchema.parse({
        ...identity,
        to: "work",
        instruction:
          `${control.instruction} ${delegation ? `The ${delegation.role} answered` : "The operator's answer:"} ${answer}`.slice(
            0,
            12000,
          ),
      });
    // Spec 058 (task 539): the merge fence keeps the proof list as its reason; the
    // operator owns it, so no relayed author is recorded.
    if (control.action === "hold")
      return taskControlInputSchema.parse({
        taskId: task.id,
        version: task.version,
        action: "hold",
        kind: "merge",
        reason: control.reason.slice(0, 4000),
      });
    // `stop` carries no authorization note: its reason names the answered question.
    if (control.action === "stop")
      return taskControlInputSchema.parse(identity);
    return taskControlInputSchema.parse({ ...identity, ...grant });
  }
  queueBudgetQuestionCurrent(
    taskId: string,
    decision: { id: string; kind: OperatorQuestionKind },
  ): boolean {
    const recorded = operatorQuestionRecord(
      this.store.eventsAll(taskId),
      decision.id,
    );
    if (recorded?.kinds.has("operator_question_superseded")) return false;
    if (decision.kind !== "budget") return true;
    const current = operatorQuestionFor(this.store, this.store.task(taskId));
    return current?.id === decision.id && current.kind === decision.kind;
  }
  operatorDecisionAnswered(view: DecisionView): void {
    if (view.status !== "answered" || !view.answer) return;
    for (const taskId of view.links.tasks) {
      for (const link of decisionAnswerLinks(
        this.store.eventsAll(taskId),
        view.id,
      )) {
        if (link.kind === "agent_ask_decision") {
          const askId = link.id;
          const kinds =
            questionRecordKinds(this.store.eventsAll(taskId)).get(askId) ??
            new Set<string>();
          if (kinds.has("agent_ask_superseded")) {
            if (!kinds.has("agent_ask_stale_answered"))
              this.store.event(
                taskId,
                "agent_ask_stale_answered",
                `${askId}: answered by ${view.answer.answeredBy}: ${view.answer.text}; no effect because the question was superseded`,
              );
          } else if (!kinds.has("agent_ask_answered")) {
            this.store.event(
              taskId,
              "agent_ask_answered",
              `${askId}: answered by ${view.answer.answeredBy}: ${view.answer.text}`,
            );
            this.resolution.notifyAskAnswered(
              taskId,
              askId,
              view.answer.text,
              view.answer.answeredBy,
            );
          }
        }
        // Spec 058 slice 17: the operator answered a ladder escalation the planner
        // classified as the operator's; the same settlement applies its verb.
        if (link.kind === "planner_escalation_decision_linked") {
          const escalationId = link.id;
          const open = plannerEscalations(
            this.store.eventsAll(taskId) as LadderEvent[],
          ).find((item) => item.id === escalationId);
          if (
            open &&
            !open.answered &&
            !this.resolution.settlingOperatorEscalations.has(escalationId)
          ) {
            this.resolution.settlingOperatorEscalations.add(escalationId);
            const run = view.answer.command
              ? this.resolution.escalationSettlement
                  .settleExplicitEscalationCommand(
                    this.store.task(taskId),
                    escalationId,
                    view.answer.command,
                    view.answer.text,
                    view.answer.answeredBy,
                    view.answer.relayed
                      ? { role: "planner", agentId: view.answer.answeredBy }
                      : { role: "operator" },
                    view.answer.command.version,
                  )
                  .catch(() => undefined)
              : this.resolution.settlePlannerEscalation(
                  this.store.task(taskId),
                  escalationId,
                  view.answer.text,
                  view.answer.answeredBy,
                );
            void run.finally(() =>
              this.resolution.settlingOperatorEscalations.delete(escalationId),
            );
          }
        }
        if (link.kind === "operator_question_decision") {
          const id = link.id;
          const events = this.store.eventsAll(taskId);
          const recorded = operatorQuestionRecords(events).get(id) ?? null;
          if (recorded?.kinds.has("operator_question_superseded")) {
            if (!recorded.kinds.has("operator_question_stale_answered"))
              this.store.event(
                taskId,
                "operator_question_stale_answered",
                `${id}: ${view.answer.text} — answered by ${view.answer.answeredBy}; no effect because the question was superseded`,
              );
          } else if (
            recorded?.kinds.has("operator_question") &&
            !recorded.kinds.has("operator_question_answered")
          ) {
            const task = this.store.task(taskId);
            const question = operatorQuestionFor(this.store, task);
            const exactIntent = Boolean(
              question &&
                question.id === id &&
                recorded.intent &&
                intentNamesQuestion(recorded.intent, question),
            );
            this.resolution.queueAskRaiseAnsweredBy.set(
              id,
              view.answer.answeredBy,
            );
            if (exactIntent && question)
              void this.resolution.settleOperatorQuestion(
                taskId,
                question,
                view.answer.text,
              );
            else {
              this.resolution.queueAskRaiseAnsweredBy.delete(id);
              this.store.event(
                taskId,
                "operator_question_answered",
                `${id}: ${view.answer.text} — answered by ${view.answer.answeredBy}`,
              );
            }
          } else
            this.resolution.resolveQueueRaise(
              id,
              view.answer.text,
              view.answer.answeredBy,
            );
        }
      }
    }
  }
}
