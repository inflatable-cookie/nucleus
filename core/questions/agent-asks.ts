import { delegateQuestion, plannerWindows } from "./planner-delegation";
import type { Run, Task } from "../../shared/contracts";
import {
  askBinding,
  askStale,
  askQuestionRefusal,
  AGENT_ASK_POLL_MS,
  AGENT_ASK_WAIT_MS,
  DEFAULT_AGENT_ASK_KIND,
  isOperatorOnlyAsk,
  agentAskId,
  parseAgentAskAnswer,
  queueAnswerText,
  queueAnswerWho,
  queueAskDeliveryId,
  type AgentAskReceipt,
  type AgentAskRequest,
  type AgentAskKind,
  type AgentAskShape,
  type AskRoute,
} from "./agent-ask";
import { REVIEWER_CONSULT_TIMEOUT_MS, reviewerAskPrompt } from "./ladder";
import { Decisions } from "../planning/decisions";
import {
  applyBinaryApproval,
  parseNativeDelegatedReply,
} from "./question-delegation";
import type { Resolution } from "../resolution";
import {
  DelegatedHostUnavailable,
  NO_COMMAND_ANSWER_IN_WINDOW,
  type PlannerRung,
} from "./delegation";
import { digest, type Store } from "../store/store";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import { taskByReference, projectOfTarget } from "./agent-targets";
import { askLifecycle, askLifecycles } from "./agent-ask-events";
import {
  normalizeAskTarget,
  type AskTarget,
} from "../../shared/agent-verbs.mjs";

/**
 * `nucleus_ask`: record one in-turn ask, route it to the retained reviewer, the
 * planner, a decider or an operator decision, wait bounded for the answer and
 * resume the asking agent when it arrives after the wait.
 */
export class AgentAsks {
  constructor(readonly resolution: Resolution) {}
  get store() {
    return this.resolution.store;
  }
  get adapter() {
    return this.resolution.adapter;
  }
  get stopped() {
    return this.resolution.stopped;
  }
  readonly routingAgentAsks = new Set<string>();
  /** The exact authenticated ask currently holding a run's in-turn tool call. */
  readonly inTurnAsks = new Map<
    string,
    { askId: string; runId: string; agentId: string | null }
  >();
  /** The bounded in-turn wait and poll cadence; tests shrink them. */
  agentAskWaitMs = AGENT_ASK_WAIT_MS;
  agentAskPollMs = AGENT_ASK_POLL_MS;
  /**
   * Spec 058 (task 550; tasks 562 and 573): one `nucleus_ask` call from a
   * Queue-launched worker or reviewer run. The authenticated run asks in-turn;
   * Queue records the durable ask intent before routing, so delivery to Queue is
   * never in doubt once the tool returns anything, routes worker process asks
   * to their retained reviewer before a requested planning ruling, and creates
   * an operator decision only for an explicit delegate classification,
   * and the call waits bounded (~120s) for the recorded answer, which names who
   * answered. Past the wait it returns pending with the question id and resumes
   * the agent with the answer when it arrives. Identical content is the same
   * question: a retry joins the open ask, an answered one returns its recorded
   * answer, and an unknown delivery is refused, never re-asked.
   */
  async agentAsk(
    input: AgentAskRequest,
    token: string,
  ): Promise<AgentAskReceipt> {
    const store = this.store;
    store.authenticate(input.runId, token);
    const task = store.task(input.taskId);
    if (task.removedAt) throw Error("Task was removed");
    const run = this.resolution.askBinding(task, input.runId);
    if (run.role !== "revision" && run.role !== "reviewer")
      throw Error(
        `A ${run.role} run cannot ask; nucleus_ask is the worker's and reviewer's question tool`,
      );
    const refusal = askQuestionRefusal(input.question);
    if (refusal) throw Error(refusal);
    const kind = input.kind ?? DEFAULT_AGENT_ASK_KIND;
    const { target, hint, route } = await this.resolveAskRoute(
      task,
      run,
      normalizeAskTarget(input.to, input.target),
      kind,
    );
    const ask: AgentAskShape = {
      sourceAgentId: run.agentId ?? undefined,
      id: agentAskId(task.id, kind, input.question, input.choices ?? [], {
        headline: input.headline,
        choiceDetails: input.choiceDetails,
        recommended: input.recommended,
        details: input.details,
        target: hint,
        route,
      }),
      kind,
      question: input.question,
      choices: input.choices ?? [],
      headline: input.headline,
      choiceDetails: input.choiceDetails,
      recommended: input.recommended,
      details: input.details,
      target,
      ...(route ? { route } : {}),
    };
    const answered = this.resolution.recordedAnswer(task.id, ask.id);
    if (answered) return answered;
    const events = store.eventsAll(task.id);
    const existing = Boolean(askLifecycle(events, ask.id)?.asked);
    const joined = existing
      ? this.resolution.joinedQuestion(events, ask.id)
      : this.resolution.recordAndRouteAsk(task, run, ask);
    if (existing && !joined) this.resumeAgentAsk(task, ask);
    const waiting = { askId: ask.id, runId: run.id, agentId: run.agentId };
    this.inTurnAsks.set(task.id, waiting);
    let returnedAnswer = false;
    try {
      const receipt = await this.resolution.awaitAgentAsk(
        task.id,
        ask.id,
        joined,
      );
      returnedAnswer = receipt.status === "answered";
      return receipt;
    } finally {
      if (returnedAnswer) {
        // The host can still report the tool's turn active briefly after the answer.
        const timer = setTimeout(() => {
          if (this.inTurnAsks.get(task.id) === waiting)
            this.inTurnAsks.delete(task.id);
        }, 3000);
        timer.unref();
      } else if (this.inTurnAsks.get(task.id) === waiting)
        this.inTurnAsks.delete(task.id);
    }
  }
  askBinding(
    task: Task,
    runId: string,
  ): Pick<Run, "id" | "role" | "agentId" | "hostId"> {
    return askBinding(this.store, task, runId);
  }
  askStale(task: Task, suppliedRunId: string): Error {
    return askStale(this.store, task, suppliedRunId);
  }
  /**
   * The route one `ask` takes. `default` and `reviewer` keep the original rungs: a
   * worker's ask reaches its retained reviewer first, and only a planning
   * classification or no reviewer opens the planner ladder; operator-only kinds
   * skip the reviewer. `planner` starts on this task's own ladder. `task` and
   * `project` address another task's planner ladder or a project's fallback planner
   * or named agent. A named agent observed archived, gone or unknown is refused here
   * with that state, so nothing is recorded for a thread that cannot answer.
   */
  async resolveAskRoute(
    task: Task,
    run: Pick<Run, "role" | "agentId" | "hostId">,
    named: AskTarget,
    kind: AgentAskKind,
  ): Promise<{
    target: "reviewer" | "planner";
    hint?: "reviewer" | "planner";
    route?: AskRoute;
  }> {
    const operatorOnly = isOperatorOnlyAsk(kind);
    if (
      kind === "review" &&
      run.role === "revision" &&
      named.kind === "planner"
    )
      return { target: "reviewer", hint: "planner" };
    if (named.kind === "default")
      return {
        target:
          run.role === "revision" && !operatorOnly ? "reviewer" : "planner",
      };
    // A reviewer's own ask skips self-consult, as it always did, and takes the planner ladder.
    if (named.kind === "reviewer")
      return {
        target:
          run.role === "revision" && !operatorOnly ? "reviewer" : "planner",
        hint: "reviewer",
      };
    if (named.kind === "planner") return { target: "planner", hint: "planner" };
    if (named.kind === "reply") {
      // nucleus#1387: a handle names one delivered message; the ask reaches its
      // sender only when that sender is a planner or project agent, which is the
      // route (and the authority) the project rung already carries.
      const sender = await this.resolution.replySender(
        {
          agentId: run.agentId ?? task.agentId ?? null,
          hostId: run.hostId ?? task.hostId ?? null,
        },
        named.reply,
      );
      return {
        target: "planner",
        route: { kind: "reply", agentId: sender.agentId },
      };
    }
    if (named.kind === "task")
      return {
        target: "planner",
        route: {
          kind: "task",
          taskId: taskByReference(this.store, task, named.task).id,
        },
      };
    const project = projectOfTarget(this.store, named.project);
    if (named.agent !== null)
      await this.resolution.resolveProjectAgentTarget(project.key, named.agent);
    return {
      target: "planner",
      route: { kind: "project", project: project.key, agent: named.agent },
    };
  }
  /**
   * The planner rungs a routed ask asks, in order. A route to another task's ladder
   * uses that task's own rungs. A project route asks its fallback planner, or one
   * named agent, and only while that thread is observed live. Anything else moves
   * the ask on to the decider and the board, with the reason recorded.
   */
  async askRungs(
    task: Task,
    ask: Pick<AgentAskShape, "id" | "route" | "sourceAgentId">,
  ): Promise<{ rungs: PlannerRung[]; issue?: string }> {
    if (!ask.route) return this.resolution.plannerRungsFor(task);
    if (ask.route.kind === "task")
      return this.resolution.plannerRungsFor(this.store.task(ask.route.taskId));
    if (ask.route.kind === "reply") {
      // The recorded reply target is re-observed on every attempt; an archived or gone
      // thread drops the rung instead of reviving it, and the ask falls through the
      // ordinary rungs like any other unreachable planner.
      const state = await this.resolution.plannerPresence.threadRoute(
        ask.route.agentId,
      );
      if (state.kind === "routable")
        return { rungs: [{ agentId: ask.route.agentId, rung: "project" }] };
      if (state.kind === "unverified")
        return { rungs: [], issue: state.detail };
      this.store.event(
        task.id,
        "agent_ask_delegation_skipped",
        `${ask.id}: reply target ${ask.route.agentId} skipped: ${state.kind}`.slice(
          0,
          4000,
        ),
      );
      return { rungs: [] };
    }
    try {
      if (ask.route.agent === null) {
        const project = this.store.projectByKey(ask.route.project);
        const resolved = project
          ? await this.resolution.responsibleThread(
              project,
              ask.sourceAgentId
                ? { agentId: ask.sourceAgentId, hostId: task.hostId }
                : undefined,
            )
          : null;
        if (resolved?.thread) {
          return {
            rungs: [{ agentId: resolved.thread.agentId, rung: "project" }],
          };
        }
        if (resolved?.incomplete) {
          return {
            rungs: [],
            issue: `Host inventory for ${ask.route.project} could not be read; waiting for the host to answer.`,
          };
        }
        return { rungs: [] };
      }
      const target = await this.resolution.resolveProjectAgentTarget(
        ask.route.project,
        ask.route.agent,
      );
      return { rungs: [{ agentId: target.agentId, rung: "project" }] };
    } catch (error) {
      this.store.event(
        task.id,
        "agent_ask_delegation_skipped",
        `${ask.id}: project ${ask.route.project}${ask.route.agent ? ` agent ${ask.route.agent}` : " planner"} skipped: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          4000,
        ),
      );
      return { rungs: [] };
    }
  }
  recordedAnswer(taskId: string, askId: string): AgentAskReceipt | null {
    const answered = askLifecycle(
      this.store.eventsAll(taskId),
      askId,
    )?.answered;
    return answered
      ? {
          status: "answered",
          askId,
          answer: answered.answer,
          answeredBy: answered.who,
        }
      : null;
  }
  joinedQuestion(
    events: ReturnType<Store["eventsAll"]>,
    askId: string,
  ): string | null {
    return askLifecycle(events, askId)?.joined ?? null;
  }
  /** Record the durable ask intent (the fence), then route once. Returns the joined Queue question, if any. */
  recordAndRouteAsk(
    task: Task,
    run: Pick<Run, "id" | "role" | "agentId">,
    ask: AgentAskShape,
  ): string | null {
    const events = this.store.eventsAll(task.id);
    // A question Queue itself raised on this task (joint, budget, proof) is the
    // same question when its recorded content digest matches; the ask joins it
    // instead of asking anyone twice, and its own routing answers the join.
    const delivery = events.find(
      (event) =>
        event.kind === "queue_ask_delivery" &&
        event.detail.startsWith(
          `${queueAskDeliveryId(task.id, ask.question, ask.choices)}: `,
        ),
    );
    let joined = delivery
      ? (delivery.detail.split("queue question ")[1]?.trim() ?? null)
      : null;
    // A Queue-raised question whose own delivery was recorded unknown is dead:
    // never re-asked, never routed again. The worker's own ask proceeds on its
    // own routing instead of joining a question nobody will answer.
    if (
      joined &&
      ["responsible_question_unknown", "operator_question_unknown"].some(
        (kind) =>
          events.some(
            (event) =>
              event.kind === kind && event.detail.startsWith(`${joined}:`),
          ),
      )
    ) {
      this.store.event(
        task.id,
        "agent_ask_join_refused",
        `${ask.id}: queue question ${joined} has an unknown delivery record; the ask routes on its own`,
      );
      joined = null;
    }
    this.store.transaction(() => {
      this.store.event(task.id, "agent_ask_payload", JSON.stringify(ask));
      this.store.event(
        task.id,
        "agent_ask",
        `${ask.id}: kind ${ask.kind}; run ${run.id} (${run.role}); agent ${run.agentId ?? "unknown"}; question ${digest(ask.question)} (${ask.question.length} chars); choices ${ask.choices.length ? ask.choices.map((choice) => digest(choice)).join(",") : "none"}`,
      );
      if (joined)
        this.store.event(
          task.id,
          "agent_ask_joined",
          `${ask.id}: queue question ${joined}`,
        );
    });
    if (joined) return joined;
    this.resumeAgentAsk(task, ask);
    return null;
  }
  resumeAgentAsks(task: Task): void {
    let events = this.store.eventsAll(task.id);
    for (const ask of [...askLifecycles(events).values()].filter(
      (state) =>
        state.delegationUnknown && !state.answered && !state.superseded,
    )) {
      const runId = ask.runId;
      if (!runId) continue;
      const run = this.store.run(runId);
      const ended = Boolean(
        run?.completion ||
          run?.released ||
          task.completion?.runId === runId ||
          (task.resolution.currentRunId !== runId && task.runId !== runId),
      );
      if (!ended) continue;
      const reason = `The originating run ${runId} ended; the task's current stop no longer matches this delegated question.`;
      this.store.event(task.id, "agent_ask_superseded", `${ask.id}: ${reason}`);
      events = this.store.eventsAll(task.id);
    }
    for (const event of events.filter(
      (item) => item.kind === "agent_ask_payload",
    )) {
      let ask: AgentAskShape;
      try {
        ask = JSON.parse(event.detail) as AgentAskShape;
      } catch {
        continue; /* An invalid durable payload cannot authorize a send. */
      }
      if (askLifecycle(events, ask.id)?.asked) this.resumeAgentAsk(task, ask);
    }
  }
  resumeAgentAsk(task: Task, ask: AgentAskShape): void {
    if (this.routingAgentAsks.has(ask.id)) return;
    const events = this.store.eventsAll(task.id);
    const state = askLifecycle(events, ask.id);
    if (
      state?.noClassification ||
      events.some(
        (event) =>
          event.kind === "agent_ask_self_handle" &&
          event.detail.startsWith(`${ask.id}:`),
      )
    )
      return;
    const windows = [
      `ns-agent-ask-reviewer-${ask.id}`,
      `ns-agent-ask-${ask.id}`,
      `ns-agent-ask-${ask.id}-project`,
      `ns-decider-${ask.id}`,
    ];
    const recoverable = this.resolution.recoverableDelegation(windows);
    const observing = this.resolution.recoverableDelegation(windows, false);
    const settled = Boolean(
      state &&
        (state.answered ||
          state.decisionId ||
          state.joined ||
          state.superseded ||
          (!observing && state.delegationUnknown)),
    );
    if (settled) return;
    this.routingAgentAsks.add(ask.id);
    // A recorded send without an observed outcome may have landed. Never send it again.
    const reviewerFinished = Boolean(
      state && (state.planningRuling || state.reviewerMissed),
    );
    const delegatedNonReviewer = Boolean(
      state?.planner || state?.deciderStarted,
    );
    const sent =
      delegatedNonReviewer ||
      (Boolean(state?.reviewer) && !reviewerFinished) ||
      windows.some((id) => Boolean(this.resolution.delegatedDelivery(id)));
    const route =
      sent && !recoverable
        ? Promise.resolve().then(() =>
            this.store.event(
              task.id,
              "agent_ask_delegation_unknown",
              `${ask.id}: a previous delegate delivery or answer could not be observed; awaiting an explicit planner or decider classification`,
            ),
          )
        : this.resolution.routeAgentAsk(task, ask);
    void route
      .catch((error) => {
        if (!this.stopped())
          this.store.event(
            task.id,
            "agent_ask_error",
            `${ask.id}: ${error instanceof Error ? error.message : String(error)}`.slice(
              0,
              4000,
            ),
          );
      })
      .finally(() => this.routingAgentAsks.delete(ask.id));
  }
  async routeAgentAsk(task: Task, ask: AgentAskShape): Promise<void> {
    // Worker questions reach the retained reviewer first. Only its explicit
    // planning classification (or no retained reviewer) opens the planner rung.
    const lifecycle = askLifecycle(this.store.eventsAll(task.id), ask.id);
    const planningRuling = Boolean(
      lifecycle?.planningRuling || lifecycle?.reviewerMissed,
    );
    if (
      ask.target === "reviewer" &&
      !planningRuling &&
      !lifecycle?.planner &&
      !lifecycle?.deciderStarted
    )
      return this.resolution.routeReviewerAsk(task, ask);
    // The worker-supplied kind is only a hint. Every worker question is
    // classified by a planner or decider before any operator decision exists.
    const reviewerRuling = lifecycle?.planningRulingDetail ?? null;
    const context = {
      question: ask.question,
      choices: ask.choices,
      context: [
        ...this.resolution.decisionContext(task),
        ...(reviewerRuling ? [reviewerRuling] : []),
      ],
    };
    const binaryContext = [
      ask.headline,
      ask.details ?? "",
      ...(ask.choiceDetails ?? []).map((choice) => choice.consequence),
    ].join(" ");
    const recordAnswer = (
      who: string,
      reply: { answer: string; reason: string },
      overtakes?: string[],
    ) => {
      const approved = applyBinaryApproval(
        ask.question,
        ask.choices,
        reply.answer,
        `${binaryContext} ${reply.reason}`,
      );
      this.resolution.recordAgentAskAnswer(
        task.id,
        ask.id,
        who,
        approved?.choice ?? reply.answer,
        approved ? approved.reason : reply.reason,
        overtakes,
      );
    };
    let unknown = false;
    let unavailable = false;
    let result;
    try {
      // The task's own planner is first, followed by a live project thread.
      const { rungs, issue } = await this.askRungs(task, ask);
      if (
        !rungs.length &&
        !issue &&
        !this.resolution.delegatedDelivery(`ns-agent-ask-${ask.id}`) &&
        !this.resolution.delegatedDelivery(`ns-agent-ask-${ask.id}-project`) &&
        !this.resolution.delegatedDelivery(`ns-decider-${ask.id}`)
      ) {
        if (isOperatorOnlyAsk(ask.kind)) {
          this.resolution.askOperatorDecision(
            task,
            ask,
            "No live responsible thread is available",
          );
          return;
        }
        const project =
          ask.route?.kind === "project"
            ? ask.route.project
            : (this.store.projectFor(
                task.repoPath,
                normalizeRepositoryOrigin(task.repository ?? ""),
              )?.key ?? "this project");
        this.store.event(
          task.id,
          "agent_ask_self_handle",
          `${ask.id}: No live responsible thread for ${project}; handle it yourself.`,
        );
        return;
      }
      const planners = plannerWindows(
        this.resolution,
        `ns-agent-ask-${ask.id}`,
        rungs,
      );
      if (issue) {
        const detail = `${ask.id}: ${issue}`;
        if (
          !this.store
            .eventsAll(task.id)
            .some(
              (event) =>
                event.kind === "agent_ask_host_wait" && event.detail === detail,
            )
        )
          this.store.event(task.id, "agent_ask_host_wait", detail);
        if (
          !planners.length &&
          !this.resolution.delegatedDelivery(`ns-decider-${ask.id}`)
        )
          return;
      }
      result = await delegateQuestion(this.resolution, task, {
        planners,
        allowDecider: false,
        decisionId: ask.id,
        context,
        signal: new AbortController().signal,
        sourceAgentId: ask.sourceAgentId,
        parse: parseNativeDelegatedReply,
        onIntent: (role, agentId, rung) =>
          this.store.event(
            task.id,
            "agent_ask_delegated",
            `${ask.id}: ${role === "planner" ? `${rung === "task" ? "task planner" : "project planner"} ${agentId}; asked` : "decider requested"}`,
          ),
        onSkip: (rung, agentId, detail) =>
          this.store.event(
            task.id,
            "agent_ask_delegation_skipped",
            `${ask.id}: ${rung} planner ${agentId} skipped: ${detail}`.slice(
              0,
              4000,
            ),
          ),
        onMiss: (detail) =>
          this.store.event(
            task.id,
            "agent_ask_delegation_missed",
            `${ask.id}: ${detail}`,
          ),
        onUnknown: (role, agentId, error) => {
          const key =
            ask.route?.kind === "project"
              ? ask.route.project
              : this.store.projectFor(
                  task.repoPath,
                  normalizeRepositoryOrigin(task.repository ?? ""),
                )?.key;
          if (key) this.resolution.responsibleThreads.cache.invalidate(key);
          unknown = true;
          this.store.event(
            task.id,
            "agent_ask_delegation_unknown",
            `${ask.id}: ${role}${agentId ? ` ${agentId}` : ""}: ${error instanceof Error ? error.message : String(error)}`.slice(
              0,
              4000,
            ),
          );
        },
        onUnavailable: (planner) => {
          unavailable = true;
          const key =
            ask.route?.kind === "project"
              ? ask.route.project
              : this.store.projectFor(
                  task.repoPath,
                  normalizeRepositoryOrigin(task.repository ?? ""),
                )?.key;
          if (key) this.resolution.responsibleThreads.cache.invalidate(key);
          if (isOperatorOnlyAsk(ask.kind))
            this.resolution.askOperatorDecision(
              task,
              ask,
              `Selected planner ${planner} cannot be asked on its host.`,
            );
          else
            this.store.event(
              task.id,
              "agent_ask_self_handle",
              `${ask.id}: No live responsible thread for ${key ?? "this project"}; handle it yourself.`,
            );
        },
      });
    } catch (error) {
      if (!(error instanceof DelegatedHostUnavailable)) throw error;
      if (
        !this.store
          .eventsAll(task.id)
          .some(
            (event) =>
              event.kind === "agent_ask_host_wait" &&
              event.detail.startsWith(`${ask.id}:`),
          )
      )
        this.store.event(
          task.id,
          "agent_ask_host_wait",
          `${ask.id}: Waiting for the planner's proven host to be available`,
        );
      return;
    }
    if (result?.reply.kind === "answer")
      return recordAnswer(
        `${result.role} ${result.agentId}`,
        result.reply,
        result.role === "planner" ? result.reply.overtakes : undefined,
      );
    if (result?.reply.kind === "operator")
      this.resolution.askOperatorDecision(
        task,
        ask,
        `${result.role === "planner" ? "Planner" : "Decider"}'s one-line reason: ${result.reply.reason}`,
      );
    else if (!unknown && !unavailable && !this.stopped()) {
      if (!isOperatorOnlyAsk(ask.kind))
        this.store.event(
          task.id,
          "agent_ask_self_handle",
          `${ask.id}: No responsible thread answered; handle it yourself.`,
        );
      else
        this.resolution.askOperatorDecision(
          task,
          ask,
          "No responsible thread answered",
        );
    }
  }

  /**
   * A worker ask reaches the retained reviewer mid-turn without a review round.
   * Its advice answers the question; an explicit planning classification opens
   * the planner rung. With no reviewer the ordinary planner route answers it.
   * A known miss advances; unknown delivery stays pending.
   */
  async routeReviewerAsk(task: Task, ask: AgentAskShape): Promise<void> {
    if (
      !task.resolution.reviewerAgentId &&
      !this.resolution.delegatedDelivery(`ns-agent-ask-reviewer-${ask.id}`)
    )
      return this.resolution.routeAgentAsk(task, { ...ask, target: "planner" });
    if (
      !task.hostId ||
      !this.resolution.withHost(task.hostId, () =>
        this.resolution.originHostAvailable(task.hostId),
      )
    )
      return;
    return this.resolution.withHost(task.hostId, () =>
      this.routeReviewerAskOnHost(task, ask),
    );
  }
  private async routeReviewerAskOnHost(
    task: Task,
    ask: AgentAskShape,
  ): Promise<void> {
    const messageId = `ns-agent-ask-reviewer-${ask.id}`;
    const delivery = this.resolution.delegatedDelivery(messageId);
    const reviewer = delivery?.recipient ?? task.resolution.reviewerAgentId;
    if (reviewer && !this.adapter.askReviewer) {
      this.store.event(
        task.id,
        "agent_ask_delegation_missed",
        `${ask.id}: reviewer ${reviewer} delivery adapter unavailable; no planning ruling requested`,
      );
      return;
    }
    if (reviewer && this.adapter.askReviewer) {
      const events = this.store.eventsAll(`delegation:${messageId}`);
      const expiredConsult =
        delivery?.retainAfterDeadline &&
        Date.now() >= delivery.deadline &&
        events.some((event) => event.kind === "delegated_sent") &&
        !events.some((event) =>
          ["delegated_answer", "delegated_closed"].includes(event.kind),
        );
      // Only a positive terminal observation skips a retained reviewer.
      let gone = false;
      if (!delivery || expiredConsult) {
        try {
          const identity = this.adapter.originAgent
            ? await this.resolution.host.originAgent(reviewer)
            : undefined;
          gone =
            identity === null ||
            Boolean(identity?.archived || identity?.deleted);
          if (!gone) {
            const state = await this.resolution.host.observe(reviewer);
            gone =
              state.id === reviewer &&
              ["closed", "gone"].includes(state.status);
          }
        } catch {
          /* preserve the ordinary route */
        }
      }
      if (
        !delivery &&
        this.store.task(task.id).resolution.reviewerAgentId !== reviewer
      )
        return;
      const receivedDuringRead =
        expiredConsult &&
        this.store
          .eventsAll(`delegation:${messageId}`)
          .some((event) => event.kind === "delegated_answer");
      if (gone && !receivedDuringRead) {
        if (delivery)
          this.store.event(
            `delegation:${messageId}`,
            "delegated_closed",
            NO_COMMAND_ANSWER_IN_WINDOW,
          );
        this.store.event(
          task.id,
          "agent_ask_reviewer_missed",
          `${ask.id}: reviewer ${reviewer} is closed or archived`,
        );
        return this.resolution.routeAgentAsk(task, {
          ...ask,
          target: "planner",
        });
      }
      if (expiredConsult && !receivedDuringRead) return;
      if (!delivery)
        this.store.event(
          task.id,
          "agent_ask_delegated",
          `${ask.id}: reviewer ${reviewer}; consult`,
        );
      let text: string | null = null;
      try {
        text = await this.resolution.askBound(
          task,
          reviewer,
          {
            prompt: reviewerAskPrompt(
              ask.question,
              task.title,
              this.resolution.decisionContext(task),
            ),
            signal: new AbortController().signal,
            timeoutMs: REVIEWER_CONSULT_TIMEOUT_MS,
            messageId,
            choices: [],
            retainAfterDeadline: ask.kind === "review",
            sourceAgentId: ask.sourceAgentId,
          },
          "reviewer",
        );
      } catch (error) {
        if (this.stopped()) return;
        if (error instanceof DelegatedHostUnavailable) return;
        // A send that may have landed is unknown: never re-asked; the ask stays pending.
        this.store.event(
          task.id,
          "agent_ask_delegation_unknown",
          `${ask.id}: reviewer ${reviewer}: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            4000,
          ),
        );
        return;
      }
      const advice = text?.trim();
      if (advice && /^Decision:\s*planner\b/im.test(advice)) {
        this.store.event(
          task.id,
          "agent_ask_planning_ruling",
          `${ask.id}: reviewer ${reviewer}: ${advice.slice(0, 4000)}`,
        );
      } else if (advice) {
        this.resolution.recordAgentAskAnswer(
          task.id,
          ask.id,
          `reviewer ${reviewer}`,
          advice.slice(0, 4000),
          "",
        );
        return;
      } else {
        if (ask.kind === "review") return;
        this.store.event(
          task.id,
          "agent_ask_reviewer_missed",
          `${ask.id}: reviewer ${reviewer} gave no usable answer`,
        );
      }
    }
    return this.resolution.routeAgentAsk(task, { ...ask, target: "planner" });
  }
  recordAgentAskAnswer(
    taskId: string,
    askId: string,
    who: string,
    answer: string,
    reason: string,
    overtakes: string[] = [],
  ): void {
    if (askLifecycle(this.store.eventsAll(taskId), askId)?.superseded) {
      this.store.event(
        taskId,
        "agent_ask_stale_answered",
        `${askId}: answered by ${who}: ${answer}${reason ? ` — ${reason}` : ""}; no effect because the question was superseded`,
      );
      this.resolution.notifyStaleQuestionAnswer(taskId, askId, who);
      return;
    }
    this.store.transaction(() => {
      this.store.event(
        taskId,
        "agent_ask_answered",
        `${askId}: answered by ${who}: ${answer}${reason ? ` — ${reason}` : ""}`,
      );
      const decisions = new Decisions(this.store);
      const reference = {
        kind: "planner_answer" as const,
        id: taskId,
        sourceId: askId,
        label: `Answer by ${who}: ${answer}`.slice(0, 240),
        at: new Date().toISOString(),
      };
      for (const id of [...new Set(overtakes)].slice(0, 100)) {
        try {
          decisions.markOvertaken(id, reference);
          this.store.event(taskId, "agent_ask_overtakes", `${askId}: ${id}`);
        } catch (error) {
          this.store.event(
            taskId,
            "agent_ask_overtakes_refused",
            `${askId}: ${id}: ${error instanceof Error ? error.message : String(error)}`.slice(
              0,
              1000,
            ),
          );
        }
      }
    });
    this.resolution.notifyAskAnswered(taskId, askId, answer, who);
  }
  /**
   * Task 562: resume the asking agent with a recorded answer. The in-turn wait
   * already returned pending, so the answer arrives after the turn; one
   * best-effort notify carries it to the asking agent. A durable
   * `agent_ask_resume_intent` fences it before the host call, so an uncertain
   * delivery is never resent; a successful notify then records one durable
   * `agent_ask_resumed` event. Old successful resume events remain valid fences.
   */
  notifyAskAnswered(
    taskId: string,
    askId: string,
    answer: string,
    who: string,
  ): void {
    try {
      const state = askLifecycle(this.store.eventsAll(taskId), askId);
      if (!state || state.resumed || state.resumeIntent) return;
      const runId = state.runId;
      const task = this.store.task(taskId);
      const run = runId
        ? this.store.runs(taskId).find((item) => item.id === runId)
        : undefined;
      const agentId = state.agentId;
      const hostId = run?.hostId ?? task.hostId;
      const owned = run
        ? run.agentId === agentId
        : task.runId === runId && task.agentId === agentId;
      if (
        !owned ||
        !agentId ||
        !hostId ||
        (run?.hostId && task.hostId && run.hostId !== task.hostId)
      )
        return;
      if (
        !this.resolution.withHost(
          hostId,
          () =>
            this.resolution.originHostAvailable(hostId) &&
            Boolean(this.adapter.notify),
        )
      )
        return;
      const text = `Your Nucleus question ${askId} was answered by ${who}: ${answer}. Continue the work with this answer.`;
      this.store.event(
        taskId,
        "agent_ask_resume_intent",
        `${askId}: host ${hostId}; agent ${agentId}; run ${runId}`,
      );
      void this.resolution
        .withHost(hostId, () =>
          this.resolution.host.steerOrNotify(agentId, {
            messageId: `ns-agent-ask-answered-${askId}`,
            text: text.slice(0, 4000),
          }),
        )
        .then(() => {
          if (
            !this.stopped() &&
            !askLifecycle(this.store.eventsAll(taskId), askId)?.resumed
          )
            this.store.event(
              taskId,
              "agent_ask_resumed",
              `${askId}: resumed ${agentId}; answered by ${who}`,
            );
        })
        .catch(() => {
          /* delivery is unknown; the intent prevents a resend */
        });
    } catch {
      /* a read failure never blocks the recorded answer */
    }
  }
  /**
   * Task 562: settle pending joined asks whose Queue-raised question answered
   * after the in-turn wait returned. The polling waiter copies the join only
   * while it is still waiting; this sweep copies it after, so a pending ask
   * still collects its answer and resumes without another call.
   */
  resumePendingAskAnswers(taskId?: string): void {
    const tasks = taskId
      ? [this.store.task(taskId)]
      : this.store
          .maintenanceTasks(true)
          .map((candidate) => this.store.task(candidate.id));
    for (const task of tasks) {
      for (const ask of askLifecycles(this.store.eventsAll(task.id)).values()) {
        if (ask.answered || ask.superseded || !ask.joined) continue;
        const joined = ask.joined;
        const settled = this.store
          .eventsAll(task.id)
          .find(
            (event) =>
              (event.kind === "operator_question_answered" ||
                event.kind === "responsible_question_answered") &&
              event.detail.startsWith(`${joined}:`),
          );
        if (!settled) continue;
        const answer = queueAnswerText(settled.detail),
          who = queueAnswerWho(settled.detail);
        if (!askLifecycle(this.store.eventsAll(task.id), ask.id)?.answered)
          this.store.event(
            task.id,
            "agent_ask_answered",
            `${ask.id}: answered by ${who}: ${answer}`,
          );
        this.resolution.notifyAskAnswered(task.id, ask.id, answer, who);
      }
      for (const ask of askLifecycles(this.store.eventsAll(task.id)).values()) {
        if (!ask.answered || !ask.askedAt || ask.resumed) continue;
        // An in-turn waiter still polling collects the answer itself; the sweep
        // only resumes asks whose waiter already returned pending. A waiter that
        // returned pending left no resumed marker, so an unresumed answer older
        // than the in-turn wait is a pending answer that still needs its resume.
        if (Date.now() - Date.parse(ask.askedAt) < this.agentAskWaitMs)
          continue;
        this.resolution.notifyAskAnswered(
          task.id,
          ask.id,
          ask.answered.answer,
          ask.answered.who,
        );
      }
    }
  }
  /** The Spec 032 decision an operator-only ask waits on; created once, linked durably. */
  askOperatorDecision(task: Task, ask: AgentAskShape, why: string): void {
    const events = this.store.eventsAll(task.id);
    if (askLifecycle(events, ask.id)?.decisionId) return;
    this.store.transaction(() => {
      const view = new Decisions(this.store).add({
        question: ask.question,
        headline: ask.headline,
        choices: ask.choiceDetails,
        recommended: ask.recommended ?? ask.choices[0],
        details: [
          ask.details,
          ask.question.length > 140 ? `Full question: ${ask.question}` : null,
          why,
          ask.recommended ? `Recommended answer: ${ask.recommended}` : null,
          `Question context: nucleus_ask ${ask.id} (kind hint ${ask.kind}) from this task's own run`,
          this.resolution.decisionContext(task),
        ]
          .filter(Boolean)
          .join("\n\n")
          .slice(0, 48000),
        context:
          `nucleus_ask ${ask.id} (kind hint ${ask.kind}) from this task's own run; delegate classified it as operator-only: ${why}`.slice(
            0,
            4000,
          ),
        options: ask.choices,
        askedBy: task.agentId ?? "nucleus",
        tasks: [task.id],
        by: "nucleus",
      });
      this.store.event(
        task.id,
        "agent_ask_decision",
        `${ask.id}: decision ${view.id}; ${why}`.slice(0, 4000),
      );
    });
  }
  /** The bounded in-turn wait for one ask's durable answer; afterwards the tool returns pending and the answer resumes the agent. */
  async awaitAgentAsk(
    taskId: string,
    askId: string,
    joined: string | null,
  ): Promise<AgentAskReceipt> {
    const deadline = Date.now() + this.agentAskWaitMs;
    for (;;) {
      const answered = this.resolution.recordedAnswer(taskId, askId);
      if (answered) return answered;
      if (joined) {
        const settled = this.store
          .eventsAll(taskId)
          .find(
            (event) =>
              (event.kind === "operator_question_answered" ||
                event.kind === "responsible_question_answered") &&
              event.detail.startsWith(`${joined}:`),
          );
        if (settled) {
          const answer = queueAnswerText(settled.detail),
            who = queueAnswerWho(settled.detail);
          if (!this.resolution.recordedAnswer(taskId, askId))
            this.store.event(
              taskId,
              "agent_ask_answered",
              `${askId}: answered by ${who}: ${answer}`,
            );
          return { status: "answered", askId, answer, answeredBy: who };
        }
      }
      const selfHandle = this.store
        .eventsAll(taskId)
        .find(
          (event) =>
            event.kind === "agent_ask_self_handle" &&
            event.detail.startsWith(`${askId}:`),
        );
      if (selfHandle)
        return {
          status: "pending",
          askId,
          detail: selfHandle.detail.slice(askId.length + 2),
        };
      // A recorded owner direction needs the agent's turn to finish. Yield the
      // tool call without answering or cancelling its independently routed ask.
      if (
        this.store
          .eventsAll(taskId)
          .some(
            (event) =>
              event.kind === "agent_ask_yield" &&
              event.detail.startsWith(`${askId}:`),
          )
      )
        return {
          status: "pending",
          askId,
          detail: this.resolution.agentAskPendingDetail(taskId, askId),
        };
      if (Date.now() >= deadline || this.stopped())
        return {
          status: "pending",
          askId,
          detail: this.resolution.agentAskPendingDetail(taskId, askId),
        };
      await new Promise((resolve) => setTimeout(resolve, this.agentAskPollMs));
    }
  }
  /** Where a pending ask sits: the tool's pending result names its id and who holds it, and promises a resume. */
  agentAskPendingDetail(taskId: string, askId: string): string {
    const events = this.store.eventsAll(taskId);
    const state = askLifecycle(events, askId);
    const linked = (prefix: string, kind: string) =>
      events
        .find(
          (event) =>
            event.kind === kind && event.detail.startsWith(`${prefix}: `),
        )
        ?.detail.slice(prefix.length + 2) ?? "";
    const joined = state?.joined ?? undefined;
    const decision =
      state?.decisionId ??
      (joined
        ? linked(joined, "operator_question_decision").match(
            /decision (\S+)/,
          )?.[1]
        : undefined);
    const deciderStarted = Boolean(state?.deciderStarted);
    const planner = state?.planner?.agentId;
    const plannerLabel =
      state?.planner?.rung === "task"
        ? "task planner"
        : state?.planner?.rung === "project"
          ? "project planner"
          : "planner";
    const reviewer = state?.reviewer ?? undefined;
    const routingIssue = state?.hostWait
      ? linked(askId, "agent_ask_host_wait")
      : "";
    if (!planner && !deciderStarted && routingIssue)
      return `Recorded as question ${askId}. ${routingIssue.replace(/[.]$/, "")}. You may continue other work or call again to collect the answer.`;
    if (planner && !deciderStarted && state?.delegationUnknown)
      return `Recorded as question ${askId}; delivery to planner ${planner} is uncertain. Nucleus will not re-ask or start a decider. The question remains with the planner.`;
    const holder = decision
      ? `Tom as Nucleus operator decision ${decision}`
      : deciderStarted
        ? "a decider"
        : planner
          ? `${plannerLabel} ${planner}`
          : reviewer
            ? `reviewer ${reviewer}`
            : "a planner or a decider";
    return `Recorded as question ${askId}; pending with ${holder}. ${routingIssue ? `${routingIssue} ` : ""}You'll be resumed with the answer. You may continue other work or end your turn, and call your session's question tool again with the same question to collect the answer.`;
  }
}
