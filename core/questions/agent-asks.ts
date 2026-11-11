import { delegateQuestion } from './planner-delegation';
import type { Run, Task } from '../../shared/contracts';
import { askBinding, askStale, askQuestionRefusal, AGENT_ASK_POLL_MS, AGENT_ASK_WAIT_MS, DEFAULT_AGENT_ASK_KIND, isOperatorOnlyAsk, agentAskId, parseAgentAskAnswer, queueAnswerText, queueAnswerWho, queueAskDeliveryId, type AgentAskReceipt, type AgentAskRequest, type AgentAskShape } from './agent-ask';
import { REVIEWER_CONSULT_TIMEOUT_MS, reviewerAskPrompt } from './blocker-ladder';
import { Decisions } from '../planning/decisions';
import { applyBinaryApproval, parseNativeDelegatedReply } from './question-delegation';
import type { Resolution } from '../resolution';
import { DelegatedHostUnavailable } from './delegation';
import { digest, type Store } from '../store/store';

/**
 * `nucleus_ask`: record one in-turn ask, route it to the retained reviewer, the
 * planner, a decider or an operator decision, wait bounded for the answer and
 * resume the asking agent when it arrives after the wait.
 */
export class AgentAsks {
  constructor(readonly resolution: Resolution) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  get stopped() { return this.resolution.stopped; }
  readonly routingAgentAsks = new Set<string>();
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
  async agentAsk(input: AgentAskRequest, token: string): Promise<AgentAskReceipt> {
    const store = this.store;
    store.authenticate(input.runId, token);
    const task = store.task(input.taskId);
    if (task.removedAt) throw Error('Task was removed');
    const run = this.resolution.askBinding(task, input.runId);
    if (run.role !== 'revision' && run.role !== 'reviewer') throw Error(`A ${run.role} run cannot ask; nucleus_ask is the worker's and reviewer's question tool`);
    const refusal = askQuestionRefusal(input.question);
    if (refusal) throw Error(refusal);
    // Worker process asks reach the retained reviewer first. Reviewer asks skip
    // self-consult, then take the same planner/decider classification as worker
    // asks. Operator-only kinds skip the reviewer rung for both.
    const target = run.role === 'revision' && !isOperatorOnlyAsk(input.kind ?? DEFAULT_AGENT_ASK_KIND) ? 'reviewer' : 'planner';
    const ask: AgentAskShape = {
      sourceAgentId: run.agentId ?? undefined,
      id: agentAskId(task.id, input.kind ?? DEFAULT_AGENT_ASK_KIND, input.question, input.choices ?? [], {
        headline: input.headline, choiceDetails: input.choiceDetails, recommended: input.recommended, details: input.details, target: input.target,
      }),
      kind: input.kind ?? DEFAULT_AGENT_ASK_KIND, question: input.question, choices: input.choices ?? [],
      headline: input.headline, choiceDetails: input.choiceDetails, recommended: input.recommended, details: input.details, target,
    };
    const answered = this.resolution.recordedAnswer(task.id, ask.id);
    if (answered) return answered;
    const events = store.eventsAll(task.id);
    const existing = events.some(event => event.kind === 'agent_ask' && event.detail.startsWith(`${ask.id}:`));
    const joined = existing ? this.resolution.joinedQuestion(events, ask.id) : this.resolution.recordAndRouteAsk(task, run, ask);
    if (existing && !joined) this.resumeAgentAsk(task, ask);
    return await this.resolution.awaitAgentAsk(task.id, ask.id, joined);
  }
  askBinding(task: Task, runId: string): Pick<Run, 'id' | 'role' | 'agentId'> { return askBinding(this.store, task, runId); }
  askStale(task: Task, suppliedRunId: string): Error { return askStale(this.store, task, suppliedRunId); }
  recordedAnswer(taskId: string, askId: string): AgentAskReceipt | null {
    const event = this.store.eventsAll(taskId).find(event => event.kind === 'agent_ask_answered' && event.detail.startsWith(`${askId}:`));
    const parsed = event ? parseAgentAskAnswer(event.detail) : null;
    return parsed ? { status: 'answered', askId, answer: parsed.answer, answeredBy: parsed.who } : null;
  }
  joinedQuestion(events: ReturnType<Store['eventsAll']>, askId: string): string | null {
    const join = events.find(event => event.kind === 'agent_ask_joined' && event.detail.startsWith(`${askId}: queue question `));
    return join ? join.detail.slice(`${askId}: queue question `.length).trim() || null : null;
  }
  /** Record the durable ask intent (the fence), then route once. Returns the joined Queue question, if any. */
  recordAndRouteAsk(task: Task, run: Pick<Run, 'id' | 'role' | 'agentId'>, ask: AgentAskShape): string | null {
    const events = this.store.eventsAll(task.id);
    // A question Queue itself raised on this task (joint, budget, proof) is the
    // same question when its recorded content digest matches; the ask joins it
    // instead of asking anyone twice, and its own routing answers the join.
    const delivery = events.find(event => event.kind === 'queue_ask_delivery'
      && event.detail.startsWith(`${queueAskDeliveryId(task.id, ask.question, ask.choices)}: `));
    let joined = delivery ? delivery.detail.split('queue question ')[1]?.trim() ?? null : null;
    // A Queue-raised question whose own delivery was recorded unknown is dead:
    // never re-asked, never routed again. The worker's own ask proceeds on its
    // own routing instead of joining a question nobody will answer.
    if (joined && ['responsible_question_unknown', 'operator_question_unknown']
      .some(kind => events.some(event => event.kind === kind && event.detail.startsWith(`${joined}:`)))) {
      this.store.event(task.id, 'agent_ask_join_refused', `${ask.id}: queue question ${joined} has an unknown delivery record; the ask routes on its own`);
      joined = null;
    }
    this.store.transaction(() => {
      this.store.event(task.id, 'agent_ask_payload', JSON.stringify(ask));
      this.store.event(task.id, 'agent_ask', `${ask.id}: kind ${ask.kind}; run ${run.id} (${run.role}); agent ${run.agentId ?? 'unknown'}; question ${digest(ask.question)} (${ask.question.length} chars); choices ${ask.choices.length ? ask.choices.map(choice => digest(choice)).join(',') : 'none'}`);
      if (joined) this.store.event(task.id, 'agent_ask_joined', `${ask.id}: queue question ${joined}`);
    });
    if (joined) return joined;
    this.resumeAgentAsk(task, ask);
    return null;
  }
  resumeAgentAsks(task: Task): void {
    let events = this.store.eventsAll(task.id);
    for (const unknown of events.filter(item => item.kind === 'agent_ask_delegation_unknown')) {
      const askId = unknown.detail.split(':', 1)[0]!;
      if (events.some(item => ['agent_ask_answered', 'agent_ask_superseded'].includes(item.kind) && item.detail.startsWith(`${askId}:`))) continue;
      const ask = events.find(item => item.kind === 'agent_ask' && item.detail.startsWith(`${askId}:`));
      const runId = ask?.detail.match(/\brun ([^\s(]+)/)?.[1];
      if (!runId) continue;
      const run = this.store.run(runId);
      const ended = Boolean(run?.completion || run?.released || task.completion?.runId === runId
        || (task.resolution.currentRunId !== runId && task.runId !== runId));
      if (!ended) continue;
      const reason = `The originating run ${runId} ended; the task's current stop no longer matches this delegated question.`;
      this.store.event(task.id, 'agent_ask_superseded', `${askId}: ${reason}`);
      events = this.store.eventsAll(task.id);
    }
    for (const event of events.filter(item => item.kind === 'agent_ask_payload')) {
      try {
        const ask = JSON.parse(event.detail) as AgentAskShape;
        if (events.some(item => item.kind === 'agent_ask' && item.detail.startsWith(`${ask.id}:`))) this.resumeAgentAsk(task, ask);
      } catch { /* An invalid durable payload cannot authorize a send. */ }
    }
  }
  resumeAgentAsk(task: Task, ask: AgentAskShape): void {
    if (this.routingAgentAsks.has(ask.id)) return;
    const events = this.store.eventsAll(task.id);
    if (events.some(event => event.kind === 'agent_ask_delegation_missed' && event.detail.startsWith(`${ask.id}: no planner or decider classification was produced;`))) return;
    const windows = [`ns-agent-ask-reviewer-${ask.id}`, `ns-agent-ask-${ask.id}`, `ns-decider-${ask.id}`];
    const recoverable = this.resolution.recoverableDelegation(windows);
    const observing = this.resolution.recoverableDelegation(windows, false);
    if (events.some(event => (['agent_ask_answered', 'agent_ask_decision', 'agent_ask_joined', 'agent_ask_superseded'].includes(event.kind) || (!observing && event.kind === 'agent_ask_delegation_unknown')) && event.detail.startsWith(`${ask.id}:`))) return;
    this.routingAgentAsks.add(ask.id);
    // A recorded send without an observed outcome may have landed. Never send it again.
    const reviewerFinished = events.some(event => ['agent_ask_planning_ruling', 'agent_ask_reviewer_missed'].includes(event.kind) && event.detail.startsWith(`${ask.id}:`));
    const sent = events.some(event => event.kind === 'agent_ask_delegated' && event.detail.startsWith(`${ask.id}: `)
      && (!event.detail.startsWith(`${ask.id}: reviewer `) || !reviewerFinished))
      || windows.some(id => Boolean(this.resolution.delegatedDelivery(id)));
    const route = sent && !recoverable ? Promise.resolve().then(() => this.store.event(task.id, 'agent_ask_delegation_unknown', `${ask.id}: a previous delegate delivery or answer could not be observed; awaiting an explicit planner or decider classification`)) : this.resolution.routeAgentAsk(task, ask);
    void route.catch(error => {
      if (!this.stopped()) this.store.event(task.id, 'agent_ask_error', `${ask.id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
    }).finally(() => this.routingAgentAsks.delete(ask.id));
  }
  async routeAgentAsk(task: Task, ask: AgentAskShape): Promise<void> {
    // Worker questions reach the retained reviewer first. Only its explicit
    // planning classification (or no retained reviewer) opens the planner rung.
    const planningRuling = this.store.eventsAll(task.id).some(event => ['agent_ask_planning_ruling', 'agent_ask_reviewer_missed'].includes(event.kind) && event.detail.startsWith(`${ask.id}:`));
    if (ask.target === 'reviewer' && !planningRuling) return this.resolution.routeReviewerAsk(task, ask);
    // The worker-supplied kind is only a hint. Every worker question is
    // classified by a planner or decider before any operator decision exists.
    const reviewerRuling = this.store.eventsAll(task.id).find(event => event.kind === 'agent_ask_planning_ruling' && event.detail.startsWith(`${ask.id}:`));
    const context = { question: ask.question, choices: ask.choices, context: [...this.resolution.decisionContext(task), ...(reviewerRuling ? [reviewerRuling.detail] : [])] };
    const binaryContext = [ask.headline, ask.details ?? '', ...(ask.choiceDetails ?? []).map(choice => choice.consequence)].join(' ');
    const recordAnswer = (who: string, reply: { answer: string; reason: string }, overtakes?: string[]) => {
      const approved = applyBinaryApproval(ask.question, ask.choices, reply.answer, `${binaryContext} ${reply.reason}`);
      this.resolution.recordAgentAskAnswer(task.id, ask.id, who, approved?.choice ?? reply.answer, approved ? approved.reason : reply.reason, overtakes);
    };
    let unknown = false;
    let unavailable = false;
    let result;
    try {
      result = await delegateQuestion(this.resolution, task, {
        planner: (await this.resolution.projectPlannerFor(task)).planner,
        plannerMessageId: `ns-agent-ask-${ask.id}`, decisionId: ask.id, context,
        signal: new AbortController().signal, sourceAgentId: ask.sourceAgentId,
        parse: parseNativeDelegatedReply,
        onIntent: (role, agentId) => this.store.event(task.id, 'agent_ask_delegated', `${ask.id}: ${role === 'planner' ? `planner ${agentId}; asked` : 'decider requested'}`),
        onMiss: detail => this.store.event(task.id, 'agent_ask_delegation_missed', `${ask.id}: ${detail}`),
        onUnknown: (role, agentId, error) => {
          unknown = true;
          this.store.event(task.id, 'agent_ask_delegation_unknown', `${ask.id}: ${role}${agentId ? ` ${agentId}` : ''}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
        },
        onUnavailable: planner => {
          unavailable = true;
          this.resolution.askOperatorDecision(task, ask, `Selected planner ${planner} cannot be asked on its host; the planner message is on the board.`);
        },
      });
    } catch (error) {
      if (!(error instanceof DelegatedHostUnavailable)) throw error;
      if (!this.store.eventsAll(task.id).some(event => event.kind === 'agent_ask_host_wait' && event.detail.startsWith(`${ask.id}:`)))
        this.store.event(task.id, 'agent_ask_host_wait', `${ask.id}: Waiting for the planner's proven host to be available`);
      return;
    }
    if (result?.reply.kind === 'answer') return recordAnswer(`${result.role} ${result.agentId}`, result.reply, result.role === 'planner' ? result.reply.overtakes : undefined);
    if (result?.reply.kind === 'operator') this.resolution.askOperatorDecision(task, ask, `${result.role === 'planner' ? 'Planner' : 'Decider'}'s one-line reason: ${result.reply.reason}`);
    else if (!unknown && !unavailable && !this.stopped()) this.store.event(task.id, 'agent_ask_delegation_missed', `${ask.id}: no planner or decider classification was produced; awaiting an explicit classification`);
  }

  /**
   * A worker ask reaches the retained reviewer mid-turn without a review round.
   * Its advice answers the question; an explicit planning classification opens
   * the planner rung. With no reviewer the ordinary planner route answers it.
   * A known miss advances; unknown delivery stays pending.
   */
  async routeReviewerAsk(task: Task, ask: AgentAskShape): Promise<void> {
    if (!task.hostId || !this.resolution.withHost(task.hostId, () => this.resolution.originHostAvailable(task.hostId))) return;
    return this.resolution.withHost(task.hostId, () => this.routeReviewerAskOnHost(task, ask));
  }
  private async routeReviewerAskOnHost(task: Task, ask: AgentAskShape): Promise<void> {
    const reviewer = this.resolution.delegatedDelivery(`ns-agent-ask-reviewer-${ask.id}`)?.recipient ?? task.resolution.reviewerAgentId;
    if (reviewer && !this.adapter.askReviewer) {
      this.store.event(task.id, 'agent_ask_delegation_missed', `${ask.id}: reviewer ${reviewer} delivery adapter unavailable; no planning ruling requested`);
      return;
    }
    if (reviewer && this.adapter.askReviewer) {
      // Only a positive terminal observation skips the window. Observation failures
      // retain the ordinary delivery and unknown-delivery fences.
      let gone = false;
      if (!this.resolution.delegatedDelivery(`ns-agent-ask-reviewer-${ask.id}`)) {
        try {
          const identity = this.adapter.originAgent ? await this.resolution.host.originAgent(reviewer) : undefined;
          gone = Boolean(identity?.archived);
          if (!gone) {
            const state = await this.resolution.host.observe(reviewer);
            gone = state.id === reviewer && state.status === 'closed';
          }
        } catch { /* preserve the ordinary route */ }
      }
      if (gone) {
        this.store.event(task.id, 'agent_ask_reviewer_missed', `${ask.id}: reviewer ${reviewer} is closed or archived`);
        return this.resolution.routeAgentAsk(task, { ...ask, target: 'planner' });
      }
      this.store.event(task.id, 'agent_ask_delegated', `${ask.id}: reviewer ${reviewer}; consult`);
      let text: string | null = null;
      try {
        text = await this.resolution.askBound(task, reviewer, { prompt: reviewerAskPrompt(ask.question, task.title, this.resolution.decisionContext(task)), signal: new AbortController().signal, timeoutMs: REVIEWER_CONSULT_TIMEOUT_MS, messageId: `ns-agent-ask-reviewer-${ask.id}`, sourceAgentId: ask.sourceAgentId }, 'reviewer');
      } catch (error) {
        if (this.stopped()) return;
        if (error instanceof DelegatedHostUnavailable) return;
        // A send that may have landed is unknown: never re-asked; the ask stays pending.
        this.store.event(task.id, 'agent_ask_delegation_unknown', `${ask.id}: reviewer ${reviewer}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
        return;
      }
      const advice = text?.trim();
      if (advice && /^Decision:\s*planner\b/im.test(advice)) {
        this.store.event(task.id, 'agent_ask_planning_ruling', `${ask.id}: reviewer ${reviewer}: ${advice.slice(0, 4000)}`);
      } else if (advice) {
        this.resolution.recordAgentAskAnswer(task.id, ask.id, `reviewer ${reviewer}`, advice.slice(0, 4000), '');
        return;
      } else {
        this.store.event(task.id, 'agent_ask_reviewer_missed', `${ask.id}: reviewer ${reviewer} gave no usable answer`);
      }
    }
    return this.resolution.routeAgentAsk(task, { ...ask, target: 'planner' });
  }
  recordAgentAskAnswer(taskId: string, askId: string, who: string, answer: string, reason: string, overtakes: string[] = []): void {
    if (this.store.eventsAll(taskId).some(event => event.kind === 'agent_ask_superseded' && event.detail.startsWith(`${askId}:`))) {
      this.store.event(taskId, 'agent_ask_stale_answered', `${askId}: answered by ${who}: ${answer}${reason ? ` — ${reason}` : ''}; no effect because the question was superseded`);
      this.resolution.notifyStaleQuestionAnswer(taskId, askId, who);
      return;
    }
    this.store.transaction(() => {
      this.store.event(taskId, 'agent_ask_answered', `${askId}: answered by ${who}: ${answer}${reason ? ` — ${reason}` : ''}`);
      const decisions = new Decisions(this.store);
      const reference = { kind: 'planner_answer' as const, id: taskId, sourceId: askId,
        label: `Answer by ${who}: ${answer}`.slice(0, 240), at: new Date().toISOString() };
      for (const id of [...new Set(overtakes)].slice(0, 100)) {
        try {
          decisions.markOvertaken(id, reference);
          this.store.event(taskId, 'agent_ask_overtakes', `${askId}: ${id}`);
        } catch (error) {
          this.store.event(taskId, 'agent_ask_overtakes_refused', `${askId}: ${id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000));
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
  notifyAskAnswered(taskId: string, askId: string, answer: string, who: string): void {
    try {
      const events = this.store.eventsAll(taskId);
      if (events.some(event => ['agent_ask_resumed', 'agent_ask_resume_intent'].includes(event.kind) && event.detail.startsWith(`${askId}:`))) return;
      const askEvent = events.find(event => event.kind === 'agent_ask' && event.detail.startsWith(`${askId}:`));
      const match = askEvent?.detail.match(/run (\S+) \([^)]+\); agent ([^;\s]+)/);
      const task = this.store.task(taskId);
      const run = match && this.store.runs(taskId).find(item => item.id === match[1]);
      const agentId = match?.[2] && match[2] !== 'unknown' ? match[2] : null;
      const hostId = run?.hostId ?? task.hostId;
      const owned = run ? run.agentId === agentId : task.runId === match?.[1] && task.agentId === agentId;
      if (!owned || !agentId || !hostId || (run?.hostId && task.hostId && run.hostId !== task.hostId)) return;
      if (!this.resolution.withHost(hostId, () => this.resolution.originHostAvailable(hostId) && Boolean(this.adapter.notify))) return;
      const text = `Your Nucleus question ${askId} was answered by ${who}: ${answer}. Continue the work with this answer.`;
      this.store.event(taskId, 'agent_ask_resume_intent', `${askId}: host ${hostId}; agent ${agentId}; run ${match![1]}`);
      void this.resolution.withHost(hostId, () => this.adapter.notify!(agentId, `ns-agent-ask-answered-${askId}`, text.slice(0, 4000)))
        .then(() => {
          if (!this.stopped() && !this.store.eventsAll(taskId).some(event => event.kind === 'agent_ask_resumed' && event.detail.startsWith(`${askId}:`)))
            this.store.event(taskId, 'agent_ask_resumed', `${askId}: resumed ${agentId}; answered by ${who}`);
        })
        .catch(() => { /* delivery is unknown; the intent prevents a resend */ });
    } catch { /* a read failure never blocks the recorded answer */ }
  }
  /**
   * Task 562: settle pending joined asks whose Queue-raised question answered
   * after the in-turn wait returned. The polling waiter copies the join only
   * while it is still waiting; this sweep copies it after, so a pending ask
   * still collects its answer and resumes without another call.
   */
  resumePendingAskAnswers(taskId?: string): void {
    const tasks = taskId ? [this.store.task(taskId)] : this.store.maintenanceTasks(true).map(candidate => this.store.task(candidate.id));
    for (const task of tasks) {
      let events = this.store.eventsAll(task.id);
      for (const ask of events.filter(event => event.kind === 'agent_ask')) {
        const askId = ask.detail.split(':')[0]!;
        if (events.some(event => (event.kind === 'agent_ask_answered' || event.kind === 'agent_ask_superseded') && event.detail.startsWith(`${askId}:`))) continue;
        const join = events.find(event => event.kind === 'agent_ask_joined' && event.detail.startsWith(`${askId}: queue question `));
        const joined = join?.detail.slice(`${askId}: queue question `.length).trim() || null;
        if (!joined) continue;
        const settled = events.find(event =>
          (event.kind === 'operator_question_answered' || event.kind === 'responsible_question_answered')
          && event.detail.startsWith(`${joined}:`));
        if (!settled) continue;
        const answer = queueAnswerText(settled.detail), who = queueAnswerWho(settled.detail);
        if (!this.store.eventsAll(task.id).some(event => event.kind === 'agent_ask_answered' && event.detail.startsWith(`${askId}:`)))
          this.store.event(task.id, 'agent_ask_answered', `${askId}: answered by ${who}: ${answer}`);
        this.resolution.notifyAskAnswered(task.id, askId, answer, who);
        events = this.store.eventsAll(task.id);
      }
      for (const answered of this.store.eventsAll(task.id).filter(event => event.kind === 'agent_ask_answered')) {
        const askId = answered.detail.split(':')[0]!;
        const parsed = parseAgentAskAnswer(answered.detail);
        if (!parsed) continue;
        if (this.store.eventsAll(task.id).some(event => event.kind === 'agent_ask_resumed' && event.detail.startsWith(`${askId}:`))) continue;
        // An in-turn waiter still polling collects the answer itself; the sweep
        // only resumes asks whose waiter already returned pending. A waiter that
        // returned pending left no resumed marker, so an unresumed answer older
        // than the in-turn wait is a pending answer that still needs its resume.
        const askEvent = this.store.eventsAll(task.id).find(event => event.kind === 'agent_ask' && event.detail.startsWith(`${askId}:`));
        if (!askEvent) continue;
        if (Date.now() - Date.parse(askEvent.at) < this.agentAskWaitMs) continue;
        this.resolution.notifyAskAnswered(task.id, askId, parsed.answer, parsed.who);
      }
    }
  }
  /** The Spec 032 decision an operator-only ask waits on; created once, linked durably. */
  askOperatorDecision(task: Task, ask: AgentAskShape, why: string): void {
    const events = this.store.eventsAll(task.id);
    if (events.some(event => event.kind === 'agent_ask_decision' && event.detail.startsWith(`${ask.id}: decision `))) return;
    this.store.transaction(() => {
      const view = new Decisions(this.store).add({
        question: ask.question,
        headline: ask.headline,
        choices: ask.choiceDetails,
        recommended: ask.recommended ?? ask.choices[0],
        details: [ask.details, ask.question.length > 140 ? `Full question: ${ask.question}` : null,
          why,
          ask.recommended ? `Recommended answer: ${ask.recommended}` : null,
          `Question context: nucleus_ask ${ask.id} (kind hint ${ask.kind}) from this task's own run`,
          this.resolution.decisionContext(task)].filter(Boolean).join("\n\n").slice(0, 48000),
        context: `nucleus_ask ${ask.id} (kind hint ${ask.kind}) from this task's own run; delegate classified it as operator-only: ${why}`.slice(0, 4000),
        options: ask.choices,
        askedBy: task.agentId ?? 'nucleus',
        tasks: [task.id],
        by: 'nucleus',
    });
    this.store.event(task.id, 'agent_ask_decision', `${ask.id}: decision ${view.id}; ${why}`.slice(0, 4000));
    });
  }
  /** The bounded in-turn wait for one ask's durable answer; afterwards the tool returns pending and the answer resumes the agent. */
  async awaitAgentAsk(taskId: string, askId: string, joined: string | null): Promise<AgentAskReceipt> {
    const deadline = Date.now() + this.agentAskWaitMs;
    for (;;) {
      const answered = this.resolution.recordedAnswer(taskId, askId);
      if (answered) return answered;
      if (joined) {
        const settled = this.store.eventsAll(taskId).find(event =>
          (event.kind === 'operator_question_answered' || event.kind === 'responsible_question_answered')
          && event.detail.startsWith(`${joined}:`));
        if (settled) {
          const answer = queueAnswerText(settled.detail), who = queueAnswerWho(settled.detail);
          if (!this.resolution.recordedAnswer(taskId, askId)) this.store.event(taskId, 'agent_ask_answered', `${askId}: answered by ${who}: ${answer}`);
          return { status: 'answered', askId, answer, answeredBy: who };
        }
      }
      if (Date.now() >= deadline || this.stopped()) return { status: 'pending', askId, detail: this.resolution.agentAskPendingDetail(taskId, askId) };
      await new Promise(resolve => setTimeout(resolve, this.agentAskPollMs));
    }
  }
  /** Where a pending ask sits: the tool's pending result names its id and who holds it, and promises a resume. */
  agentAskPendingDetail(taskId: string, askId: string): string {
    const events = this.store.eventsAll(taskId);
    const linked = (prefix: string, kind: string) => events.find(event => event.kind === kind && event.detail.startsWith(`${prefix}: `))?.detail.slice(prefix.length + 2) ?? '';
    const joined = linked(askId, 'agent_ask_joined').match(/queue question (\S+)/)?.[1];
    const decision = linked(askId, 'agent_ask_decision').match(/decision (\S+)/)?.[1]
      ?? (joined ? linked(joined, 'operator_question_decision').match(/decision (\S+)/)?.[1] : undefined);
    const deciderStarted = events.some(event => event.kind === 'agent_ask_delegated' && event.detail.startsWith(`${askId}: decider`));
    const planner = events.find(event => event.kind === 'agent_ask_delegated' && event.detail.startsWith(`${askId}: planner `))?.detail.match(/planner (\S+);/)?.[1];
    const reviewer = events.find(event => event.kind === 'agent_ask_delegated' && event.detail.startsWith(`${askId}: reviewer `))?.detail.match(/reviewer (\S+);/)?.[1];
    if (!planner && !reviewer && events.some(event => event.kind === 'agent_ask_host_wait' && event.detail.startsWith(`${askId}:`)))
      return `Recorded as question ${askId}; waiting for the planner's proven host to be available. You may continue other work or call again to collect the answer.`;
    if (planner && !deciderStarted && events.some(event => event.kind === 'agent_ask_delegation_unknown' && event.detail.startsWith(`${askId}:`)))
      return `Recorded as question ${askId}; delivery to planner ${planner} is uncertain. Nucleus will not re-ask or start a decider. The question remains with the planner.`;
    const holder = decision ? `Tom as Nucleus operator decision ${decision}` : deciderStarted ? 'a decider' : planner ? `planner ${planner}` : reviewer ? `reviewer ${reviewer}` : 'the project planner or a decider';
    return `Recorded as question ${askId}; pending with ${holder}. You'll be resumed with the answer. You may continue other work or end your turn, and call your session's question tool again with the same question to collect the answer.`;
  }
}
