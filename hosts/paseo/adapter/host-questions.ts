import type { PaseoAgentHandle, PaseoAgentTimelineEvent } from '@getpaseo/client';
import type { Task } from '../../../shared/contracts';
import type { NativeDecisionInput } from '../../../shared/host';
import type { PaseoAdapter } from './paseo';

/**
 * The Paseo host's native question calls (Spec 058, tasks 540 and 542): listing and
 * answering a thread's pending questions, reading its answered ones, and raising and
 * answering a decision on the task thread. Step 3 row 10 of the Paseo host split map
 * (task 871) moved these out of `server/paseo.ts`; the native decision wire moved out
 * of `server/native-decision.ts`.
 *
 * What decides stays core: `server/native-questions.ts` and `server/questions.ts` own
 * delegation, durable intents, the event sequence and the native-or-queue route. The
 * owner is kept and `owner.api` and `owner.agentTimelinePage` are read at call time, so
 * test replacements and the adapter's own surface are the ones called. Each method keeps
 * the body and sync prefix it had on the adapter.
 */
export class PaseoQuestionHost {
  constructor(private readonly owner: PaseoAdapter) {}
  async pendingQuestions(agentId: string) {
    const agent = this.owner.api.agents.ref(agentId);
    if (!await agent.refresh()) throw Error('Agent was not found');
    return (agent.pendingPermissions ?? []).flatMap(request => {
      if (request.kind !== 'question' || !Array.isArray(request.input?.questions)) return [];
      const questions = request.input.questions.flatMap((item: unknown) => {
        if (!item || typeof item !== 'object') return [];
        const q = item as Record<string, unknown>;
        if (typeof q.header !== 'string' || !q.header.trim() || typeof q.question !== 'string' || !q.question.trim()) return [];
        const options = Array.isArray(q.options) ? q.options.flatMap(option => typeof option === 'string' ? [option] : option && typeof option === 'object' && typeof (option as Record<string, unknown>).label === 'string' ? [(option as Record<string, unknown>).label as string] : []) : [];
        return [{ header: q.header, question: q.question, options }];
      });
      if (questions.length !== request.input.questions.length || !questions.length || new Set(questions.map(q => q.header)).size !== questions.length) return [];
      return [{ requestId: request.id, questions }];
    });
  }
  async answerNativeQuestion(agentId: string, workspaceId: string, requestId: string, answers: Record<string, string>) {
    const agent = this.owner.api.agents.ref(agentId);
    if (!await agent.refresh() || agent.archivedAt || agent.workspaceId !== workspaceId) throw Error('Question thread identity changed');
    if (!(agent.pendingPermissions ?? []).some(request => request.id === requestId && request.kind === 'question')) throw Error('Question is no longer pending');
    await agent.respondToPermission({ requestId, response: { behavior: 'allow', updatedInput: { answers } } });
  }
  async dismissNativeQuestion(agentId: string, workspaceId: string, requestId: string) {
    const agent = this.owner.api.agents.ref(agentId);
    if (!await agent.refresh() || agent.archivedAt || agent.workspaceId !== workspaceId) throw Error('Question thread identity changed');
    if (!(agent.pendingPermissions ?? []).some(request => request.id === requestId && request.kind === 'question')) throw Error('Question is no longer pending');
    await agent.respondToPermission({ requestId, response: { behavior: 'deny' } });
  }
  async answeredQuestions(agentId: string): Promise<Array<{ requestId: string; question: string; answers: Record<string, string> }>> {
    const page = await this.owner.agentTimelinePage(agentId, 40);
    if (!page) return [];
    const out: Array<{ requestId: string; question: string; answers: Record<string, string> }> = [];
    for (const entry of page.entries) {
      const item = entry.item as unknown as Record<string, unknown>;
      if (item?.type !== 'permission_resolved') continue;
      const requestId = typeof item.requestId === 'string' ? item.requestId : '';
      const resolution = item.resolution as Record<string, unknown> | undefined;
      const answers = (resolution as { updatedInput?: { answers?: unknown } } | undefined)?.updatedInput?.answers;
      if (!requestId || resolution?.behavior !== 'allow' || !answers || typeof answers !== 'object' || Array.isArray(answers)) continue;
      const clean: Record<string, string> = {};
      for (const [key, value] of Object.entries(answers as Record<string, unknown>)) {
        if (typeof value === 'string' && value.trim()) clean[key] = value;
      }
      if (!Object.keys(clean).length) continue;
      const question = typeof item.question === 'string' && item.question.trim()
        ? item.question : typeof (item as { title?: unknown }).title === 'string' ? String((item as { title?: unknown }).title) : requestId;
      out.push({ requestId, question, answers: clean });
    }
    return out;
  }
  async raiseTaskDecision(task: Task, input: NativeDecisionInput): Promise<string> {
    if (!task.agentId || !task.workspaceId) throw Error('Task has no thread for a native decision');
    const agent = this.owner.api.agents.ref(task.agentId);
    await agent.refresh();
    if (!agent.current() || agent.archivedAt || agent.workspaceId !== task.workspaceId) throw Error('Task thread identity changed');
    return raiseNativeDecision(agent, input);
  }
  async answerTaskDecision(task: Task, input: { requestId: string; header: string; answer: string }): Promise<void> {
    if (!task.agentId || !task.workspaceId) throw Error('Task has no thread for a native decision');
    const agent = this.owner.api.agents.ref(task.agentId);
    await agent.refresh();
    if (!agent.current() || agent.archivedAt || agent.workspaceId !== task.workspaceId) throw Error('Task thread identity changed');
    await agent.respondToPermission({ requestId: input.requestId, response: { behavior: 'allow', updatedInput: { answers: { [input.header]: input.answer } } } });
  }
}

/**
 * Ask the task's own agent to present a native question. The caller owns the
 * durable send intent and must not retry an unknown delivery. A lost observer
 * is reported as unknown, never treated as an unanswered question to resend.
 */
export async function raiseNativeDecision(agent: PaseoAgentHandle, input: NativeDecisionInput): Promise<string> {
  if (!input.id.trim() || !input.question.trim()) throw Error('A decision identity and question are required');
  const marker = `[Queue decision ${input.id}]`;
  let requestId: string | undefined;
  let header: string | undefined;
  let finish!: (value: string) => void;
  let fail!: (error: Error) => void;
  let settled = false;
  const answer = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
  void answer.catch(() => {});
  const reject = (message: string) => { if (!settled) { settled = true; fail(Error(message)); } };
  const onEvent = ({ event }: PaseoAgentTimelineEvent) => {
    if (event.type === 'subscription_restored' || event.type === 'replacement' || event.type === 'error') {
      reject('Native decision observation interrupted; delivery or answer may be unknown'); return;
    }
    if (event.type === 'permission_requested' && event.request.kind === 'question') {
      const questions = event.request.input?.questions;
      if (!Array.isArray(questions) || questions.length !== 1) return;
      const q = questions[0] as Record<string, unknown>;
      if (typeof q.question === 'string' && q.question.startsWith(marker) && typeof q.header === 'string') {
        requestId = event.request.id; header = q.header;
        // Spec 058 (task 540): the question is on the sidebar now, so a delegate may answer that request id.
        input.onRequested?.({ requestId, header });
      }
    }
    if (event.type === 'permission_resolved' && requestId && event.requestId === requestId) {
      if (event.resolution.behavior !== 'allow') { reject('Native decision was dismissed'); return; }
      const values = event.resolution.updatedInput?.answers;
      const value = values && typeof values === 'object' && !Array.isArray(values) ? (values as Record<string, unknown>)[header!] : undefined;
      if (typeof value !== 'string' || !value.trim()) { reject('Native decision resolved without an answer'); return; }
      if (!settled) { settled = true; finish(value); }
    }
  };
  const unsubscribe = agent.timeline.subscribe(onEvent);
  const abort = () => reject('Native decision observation cancelled; delivery or answer may be unknown');
  input.signal.addEventListener('abort', abort, { once: true });
  try {
    await unsubscribe.ready;
    if (input.signal.aborted) { abort(); return await answer; }
    await agent.send(`Ask the operator exactly one native asynchronous question (use request_user_input_async when available). Use this exact question title: ${marker} ${input.question}\n${input.options.length ? `Options: ${input.options.join(' | ')}\n` : ''}Do not choose or answer for the operator.`, { messageId: `queue-decision-${input.id}` });
    return await answer;
  } finally {
    input.signal.removeEventListener('abort', abort);
    unsubscribe();
  }
}
