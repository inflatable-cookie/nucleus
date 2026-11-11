import { randomBytes } from 'node:crypto';
import type { Profile, Task } from '../../shared/contracts';
import { awaitingProofTexts, isOperatorOrigin, taskPlanner, taskOwner } from '../../shared/contracts';
import { sameCallerIdentity } from '../../shared/agent-identity';
import { normalizeRepositoryOrigin } from '../../shared/lanes';
import { groupIsUnavailable } from '../../shared/pool';
import { currentBrief } from '../planning/brief';
import { parseNativeDelegatedReply } from './question-delegation';
import type { Resolution } from '../resolution';
import { chooseProfile } from '../dispatch/routing';
import { plannerParticipantTicketPath } from '../dispatch/participant-tickets';
import { runTicketPath, writeRunTicket } from '../dispatch/agent-creation';
import { formatAgentId, nativeAgentId, parseAgentId, qualifyLegacyAgentId } from '../../shared/agent-identity';

/** The selection failed before an intent or host call was made. */
export class DelegatedHostUnavailable extends Error {}

/** Which planner rung a question is on: the task's own planner, or the project's. */
export type PlannerRungName = 'task' | 'project';

/** One planner rung, with the message window its question travels on. */
export interface PlannerRung {
  agentId: string;
  rung: PlannerRungName;
}

/** One question to one delegate, under an answer window, on the `delegation:<id>` stream. */
export class Delegation {
  constructor(readonly resolution: Resolution) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  get profiles() { return this.resolution.profiles; }
  get stopped() { return this.resolution.stopped; }
  get delegatedAnswerWaitMs() { return this.resolution.delegatedAnswerWaitMs; }

  /**
   * Name a replacement `question.answer` identity for the recipient. Helper-reporting
   * hosts re-issue the latest run ticket. MCP hosts with a recipient run do the same
   * so ticket-first CLI does not inherit a purged launch ticket; MCP hosts without a
   * run on this task clear `NUCLEUS_TICKET` so the host identity answers. Runs match
   * proven host and native identity, so a Paseo planner cannot inherit a T3 worker
   * ticket that shares the native id. Complete and ask keep refusing the released run.
   */
  private consultTicketRoute(task: Task, recipient: string, provenHost?: string): { kind: 'ticket'; helperPath: string; ticketPath: string } | { kind: 'participant'; ticketPath: string } | { kind: 'clear' } | undefined {
    if (!this.adapter.helperPath || !this.adapter.socketPath) return;
    const runs = provenHost
      ? this.store.runs(task.id).filter(run => run.agentId === recipient && run.hostId === provenHost)
      : [];
    const run = runs.find(candidate => !candidate.released && !candidate.completion) ?? runs.at(-1);
    if (!run) {
      const participant = plannerParticipantTicketPath(this.store, recipient, provenHost);
      if (participant) return { kind: 'participant', ticketPath: participant };
      if (this.adapter.reportingViaMcp === false) throw Error('Consult requires the recipient run ticket');
      return { kind: 'clear' };
    }
    const token = randomBytes(32).toString('hex');
    this.store.setCredential(run.id, token);
    const paths = { helperPath: this.adapter.helperPath, socketPath: this.adapter.socketPath };
    writeRunTicket(paths, task, run, token);
    return { kind: 'ticket', helperPath: paths.helperPath, ticketPath: runTicketPath(paths, run.id) };
  }
  private quote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
  async requireHost(task: Task, recipient: string, role: 'planner' | 'reviewer'): Promise<string> {
    const recorded = role === 'reviewer' ? task.hostId
      : recipient === task.originAgentId || recipient === task.notificationAgentId ? task.originHostId
      : undefined;
    const host = recorded ?? await this.resolution.identifyOriginHost(recipient);
    const settled = await this.hostThroughBridge(host, recorded ? undefined : () => this.resolution.identifyOriginHost(recipient));
    if (!settled || !this.resolution.withHost(settled, () => this.resolution.originHostAvailable(settled)))
      throw new DelegatedHostUnavailable('Delegated recipient host is unavailable or unknown');
    return settled;
  }

  /**
   * A host-dependent call arriving just after a service roll waits, bounded,
   * for the plugin bridge to answer again instead of refusing as unavailable
   * (roll-recovery contract): only a bridge still unavailable after the bound
   * refuses, and the re-check reads live availability, never the wait's own
   * answer. A recorded host is re-checked as is; an identified one is
   * identified again, because the roll window is exactly when inventories
   * answer ambiguously.
   */
  private async hostThroughBridge(host: string | undefined, reidentify?: () => Promise<string | undefined>): Promise<string | undefined> {
    const available = () => Boolean(host && this.resolution.withHost(host, () => this.resolution.originHostAvailable(host)));
    if (available()) return host;
    if (!this.resolution.awaitHostBridge) return host;
    await this.resolution.awaitHostBridge(this.resolution.hostBridgeWaitMs);
    return reidentify ? await reidentify() : host;
  }

  delegatePrompt(task: Task, id: string, prompt: string, recipient?: string, hostId?: string): string {
    const json = JSON.stringify({ questionId: id, answer: '<answer or exact choice>', reason: '<one line>' });
    const provenHost = hostId ?? this.delegatedDelivery(id)?.hostId;
    const route = recipient ? this.consultTicketRoute(task, recipient, provenHost) : undefined;
    const command = route?.kind === 'ticket' || route?.kind === 'participant'
      ? `NUCLEUS_TICKET=${this.quote(route.ticketPath)} nucleus question.answer -`
      : route?.kind === 'clear'
        ? 'NUCLEUS_TICKET= nucleus question.answer -'
        : 'nucleus question.answer -';
    const helper = route?.kind === 'ticket' && this.adapter.reportingViaMcp === false
      ? `\nOn a host without per-thread MCP, the packaged nucleus helper with this run's ticket is the same command:\nnode ${this.quote(route.helperPath)} ${this.quote(route.ticketPath)} answer <<'JSON'\n${json}\nJSON`
      : '';
    return `Task: ${task.reference ?? task.id} — ${task.title}\nQuestion id: ${id}\n${prompt}\nAnswer with this command; write nothing else in this thread. For operator-only matters set "decision":"operator" instead of answer.\n${command} <<'JSON'\n${json}\nJSON${helper}`;
  }
  openDelegatedQuestion(task: Task, id: string, recipient: string, prompt: string, timeoutMs: number, role: string, hostId?: string, rung?: PlannerRungName): void {
    const qualified = parseAgentId(recipient);
    if (qualified && hostId && qualified.hostId !== hostId) throw Error('Delegated recipient belongs to a different host');
    recipient = qualified?.nativeAgentId ?? recipient;
    this.store.event(`delegation:${id}`, 'delegated_delivery', JSON.stringify({ taskId: task.id, recipient, role, prompt,
      ...(hostId ? { hostId, recipientRef: qualifyLegacyAgentId(recipient, hostId) } : {}),
      ...(rung ? { rung } : {}),
      deadline: Date.now() + Math.min(timeoutMs, this.delegatedAnswerWaitMs) }));
  }
  /** A restart may resume observation, never delivery. Unknown sends remain fenced. */
  delegatedDelivery(id: string): { taskId: string; recipient: string; role: string; deadline: number; hostId?: string; recipientRef?: string; rung?: PlannerRungName } | null {
    const event = this.store.eventsAll(`delegation:${id}`).findLast(event => event.kind === 'delegated_delivery');
    return event ? JSON.parse(event.detail) : null;
  }
  /** A task target is safe only when it selects one live question for this recipient. */
  questionForTask(identity: string, caller: string): string {
    const taskId=this.store.resolveTaskId(identity);
    this.store.task(taskId);
    const identityCaller = parseAgentId(caller);
    const nativeCaller = identityCaller?.nativeAgentId ?? caller;
    const rows=this.store.db.prepare("SELECT DISTINCT taskId FROM events WHERE kind='delegated_delivery' AND json_extract(detail,'$.taskId')=?").all(taskId);
    const ids=rows.map(row=>String(row.taskId).replace(/^delegation:/,''))
      .filter(id=>{
        const delivery=this.delegatedDelivery(id);
        const events=this.store.eventsAll(`delegation:${id}`);
        return delivery && (delivery.recipient===nativeCaller || delivery.recipient===caller)
          && (!identityCaller || delivery.hostId===identityCaller.hostId) && delivery.deadline>=Date.now()
          &&!events.some(event=>['delegated_answer','delegated_closed'].includes(event.kind));
      });
    if(ids.length!==1)throw Error(ids.length?'More than one open question for this task and caller; pass questionId':'No open question for this task and caller; pass questionId to inspect an existing answer');
    return ids[0]!;
  }
  /** A raw caller name cannot identify a host when inventories are ambiguous. */
  async answerFromHost(input: { questionId: string; answer?: string; choice?: string; reason: string; decision?: 'operator'; overtakes?: string[] }, caller: string) {
    const delivery = this.delegatedDelivery(input.questionId);
    const qualified = parseAgentId(caller);
    const nativeCaller = qualified?.nativeAgentId ?? caller;
    if (!delivery || ![nativeCaller, caller].includes(delivery.recipient)) throw Error('Only the delegated recipient thread may answer this question');
    const identify = () => qualified ? Promise.resolve(qualified.hostId) : this.resolution.identifyOriginHost(caller);
    const observedHost = await this.hostThroughBridge(await identify(), identify);
    if (!observedHost || !this.resolution.withHost(observedHost, () => this.resolution.originHostAvailable(observedHost)))
      throw new DelegatedHostUnavailable('Delegated answer host is unavailable or ambiguous');
    const known = this.store.getMeta<Array<{ id: string }>>('hostRegistry') ?? [];
    const recordedHost = delivery.hostId ?? (known.length === 1 ? known[0]?.id : undefined);
    if (!recordedHost || recordedHost !== observedHost) throw new DelegatedHostUnavailable('Delegated answer host is not proven');
    if (delivery.recipientRef && nativeAgentId(delivery.recipientRef, recordedHost) !== nativeCaller)
      throw Error('Delegated recipient identity conflicts with its recorded host');
    if (JSON.stringify(this.delegatedDelivery(input.questionId)) !== JSON.stringify(delivery))
      throw Error('Delegated recipient changed during host verification');
    return this.answerDelegatedQuestion(input, qualified ? caller : nativeCaller);
  }
  /** Ordered windows: an observed miss advances to an unstarted next delegate; unknown sends never do. */
  recoverableDelegation(ids: string[], advance = true): boolean {
    const windows = ids.map(id => {
      const events = this.store.eventsAll(`delegation:${id}`);
      return { delivered: events.some(event => event.kind === 'delegated_delivery'),
        answered: events.some(event => event.kind === 'delegated_answer'),
        closed: events.findLast(event => event.kind === 'delegated_closed') };
    });
    return windows.some((window, index) => window.answered || (window.delivered && !window.closed)
      || (advance && window.delivered && window.closed?.detail === 'No command answer in the window'
        && index < windows.length - 1 && windows.slice(index + 1).every(next => !next.delivered)));
  }
  /**
   * Ticket-bound `question.answer`: authenticate the recipient run, then record
   * the receipt as that run's agent on its proven host. Released reviewer runs
   * may still answer; `askBinding`'s current-run gate does not apply.
   */
  answerDelegatedQuestionFromTicket(input: { taskId: string; runId: string; questionId: string; answer?: string; choice?: string; reason: string; decision?: 'operator'; overtakes?: string[] }, token: string) {
    this.store.authenticate(input.runId, token);
    const run = this.store.run(input.runId);
    const task = this.store.task(input.taskId);
    if (run ? run.taskId !== task.id : task.runId !== input.runId) throw Error('Stale report: task and run identity do not match');
    const caller = run?.agentId ?? task.agentId;
    if (!caller) throw Error('No agent bound to this reporting run');
    const delivery = this.delegatedDelivery(input.questionId);
    if (!delivery) throw Error('No delegated question with this id');
    if (delivery.taskId !== task.id) throw Error('Stale report: task and run identity do not match');
    const known = this.store.getMeta<Array<{ id: string }>>('hostRegistry') ?? [];
    const recordedHost = delivery.hostId ?? (known.length === 1 ? known[0]?.id : undefined);
    const runHost = run?.hostId ?? task.hostId;
    if (!recordedHost || !runHost || recordedHost !== runHost) throw new DelegatedHostUnavailable('Delegated answer host is not proven');
    if (delivery.recipient !== caller) throw Error('Only the delegated recipient thread may answer this question');
    if (delivery.recipientRef && nativeAgentId(delivery.recipientRef, recordedHost) !== caller)
      throw Error('Delegated recipient identity conflicts with its recorded host');
    return this.answerDelegatedQuestion({
      questionId: input.questionId, answer: input.answer, choice: input.choice, reason: input.reason,
      decision: input.decision, overtakes: input.overtakes,
    }, formatAgentId(runHost, caller));
  }
  answerDelegatedQuestion(input: { questionId: string; answer?: string; choice?: string; reason: string; decision?: 'operator'; overtakes?: string[] }, caller: string) {
    const key = `delegation:${input.questionId}`;
    const events = this.store.eventsAll(key);
    const delivery = events.findLast(event => event.kind === 'delegated_delivery');
    if (!delivery) throw Error('No delegated question with this id');
    const authority = JSON.parse(delivery.detail) as { taskId: string; recipient: string; role: string; prompt: string; deadline: number; hostId?: string };
    const qualified = parseAgentId(caller);
    const recordedHost = authority.hostId ?? (this.store.getMeta<Array<{ id: string }>>('hostRegistry')?.length === 1 ? this.store.getMeta<Array<{ id: string }>>('hostRegistry')?.[0]?.id : undefined);
    if (!caller || ![caller, qualified?.nativeAgentId].includes(authority.recipient) || (qualified && qualified.hostId !== recordedHost)) throw Error('Only the delegated recipient thread may answer this question');
    const recorded = events.find(event => event.kind === 'delegated_answer');
    if (recorded) return JSON.parse(recorded.detail);
    if (events.some(event => event.kind === 'delegated_closed') || Date.now() > authority.deadline) throw Error('This delegated answer window has closed');
    const answer = (input.answer ?? input.choice)?.trim();
    const reason = input.reason?.trim();
    if (!reason || /[\r\n]/.test(reason) || reason.length > 500) throw Error('A one-line reason is required (up to 500 characters)');
    if (input.decision !== 'operator' && (!answer || answer.length > 4000 || /[\r\n]/.test(answer))) throw Error('An answer or choice is required (one line, up to 4000 characters)');
    const choices = authority.prompt.split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2));
    if (input.decision !== 'operator' && choices.length && (input.choice || input.questionId.startsWith('queue-delegate-')) && !choices.includes(answer!)) throw Error('Choice must match an offered choice');
    const receipt = { questionId: input.questionId, caller, answer, reason, ...(input.decision ? { decision: input.decision } : {}),
      ...(authority.role === 'planner' && input.overtakes?.length ? { overtakes: [...new Set(input.overtakes)].slice(0, 100) } : {}) };
    this.store.event(key, 'delegated_answer', JSON.stringify(receipt));
    this.store.event(authority.taskId, 'delegated_command_answered', `${input.questionId}: ${caller}`);
    return receipt;
  }
  async waitDelegatedAnswer(id: string, signal: AbortSignal): Promise<string | null> {
    const key = `delegation:${id}`;
    while (true) {
      const events = this.store.eventsAll(key);
      const receipt = events.find(event => event.kind === 'delegated_answer');
      if (receipt) {
        const value = JSON.parse(receipt.detail) as { answer?: string; reason: string; decision?: string; overtakes?: string[] };
        // Existing route parsers consume this serialization of structured command input only.
        return [value.decision === 'operator' ? 'Decision: operator' : `Answer: ${value.answer}\nChoice: ${value.answer}`,
          `Reason: ${value.reason}`, ...(value.overtakes ? [`Overtakes: ${value.overtakes.join(',')}`] : [])].join('\n');
      }
      const delivery = events.findLast(event => event.kind === 'delegated_delivery');
      if (this.stopped()) throw Error('Delegated observation stopped; retain the delivery and answer window');
      if (events.some(event => event.kind === 'delegated_closed')) return null;
      if (signal.aborted || !delivery || Date.now() >= JSON.parse(delivery.detail).deadline) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(100, this.delegatedAnswerWaitMs)));
    }
    this.store.event(key, 'delegated_closed', 'No command answer in the window');
    return null;
  }
  async askBound(task: Task, recipient: string, input: { prompt: string; signal: AbortSignal; timeoutMs: number; messageId: string; sourceAgentId?: string; onIntent?: () => void; rung?: PlannerRungName }, role: 'planner' | 'reviewer'): Promise<string | null> {
    const existing = this.resolution.delegatedDelivery(input.messageId);
    const hostId = existing ? undefined : await this.requireHost(task, recipient, role);
    if (!existing && !this.resolution.withHost(hostId!, () => role === 'planner' ? this.adapter.askPlanner : this.adapter.askReviewer)) return null;
    if (!existing) {
      // Task 1109: a planner on a host without per-thread identity needs its ticket
      // before the question names it. Issuance is a convenience for the answer; a
      // failed delivery keeps the question on its ordinary host identity.
      if (role === 'planner') await this.resolution.ensurePlannerTicket?.(recipient, hostId!).catch(() => {});
      this.openDelegatedQuestion(task, input.messageId, recipient, input.prompt, input.timeoutMs, role, hostId, input.rung);
      input.onIntent?.();
    }
    try {
      if (!existing) {
        await this.resolution.withHost(hostId!, () => {
          const send = role === 'planner' ? this.adapter.askPlanner : this.adapter.askReviewer;
          if (!send) throw Error('Host cannot send delegated questions');
          const recorded = this.store.eventsAll(`delegation:${input.messageId}`).findLast(event => event.kind === 'delegated_delivery');
          const ref = recorded && (JSON.parse(recorded.detail) as { recipientRef?: string }).recipientRef;
          if (!ref) throw Error('Delegated recipient identity was not recorded');
          const recipient = nativeAgentId(ref, hostId!);
          const { onIntent: _onIntent, ...sendInput } = input;
          return send.call(this.adapter, recipient, { ...sendInput, sourceAgentId: task.hostId === hostId ? input.sourceAgentId ?? task.agentId ?? undefined : undefined, prompt: this.resolution.delegatePrompt(task, input.messageId, input.prompt, recipient, hostId) });
        });
        if (this.stopped()) throw Error('Delegated observation stopped; retain the delivery and answer window');
        this.store.event(`delegation:${input.messageId}`, 'delegated_sent', 'Host send completed');
      }
      const text = await this.resolution.waitDelegatedAnswer(input.messageId, input.signal);
      // An intent surviving a restart proves neither delivery nor a known miss.
      // An authenticated receipt is sufficient; otherwise only an observed send
      // can turn the expired answer window into permission to advance.
      if (!text && existing && !this.store.eventsAll(`delegation:${input.messageId}`).some(event => event.kind === 'delegated_sent'))
        throw Error('Previous delegate delivery was not observed; never resend');
      if (role === 'reviewer' && text) return parseNativeDelegatedReply(text)?.kind === 'answer' ? (parseNativeDelegatedReply(text) as { answer: string }).answer : null;
      return text;
    } catch (error) {
      if (this.stopped()) throw error;
      if (this.store.eventsAll(`delegation:${input.messageId}`).some(event => event.kind === 'delegated_answer')) {
        const text = await this.resolution.waitDelegatedAnswer(input.messageId, input.signal);
        const reply = role === 'reviewer' ? parseNativeDelegatedReply(text) : null;
        return role === 'reviewer' ? (reply?.kind === 'answer' ? reply.answer : null) : text;
      }
      this.store.event(`delegation:${input.messageId}`, 'delegated_closed', 'Delivery outcome unknown; never resend');
      throw error;
    }
  }
  async deciderBound(task: Task, input: { prompt: string; profile: Profile | null; signal: AbortSignal; timeoutMs: number; decisionId: string; sourceAgentId?: string }): Promise<{ agentId: string; text: string | null }> {
    const id = `ns-decider-${input.decisionId}`;
    const existing = this.resolution.delegatedDelivery(id);
    if (existing) return { agentId: existing.recipient, text: await this.resolution.waitDelegatedAnswer(id, input.signal) };
    if (!input.profile) throw Error('No eligible decider profile');
    if (!task.hostId || !this.resolution.withHost(task.hostId, () => this.resolution.originHostAvailable(task.hostId)))
      throw new DelegatedHostUnavailable('Decider host is unavailable or unknown');
    const created = await this.resolution.withHost(task.hostId, () => this.adapter.runDecider!(task, { profile: input.profile!, signal: input.signal, timeoutMs: input.timeoutMs, decisionId: input.decisionId }));
    this.resolution.openDelegatedQuestion(task, id, created.agentId, input.prompt, input.timeoutMs, 'decider', task.hostId);
    try {
      await this.resolution.withHost(task.hostId, () => this.adapter.askPlanner!(created.agentId, { ...input, sourceAgentId: input.sourceAgentId ?? task.agentId ?? undefined, messageId: id, prompt: this.resolution.delegatePrompt(task, id, input.prompt, created.agentId, task.hostId) }));
      return { agentId: created.agentId, text: await this.resolution.waitDelegatedAnswer(id, input.signal) };
    } catch (error) {
      if (this.stopped()) throw error;
      if (this.store.eventsAll(`delegation:${id}`).some(event => event.kind === 'delegated_answer'))
        return { agentId: created.agentId, text: await this.resolution.waitDelegatedAnswer(id, input.signal) };
      this.store.event(`delegation:${id}`, 'delegated_closed', 'Delivery outcome unknown; never resend');
      await this.resolution.withHost(task.hostId, () => this.resolution.host.archiveAgent(created.agentId)).catch(() => {});
      throw error;
    }
  }
  /**
   * Task 1109 (Tom, 2026-11-11): a task's own planner first — the thread a brief
   * named, else its owner, the thread that submitted or promoted it. It is skipped
   * at once when observed archived or gone, never cleared: the owner record still
   * routes the task's origin notices.
   */
  async taskPlannerFor(task: Task): Promise<PlannerRung | null> {
    const planner = taskPlanner(task);
    if (!planner || isOperatorOrigin(planner) || await this.resolution.plannerThreadGone(planner)) return null;
    return { agentId: planner, rung: 'task' };
  }

  /**
   * The planner rungs one task's questions climb, in order: its own planner, then
   * the project's planner when that is a different thread (Tom, 2026-11-11). A rung
   * observed archived or gone is skipped here; a silent rung still times out in
   * `delegateQuestion`, and the decider follows the rungs.
   */
  async plannerRungsFor(task: Task): Promise<{ rungs: PlannerRung[]; projectFailed: boolean }> {
    const rungs: PlannerRung[] = [];
    const own = await this.taskPlannerFor(task);
    if (own) rungs.push(own);
    const { planner, failed } = await this.projectPlannerFor(task);
    if (planner && !rungs.some(rung => sameCallerIdentity(rung.agentId, planner))) rungs.push({ agentId: planner, rung: 'project' });
    return { rungs, projectFailed: failed };
  }

  /**
   * The one lookup every delegated route uses for the planner rung (Tom, 2026-11-06). A missing or archived
   * registered planner becomes a visible project gap and routes to Queue's planner; with no live planner at
   * all the result is null, so the route goes straight to its next rung instead of waiting on nobody. A closed
   * thread stays registered and still receives the question.
   */
  async projectPlannerFor(task: Task): Promise<{ planner: string | null; failed: boolean }> {
    const project = this.store.projectFor(task.repoPath, normalizeRepositoryOrigin(task.repository ?? ''));
    const missing = project?.planner?.agentId ?? null;
    if (project && missing) {
      if (!await this.resolution.plannerThreadGone(missing)) return { planner: missing, failed: false };
      this.store.setProjectPlanner({ key: project.key, agentId: null, setBy: 'Queue',
        note: `Planner ${missing} is missing or archived; delegated questions fall back to the Nucleus planner` });
    }
    const queuePlanner = this.store.queueProject()?.planner?.agentId ?? null;
    const planner = queuePlanner && !await this.resolution.plannerThreadGone(queuePlanner) ? queuePlanner : null;
    if (!project || !missing) return { planner, failed: false };
    const notices = this.store.eventsAll(`project:${project.key}`);
    if (planner && !notices.some(event => event.kind === 'project_planner_missing_notified' && event.detail.startsWith(`${missing}:`))) {
      const host = await this.resolution.identifyOriginHost(planner);
      if (host && this.resolution.withHost(host, () => this.resolution.originHostAvailable(host))) {
        this.store.event(`project:${project.key}`, 'project_planner_missing_notified', `${missing}: notifying Nucleus planner ${planner} on host ${host}`);
        await this.resolution.withHost(host, async () => {
          if (this.adapter.notify) try {
            await this.resolution.host.sendMessage(planner, { messageId: `ns-project-planner-missing-${project.key}`,
              text: `Project ${project.name} has no live planner (${missing} is missing or archived). Nucleus is routing its delegated questions here until a live project planner is registered.` });
          } catch { /* the durable notice record prevents repeated notifications */ }
        });
      }
    }
    return { planner, failed: true };
  }
  /** The profile a decider runs on: automatic selection, the cheapest eligible coordinator-class route. */
  deciderProfile(task: Task): Profile | null {
    const unavailable = new Set(this.store.db.prepare('SELECT data FROM availability').all().flatMap(row => {
      const state = JSON.parse(String(row.data));
      return groupIsUnavailable(state) ? [state.group as string] : [];
    }));
    const profiles = this.profiles().filter(profile => profile.model !== 'default');
    return chooseProfile({ ...task, preferredProfileId: '', requirePreferred: false, thinkingOptionId: '' }, profiles, this.store.pool(),
      this.store.counts(), unavailable, 'coordinator', this.store.recentCounts(), this.store.usageLevel(), this.store.demandRoleOffsets())?.profile ?? null;
  }
  /** The task facts a delegate reads: its title, stop, head, brief and latest review. Bounded. */
  decisionContext(task: Task): string[] {
    const clip = (text: string | null | undefined, max: number) => (text ?? '').trim().replace(/\s+/g, ' ').slice(0, max) || 'none';
    const review = task.resolution.review;
    return [
      `Task: ${task.title} (${task.id})`,
      `Stop: ${task.resolution.stop?.reason ?? 'none'} — ${clip(task.resolution.stop?.detail, 600)}`,
      `PR head: ${task.prHead ?? 'none'}`,
      `Brief: ${clip(currentBrief(task)?.text, 3000)}`,
      `Latest review at ${review?.head ?? 'none'}: source ${review?.sourceApproved ? 'approved' : 'not approved'}; awaiting proofs: ${awaitingProofTexts(review?.awaitingProofs ?? []).join('; ') || 'none'}`,
      `Review: ${clip(review?.reviewText ?? review?.summary, 2000)}`,
    ];
  }
}
