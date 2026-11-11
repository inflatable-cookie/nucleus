import { formatAgentId, nativeAgentId } from "../../shared/agent-identity";
import { Store, digest as storeDigest } from "../store/store";
import type { Engine } from "../engine";
import type { Decisions } from '../planning/decisions';
import { reconcileRoutingGrants } from "../dispatch/routing-grants";

/** Narrow dependencies; construction and lifecycle remain runtime-owned. */
export interface QuestionsContext {
  store: Store;
  engine: Pick<Engine, "withHost" | "taskHostAvailable" | "adapter" | "wake"> & {
    resolution: Pick<Engine["resolution"], "answerDelegatedQuestionFromHost" | "delegatedQuestionForTask" | "operatorDecisionAnswered">;
  };
  decisions: Decisions;
  markStoreAccess(): void;
}

export class RuntimeQuestions {
  constructor(private readonly context: QuestionsContext) {}

  /** Resolve only the worker or retained reviewer currently named on this task. */
  private nativeQuestionWorkspace(taskId: string, agentId: string): string {
    const task = this.context.store.task(taskId);
    if (task.removedAt) throw Error("Task is removed");
    const candidates = [
      ...(task.agentId === agentId && task.workspaceId ? [task.workspaceId] : []),
      ...this.context.store.runs(taskId).filter(run => !run.released && run.role === "reviewer" && run.agentId === agentId && run.workspaceId).map(run => run.workspaceId!),
    ];
    const distinct = [...new Set(candidates)];
    if (distinct.length !== 1) throw Error("Question thread is no longer uniquely owned by this task");
    return distinct[0];
  }

  private nativeQuestionAgent(taskId: string, input: { agentId?: string; agentRef?: string }): string {
    const host = this.context.store.task(taskId).hostId;
    if (!host) throw Error('Question is waiting for a proven task host');
    if (Boolean(input.agentId) === Boolean(input.agentRef)) throw Error('Provide one agent identity');
    return input.agentRef ? nativeAgentId(input.agentRef, host) : input.agentId!;
  }

  async listNativeQuestions(input: { taskId: string; agentId?: string; agentRef?: string }) {
    const agent = this.nativeQuestionAgent(input.taskId, input);
    this.nativeQuestionWorkspace(input.taskId, agent);
    const task = this.context.store.task(input.taskId);
    if (!task.hostId) throw Error('Question is waiting for a proven task host');
    return this.context.engine.withHost(task.hostId, () => {
      if (!this.context.engine.taskHostAvailable(task)) throw Error(`Waiting for host ${task.hostId}`);
      const adapter = this.context.engine.adapter;
      if (!adapter.pendingQuestions) throw Error("This host cannot read native questions");
      return adapter.pendingQuestions(agent);
    });
  }

  async answerNativeQuestion(input: { taskId: string; agentId?: string; agentRef?: string; requestId: string; answers: Record<string, string> }) {
    const agent = this.nativeQuestionAgent(input.taskId, input);
    const workspace = this.nativeQuestionWorkspace(input.taskId, agent);
    const task = this.context.store.task(input.taskId);
    if (!task.hostId) throw Error('Question is waiting for a proven task host');
    return this.context.engine.withHost(task.hostId, async () => {
      if (!this.context.engine.taskHostAvailable(task)) throw Error(`Waiting for host ${task.hostId}`);
      const adapter = this.context.engine.adapter;
      if (!adapter.pendingQuestions || !adapter.answerNativeQuestion) throw Error("This host cannot answer native questions");
      const request = (await adapter.pendingQuestions(agent)).find(item => item.requestId === input.requestId);
      if (!request || request.questions.some(q => !input.answers[q.header]?.trim()) || Object.keys(input.answers).some(key => !request.questions.some(q => q.header === key))) throw Error("Question changed or answers are incomplete; refresh before answering");
      if (this.nativeQuestionWorkspace(input.taskId, agent) !== workspace) throw Error("Question thread identity changed");
      if (this.context.store.task(input.taskId).hostId !== task.hostId || !this.context.engine.taskHostAvailable(this.context.store.task(input.taskId))) throw Error(`Waiting for host ${task.hostId}`);
      const legacyIntentId = storeDigest(JSON.stringify([input.taskId, agent, input.requestId]));
      const intentId = storeDigest(JSON.stringify([input.taskId, formatAgentId(task.hostId!, agent), input.requestId]));
      this.context.store.transaction(() => {
        if (this.context.store.eventsAll(input.taskId).some(event => event.kind === 'native_manual_answer_intent' && [intentId, legacyIntentId].some(id => event.detail.startsWith(`${id}:`))))
          throw Error('Native answer delivery is already recorded; inspect the question before retrying');
        if (this.context.store.task(input.taskId).hostId !== task.hostId || this.nativeQuestionWorkspace(input.taskId, agent) !== workspace) throw Error('Question thread identity changed');
        this.context.store.event(input.taskId, 'native_manual_answer_intent', `${intentId}: host ${task.hostId}; agent ${agent}; request ${input.requestId}`);
      });
      await adapter.answerNativeQuestion(agent, workspace, input.requestId, input.answers);
      this.context.store.event(input.taskId, 'native_manual_answer_delivered', `${intentId}: host ${task.hostId}`);
      return { ok: true as const };
    });
  }

  answerDelegatedQuestion(input: import("../../shared/contracts").QuestionAnswerRequest) {
    const {taskId,reference,identitySource,...answer}=input;
    const questionId=answer.questionId ?? this.context.engine.resolution.delegatedQuestionForTask(taskId??reference!,input.caller);
    return this.context.engine.resolution.answerDelegatedQuestionFromHost({...answer,questionId}, input.caller, identitySource);
  }

  answerDecision(input: Parameters<Decisions["answer"]>[0]) {
    const view = this.context.decisions.answer(input);
    // Spec 058 (task 550): a board or pill answer settles any nucleus_ask or
    // ask-mode Queue question waiting behind this decision. Best-effort: the
    // answer is already durably recorded, and a hook failure must never fail it.
    try { this.context.engine.resolution.operatorDecisionAnswered(view); }
    catch { /* the decision record is the durable answer; the ask's own pending receipt names it */ }
    try { reconcileRoutingGrants(this.context.store, this.context.decisions); }
    catch { /* the decision record is the durable answer; grant activation retries on the next reconcile */ }
    void this.context.engine.wake().catch(() => { /* a failed drain is recorded as engineError */ });
    return view;
  }

  addDecision(input: Parameters<Decisions["add"]>[0]) { return this.context.decisions.add(input); }

  getDecision(input: Parameters<Decisions["get"]>[0]) { this.context.markStoreAccess(); return this.context.decisions.get(input); }

  listDecisions(input: Parameters<Decisions["list"]>[0]) { this.context.markStoreAccess(); return this.context.decisions.list(input); }

  decisionAgentProjects(input: Parameters<Decisions["agentProjects"]>[0]) { this.context.markStoreAccess(); return this.context.decisions.agentProjects(input); }

  withdrawDecision(input: Parameters<Decisions["withdraw"]>[0]) { return this.context.decisions.withdraw(input); }

  linkDecision(input: Parameters<Decisions["link"]>[0]) { return this.context.decisions.link(input); }

  supersedeDecision(input: Parameters<Decisions["supersede"]>[0]) { return this.context.decisions.supersede(input); }
}
