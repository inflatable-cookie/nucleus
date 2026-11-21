import type { Task } from "../../shared/contracts";
import type { Resolution } from "../resolution";
import { queueAskDeliveryId } from "./agent-ask";
import { supportsNativeQuestions } from "./native-decision";
import {
  isDelegableQuestionKind,
  type OperatorQuestionKind,
} from "./operator-question";
import {
  operatorQuestionRecords,
  questionRecordKinds,
} from "./question-events";
import { questionRoute } from "./question-route";

/** The decision shape a raise carries; the question kind and its labels are the producer's. */
export interface RaisedDecision {
  id: string;
  kind: OperatorQuestionKind;
  question: string;
  options: string[];
  details?: string | null;
  fullQuestion?: string | null;
}

/**
 * Owns where one raise goes: the native prompt, the MCP ask, the board decision or
 * the planner ladder. Each route records its intent before it sends and resolves the
 * one deferred the raise holds; the sweep that decides to raise belongs to
 * `question-raises.ts` and the answer to `question-answers.ts`.
 */
export class QuestionRaiseRoutes {
  constructor(readonly resolution: Resolution) {}
  get store() {
    return this.resolution.store;
  }
  get adapter() {
    return this.resolution.adapter;
  }
  raiseDecision(
    task: Task,
    decision: RaisedDecision,
    signal: AbortSignal,
    options: { boardOnly?: boolean; why?: string } = {},
  ): Promise<string> {
    if (!this.resolution.queueBudgetQuestionCurrent(task.id, decision))
      return Promise.reject(
        Error("Budget question no longer matches the current stop"),
      );
    const route = questionRoute(this.adapter, task.profile?.provider);
    if (options.boardOnly || route === "board") {
      const why = options.why ?? "the task host cannot take a native question";
      const delegable = isDelegableQuestionKind(decision.kind);
      if (route === "board" && !options.boardOnly) {
        const prefix = `${decision.id}: `;
        if (
          !this.store
            .eventsAll(task.id)
            .some(
              (event) =>
                event.kind === "operator_question_route_fallback" &&
                event.detail.startsWith(prefix),
            )
        ) {
          this.store.event(
            task.id,
            "operator_question_route_fallback",
            `${prefix}native in-thread decision unavailable on ${task.hostId ?? "unknown"}; routing via ${delegable ? "planner ladder then board" : "board"} (${why})`,
          );
        }
      }
      if (delegable)
        return this.raiseLadderDecision(task, decision, signal, why);
      return this.raiseBoardDecision(task, decision, signal, options.why);
    }
    // The native prompt carries the full text when the producer kept one; the
    // bounded surfaces (the board decision, the ask tool and its exact-text
    // join) carry the short canonical question. Delegation prefers the full
    // text the same way.
    const prompt = decision.fullQuestion ?? decision.question;
    // Spec 058 (task 550): a provider without a native question surface receives the
    // question through `nucleus_ask` instead of a prompt it cannot follow.
    if (route === "mcp_ask" || !supportsNativeQuestions(task.profile?.provider))
      return this.resolution.raiseAskDecision(task, decision, signal);
    return this.adapter.raiseTaskDecision!(task, {
      id: decision.id,
      question: prompt,
      options: decision.options,
      signal,
      onRequested: (request) => {
        // Durable native request identity for later withdrawal: a superseded
        // question is dismissed by its recorded requestId, not by matching text.
        // A repeated callback for the same request writes the identity once.
        try {
          const recorded = operatorQuestionRecords(
            this.store.eventsAll(task.id),
          ).get(decision.id);
          if (
            !recorded?.nativeRequests.some(
              (item) => item.requestId === request.requestId,
            )
          )
            this.store.event(
              task.id,
              "operator_question_native_request",
              `${decision.id}: request ${request.requestId} header ${request.header} on ${task.agentId ?? "unknown"}`,
            );
        } catch {
          /* the send intent stands without the request link */
        }
        void this.resolution.delegateDecision(
          task.id,
          decision,
          request,
          signal,
          (fresh, answer) =>
            this.adapter.answerTaskDecision!(fresh, {
              requestId: request.requestId,
              header: request.header,
              answer,
            }),
        );
      },
    });
  }
  raiseBoardDecision(
    task: Task,
    decision: RaisedDecision,
    signal: AbortSignal,
    why = "the task host cannot take a native question",
  ): Promise<string> {
    let resolve!: (answer: string) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.resolution.queueAskRaises.set(decision.id, { resolve, reject });
    signal.addEventListener(
      "abort",
      () => {
        const raise = this.resolution.queueAskRaises.get(decision.id);
        if (raise) {
          this.resolution.queueAskRaises.delete(decision.id);
          this.resolution.queueAskRaiseAnsweredBy.delete(decision.id);
          raise.reject(
            Error(
              "Nucleus board question observation cancelled; delivery or answer may be unknown",
            ),
          );
        }
      },
      { once: true },
    );
    this.resolution.ensureQueueRaiseDecision(task, decision, why);
    void this.notifyPlannerOfBoardQuestion(task, decision);
    return promise;
  }
  /** A host without native questions asks the planner ladder before opening a board decision. */
  private raiseLadderDecision(
    task: Task,
    decision: RaisedDecision,
    signal: AbortSignal,
    why: string,
  ): Promise<string> {
    let resolve!: (answer: string) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.resolution.queueAskRaises.set(decision.id, { resolve, reject });
    signal.addEventListener(
      "abort",
      () => {
        const raise = this.resolution.queueAskRaises.get(decision.id);
        if (raise) {
          this.resolution.queueAskRaises.delete(decision.id);
          this.resolution.queueAskRaiseAnsweredBy.delete(decision.id);
          raise.reject(
            Error(
              "Nucleus planner question observation cancelled; delivery or answer may be unknown",
            ),
          );
        }
      },
      { once: true },
    );
    void this.resolution
      .delegateDecision(
        task.id,
        decision,
        null,
        signal,
        async (_fresh, answer) => {
          this.resolution.resolveQueueRaise(decision.id, answer);
        },
      )
      .then((delivered) => {
        if (
          delivered ||
          signal.aborted ||
          !this.resolution.queueAskRaises.has(decision.id)
        )
          return;
        const recorded = operatorQuestionRecords(
          this.store.eventsAll(task.id),
        ).get(decision.id);
        // Unknown delivery must stay unknown; only an observed exhausted ladder
        // can turn this into a board decision.
        if (recorded?.delegationUnknown) return;
        const existingLink = recorded?.link;
        const reason =
          existingLink?.why ||
          `${why}; the planner ladder ran out without an answer`;
        this.resolution.ensureQueueRaiseDecision(task, decision, reason);
        this.notifyPlannerOfBoardQuestion(task, decision, reason);
      })
      .catch((error) => {
        if (this.resolution.stopped() || signal.aborted) return;
        this.store.event(
          task.id,
          "operator_question_delegation_unknown",
          `${decision.id}: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            4000,
          ),
        );
      });
    return promise;
  }
  /** One notice to the planner that a board question waits for the operator. */
  notifyPlannerOfBoardQuestion(
    task: Task,
    decision: RaisedDecision,
    why = "the task host cannot take a native question",
  ): void {
    const noticed = () => {
      try {
        return (
          operatorQuestionRecords(this.store.eventsAll(task.id))
            .get(decision.id)
            ?.kinds.has("operator_question_planner_notice") ?? false
        );
      } catch {
        return true;
      }
    };
    if (noticed()) return;
    void (async () => {
      if (noticed()) return;
      // Task 1109: a task's own planner hears about its board question first; the
      // project planner is the fallback rung.
      const own = await this.resolution.taskPlannerFor(task);
      const planner =
        own?.agentId ?? (await this.resolution.projectPlannerFor(task)).planner;
      if (!planner || noticed()) return;
      const host = await this.resolution.identifyOriginHost(planner);
      if (!host || noticed()) return;
      await this.resolution.withHost(host, async () => {
        if (
          noticed() ||
          !this.resolution.originHostAvailable(host) ||
          !this.adapter.notify
        )
          return;
        const choices = decision.options.length
          ? ` Choices: ${decision.options.join(" | ")}.`
          : "";
        const reference = this.store.task(task.id).reference ?? task.title;
        await this.resolution.host.sendMessage(planner, {
          messageId: `ns-queue-question-${decision.id}`,
          text: `Nucleus raised a question on ${reference} (kind ${decision.kind}) because ${why}. It is on the board for the operator; answer it there. Question: ${decision.question}${choices}`,
        });
        if (!noticed())
          this.store.event(
            task.id,
            "operator_question_planner_notice",
            `${decision.id}: planner ${planner}`,
          );
      });
    })().catch((error) => {
      try {
        this.store.event(
          task.id,
          "operator_question_planner_missed",
          `${decision.id}: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            4000,
          ),
        );
      } catch {
        /* store closed after shutdown */
      }
    });
  }
  raiseAskDecision(
    task: Task,
    decision: RaisedDecision,
    signal: AbortSignal,
  ): Promise<string> {
    let resolve!: (answer: string) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.resolution.queueAskRaises.set(decision.id, { resolve, reject });
    signal.addEventListener(
      "abort",
      () => {
        const raise = this.resolution.queueAskRaises.get(decision.id);
        if (raise) {
          this.resolution.queueAskRaises.delete(decision.id);
          this.resolution.queueAskRaiseAnsweredBy.delete(decision.id);
          raise.reject(
            Error(
              "Nucleus ask observation cancelled; delivery or answer may be unknown",
            ),
          );
        }
      },
      { once: true },
    );
    void this.resolution.deliverQueueAsk(task, decision).catch(() => {
      /* the store or adapter failed after shutdown began; the recorded intent stands */
    });
    void this.resolution
      .delegateDecision(task.id, decision, null, signal, (_fresh, answer) => {
        this.resolution.resolveQueueRaise(decision.id, answer);
        return Promise.resolve();
      })
      .then((delivered) => {
        if (
          !delivered &&
          !signal.aborted &&
          this.resolution.queueAskRaises.has(decision.id)
        )
          this.resolution.ensureQueueRaiseDecision(
            task,
            decision,
            "no delegated answer was produced in time",
          );
      })
      .catch(() => {
        /* misses and unknowns are recorded on the events by delegateDecision itself */
      });
    return promise;
  }
  async deliverQueueAsk(
    task: Task,
    decision: RaisedDecision,
    scoped = false,
  ): Promise<void> {
    if (!scoped) {
      if (!task.hostId) return;
      return this.resolution.withHost(task.hostId, () =>
        this.deliverQueueAsk(task, decision, true),
      );
    }
    if (!this.resolution.hostAvailable(task)) return;
    if (questionRoute(this.adapter, task.profile?.provider) === "board") return;
    if (!this.resolution.queueBudgetQuestionCurrent(task.id, decision)) return;
    const deliveryId = queueAskDeliveryId(
      task.id,
      decision.question,
      decision.options,
    );
    if (
      questionRecordKinds(this.store.eventsAll(task.id))
        .get(deliveryId)
        ?.has("queue_ask_delivery")
    )
      return;
    this.store.event(
      task.id,
      "queue_ask_delivery",
      `${deliveryId}: queue question ${decision.id}`,
    );
    if (!task.agentId || !this.adapter.notify) return;
    const choices = decision.options.length
      ? ` Choices: ${decision.options.join(" | ")}.`
      : "";
    const text = `Nucleus asked you one question (kind ${decision.kind}) and is collecting its answer. Call the question MCP tool named in your session's launch instructions once with exactly this question text${decision.options.length ? " and exactly these choices" : ""}, wait for the answer in the same turn, then continue. Question: ${decision.question}${choices} Do not answer it yourself, and do not raise it as a native question.`;
    try {
      await this.adapter.notify(
        task.agentId,
        `ns-queue-ask-${decision.id}`,
        text,
        task.agentId,
      );
    } catch (error) {
      this.store.event(
        task.id,
        "queue_ask_prompt_missed",
        `${decision.id}: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          4000,
        ),
      );
    }
  }
  resolveQueueRaise(
    questionId: string,
    answer: string,
    answeredBy?: string,
  ): void {
    if (answeredBy)
      this.resolution.queueAskRaiseAnsweredBy.set(questionId, answeredBy);
    const raise = this.resolution.queueAskRaises.get(questionId);
    if (!raise) {
      this.resolution.queueAskRaiseAnsweredBy.delete(questionId);
      return;
    }
    this.resolution.queueAskRaises.delete(questionId);
    raise.resolve(answer);
  }
}
