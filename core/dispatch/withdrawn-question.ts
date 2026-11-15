import type { Task } from '../../shared/contracts';
import type { Adapter } from '../host/adapter';
import type { Resolution } from '../resolution';

/**
 * The withdrawn-native-question settlement dispatch runs before a role's lease
 * (papercut ee9fc161). A native question Nucleus withdrew (extension, answer,
 * supersession) must not hold a launch: this owner finds the withdrawn request
 * still pending on a retained thread and sends exactly the host call that
 * settles that kind — a dismiss for a question, a cancel for a permission —
 * recording a resolving wait only when it actually sent one.
 *
 * Its own module because it is the one place that reads the task's question
 * events, matches a host request to them, and records the settle: the lease
 * reads liveness, not question history.
 */
export class WithdrawnQuestion {
  constructor(readonly resolution: Resolution) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }

  /**
   * Resolve a stale pending Nucleus question found at dispatch (papercut ee9fc161).
   * When a native question is withdrawn (extension, answer, supersession),
   * Nucleus resolves the host's pending permission or question on that thread
   * as a durable effect, and dispatch never waits on a question Nucleus has
   * withdrawn. Returns true when a withdrawn request was found pending and a
   * dismiss or cancel was sent; the caller records a short resolving wait and
   * the next pass launches once the host clears it. Tool and bash permissions
   * unrelated to a withdrawn question are never touched.
   */
/**
   * Resolve a stale pending Nucleus question found at dispatch (papercut ee9fc161).
   * When a native question is withdrawn (extension, answer, supersession),
   * Nucleus resolves the host's pending permission or question on that thread
   * as a durable effect, and dispatch never waits on a question Nucleus has
   * withdrawn. Returns true when a withdrawn request was found pending and a
   * dismiss or cancel was sent; the caller records a short resolving wait and
   * the next pass launches once the host clears it. Tool and bash permissions
   * unrelated to a withdrawn question are never touched.
   */
  async resolve(t: Task, hint?: { agentId: string; state: Awaited<ReturnType<Adapter['observe']>> }): Promise<boolean> {
    const events = this.store.eventsAll(t.id);
    const withdrawn = new Set<string>();
    for (const event of events) {
      if (event.kind === 'operator_question_superseded' || event.kind === 'native_question_dismiss_intent'
        || event.kind === 'responsible_question_superseded' || event.kind === 'agent_ask_superseded') {
        const id = event.detail.split(':')[0]!;
        if (id) withdrawn.add(id);
      }
    }
    if (!withdrawn.size) return false;
    const recordedRequests = new Map<string, string>();
    for (const event of events) {
      if (event.kind !== 'operator_question_native_request') continue;
      const id = event.detail.split(':')[0]!;
      if (!withdrawn.has(id)) continue;
      const requestId = event.detail.match(/request (\S+)/)?.[1];
      if (requestId && !recordedRequests.has(requestId)) recordedRequests.set(requestId, id);
    }
    const candidates: Array<{ agentId: string; workspaceId: string; state: Awaited<ReturnType<Adapter['observe']>> | null }> = [];
    if (hint) candidates.push({ agentId: hint.agentId, workspaceId: t.workspaceId ?? hint.state.workspaceId ?? '', state: hint.state });
    else {
      const seen = new Set<string>();
      const add = (agentId: string | null | undefined, workspaceId: string | null | undefined) => {
        if (!agentId || seen.has(agentId)) return;
        seen.add(agentId);
        candidates.push({ agentId, workspaceId: workspaceId ?? t.workspaceId ?? '', state: null });
      };
      add(t.agentId, t.workspaceId);
      const runs = this.store.runs(t.id);
      const current = t.resolution.currentRunId ? runs.find(run => run.id === t.resolution.currentRunId) : null;
      add(current?.agentId, current?.workspaceId ?? t.workspaceId);
      add(t.resolution.reviewerAgentId, runs.find(run => run.role === 'reviewer' && run.agentId === t.resolution.reviewerAgentId)?.workspaceId ?? t.workspaceId);
    }
    // A resolving wait is recorded only on a pass that actually sends a dismiss
    // or cancel toward the host; anything already sent falls through to the
    // ordinary wait so the task can never sit in "resolving" with nothing sent.
    const resolving = () => {
      this.resolution.waiting(this.store.task(t.id), 'Resolving a withdrawn Nucleus question still pending on the retained thread; dispatch proceeds once the host clears it', 'lifecycle');
    };
    const dismissed = (match: string, requestId: string) =>
      this.store.eventsAll(t.id).some(item => item.kind === 'native_question_dismissed' && item.detail.startsWith(`${match}:`) && item.detail.includes(requestId));
    const cancelSent = (match: string, intentId: string) =>
      this.store.eventsAll(t.id).some(item => item.kind === 'native_permission_cancel_intent' && item.detail.startsWith(`${match}: ${intentId}`));
    for (const candidate of candidates) {
      let state = candidate.state;
      if (!state) {
        try { state = await this.resolution.host.observe(candidate.agentId); }
        catch { continue; }
      }
      if (!state.permissions && !state.pendingRequest) continue;
      const workspaceId = candidate.workspaceId || state.workspaceId || '';
      // Pending native questions: dismiss by recorded requestId or text prefix.
      if (this.adapter.pendingQuestions && this.adapter.dismissNativeQuestion) {
        let pending: Awaited<ReturnType<NonNullable<Adapter['pendingQuestions']>>> | null = null;
        try { pending = await this.adapter.pendingQuestions(candidate.agentId); }
        catch { pending = null; }
        if (pending) {
          for (const request of pending) {
            const recorded = recordedRequests.get(request.requestId);
            const match = (recorded && withdrawn.has(recorded) ? recorded : null)
              ?? [...withdrawn].find(id => request.questions.some(question => question.question.startsWith(`[Queue decision ${id}]`)));
            if (!match || dismissed(match, request.requestId)) continue;
            try {
              await this.adapter.dismissNativeQuestion(candidate.agentId, workspaceId, request.requestId);
            } catch { return false; }
            this.store.event(t.id, 'native_question_dismissed', `${match}: request ${request.requestId} on ${candidate.agentId} (resolved at dispatch)`);
            resolving();
            return true;
          }
        }
      }
      // Pending permission or question observed on the thread: act only when it
      // is a recorded withdrawn Nucleus request or its text names one, and only
      // with the host call that settles that kind.
      const pendingId = state.pendingRequest?.id ?? null;
      const firstLine = state.pendingRequest?.firstLine ?? '';
      const kind = state.pendingRequest?.kind;
      if (!pendingId) continue;
      const recorded = recordedRequests.get(pendingId);
      const match = (recorded && withdrawn.has(recorded) ? recorded : null)
        ?? [...withdrawn].find(id => firstLine.includes(`[Queue decision ${id}]`) || firstLine.includes(id));
      if (!match) continue;
      if (kind === 'permission' && this.adapter.answerNativePermission) {
        const intentId = `ns-withdrawn-${match}-${pendingId}`;
        if (cancelSent(match, intentId)) continue;
        this.store.event(t.id, 'native_permission_cancel_intent', `${match}: ${intentId} request ${pendingId} on ${candidate.agentId}`);
        try { await this.adapter.answerNativePermission(candidate.agentId, workspaceId, pendingId, 'cancel', intentId); }
        catch { return false; }
        resolving();
        return true;
      }
      if (kind === 'question' && this.adapter.dismissNativeQuestion) {
        if (dismissed(match, pendingId)) continue;
        try { await this.adapter.dismissNativeQuestion(candidate.agentId, workspaceId, pendingId); }
        catch { return false; }
        this.store.event(t.id, 'native_question_dismissed', `${match}: request ${pendingId} on ${candidate.agentId} (resolved at dispatch)`);
        resolving();
        return true;
      }
    }
    return false;
  }
}
