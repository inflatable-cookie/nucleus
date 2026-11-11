import type { Task } from '../../shared/contracts';
import { DelegatedHostUnavailable } from './delegation';
import { DELEGATED_ANSWER_TIMEOUT_MS, nativeDelegationPrompt, type DelegateRole, type DelegationContext } from './question-delegation';
import type { Resolution } from '../resolution';

/** One planner/decider rung. Durable delivery windows belong to Delegation;
 * each caller retains its existing intent and outcome event vocabulary. */
export async function delegateQuestion<T>(resolution: Resolution, task: Task, input: {
  planner: string | null;
  plannerMessageId: string;
  decisionId: string;
  context: DelegationContext;
  signal: AbortSignal;
  sourceAgentId?: string;
  parse: (text: string | null) => T | null;
  current?: () => boolean;
  /** Existing planner receipts may settle a task that ended; starting a decider may no longer apply. */
  canAdvance?: () => boolean;
  onIntent: (role: DelegateRole, agentId?: string) => void;
  onMiss: (detail: string) => void;
  onUnknown: (role: DelegateRole, agentId: string | undefined, error: unknown) => void;
  retainDecider?: boolean;
}): Promise<{ role: DelegateRole; agentId: string; reply: T } | null> {
  const current = () => !resolution.stopped() && !input.signal.aborted && (input.current?.() ?? true);
  if (!current()) return null;
  const deciderDelivery = resolution.delegatedDelivery(`ns-decider-${input.decisionId}`);
  const plannerDelivery = resolution.delegatedDelivery(input.plannerMessageId);
  // A closed unknown window is not a known timeout. Even a resumed caller
  // must not interpret waitDelegatedAnswer's null as permission to advance.
  for (const [id, role, delivery] of [
    [input.plannerMessageId, 'planner', plannerDelivery],
    [`ns-decider-${input.decisionId}`, 'decider', deciderDelivery],
  ] as const) {
    const events = resolution.store.eventsAll(`delegation:${id}`);
    if (!events.some(event => event.kind === 'delegated_answer') && events.some(event => event.kind === 'delegated_closed' && event.detail !== 'No command answer in the window')) {
      if (current()) input.onUnknown(role, delivery?.recipient, Error('Previous delivery outcome unknown; never resend'));
      return null;
    }
  }
  const planner = deciderDelivery ? null : plannerDelivery?.recipient ?? input.planner;
  if (!current()) return null;
  if (planner) {
    if (!plannerDelivery) await resolution.delegation.requireHost(task, planner, 'planner');
    input.onIntent('planner', planner);
    let text: string | null;
    try {
      text = await resolution.askBound(task, planner, {
        prompt: nativeDelegationPrompt('planner', input.context), signal: input.signal,
        timeoutMs: DELEGATED_ANSWER_TIMEOUT_MS, messageId: input.plannerMessageId, sourceAgentId: input.sourceAgentId,
      }, 'planner');
    } catch (error) {
      if (error instanceof DelegatedHostUnavailable) throw error;
      if (current()) input.onUnknown('planner', planner, error);
      // Unknown delivery never opens the next rung, including on replay.
      return null;
    }
    // An observed receipt remains evidence after cancellation; its owner records
    // a stale answer without applying it. Cancellation still fences advancement.
    if (resolution.stopped() || input.current?.() === false) return null;
    const reply = input.parse(text);
    if (reply) return { role: 'planner', agentId: planner, reply };
    input.onMiss(`planner ${planner} gave no usable answer (${text ? 'unparseable' : 'no answer in time'})`);
  }
  if (!current() || input.canAdvance?.() === false || !resolution.adapter.runDecider) return null;
  const profile = resolution.deciderProfile(task);
  if (!profile && !deciderDelivery) { input.onMiss('no eligible decider profile'); return null; }
  input.onIntent('decider');
  let decided: { agentId: string; text: string | null };
  try {
    decided = await resolution.deciderBound(task, {
      prompt: nativeDelegationPrompt('decider', input.context), profile, signal: input.signal,
      timeoutMs: DELEGATED_ANSWER_TIMEOUT_MS, decisionId: input.decisionId, sourceAgentId: input.sourceAgentId,
    });
  } catch (error) {
    if (error instanceof DelegatedHostUnavailable) throw error;
    if (current()) input.onUnknown('decider', undefined, error);
    return null;
  }
  let usable = false;
  try {
    if (resolution.stopped() || input.current?.() === false) return null;
    const reply = input.parse(decided.text);
    usable = Boolean(reply);
    if (reply) return { role: 'decider', agentId: decided.agentId, reply };
    input.onMiss(`decider ${decided.agentId} gave no usable answer`);
    return null;
  } finally {
    if (!input.retainDecider || !current() || !usable) await resolution.host.archiveAgent(decided.agentId).catch(() => {});
  }
}
