import type { Task } from '../../shared/contracts';
import { DelegatedHostUnavailable, type PlannerRungName } from './delegation';
import { DELEGATED_ANSWER_TIMEOUT_MS, nativeDelegationPrompt, type DelegateRole, type DelegationContext } from './question-delegation';
import type { Resolution } from '../resolution';
import { retireDeciderThread } from '../workspaces/thread-archive';

/**
 * One planner rung with the message window its question travels on. A task climbs
 * its own planner, then the project planner, then a short-lived decider (task 1109;
 * Tom, 2026-11-11). Durable delivery windows belong to Delegation; each caller
 * retains its existing intent and outcome event vocabulary.
 */
export interface PlannerWindow {
  agentId: string;
  messageId: string;
  rung: PlannerRungName;
}

export async function delegateQuestion<T>(resolution: Resolution, task: Task, input: {
  /** Planner rungs in order, already deduped and with observed-gone threads removed. */
  planners: PlannerWindow[];
  decisionId: string;
  context: DelegationContext;
  signal: AbortSignal;
  sourceAgentId?: string;
  parse: (text: string | null) => T | null;
  current?: () => boolean;
  /** Existing planner receipts may settle a task that ended; starting a decider may no longer apply. */
  canAdvance?: () => boolean;
  onIntent: (role: DelegateRole, agentId?: string, rung?: PlannerRungName) => void;
  /** A rung whose planner host cannot take the question at all; the next rung is tried. */
  onSkip?: (rung: PlannerRungName, agentId: string, detail: string) => void;
  onMiss: (detail: string) => void;
  onUnknown: (role: DelegateRole, agentId: string | undefined, error: unknown) => void;
  /** No rung could be asked on its host. Skip the decider; the caller raises a board decision. */
  onUnavailable?: (planner: string) => void;
  retainDecider?: boolean;
}): Promise<{ role: DelegateRole; agentId: string; rung?: PlannerRungName; reply: T } | null> {
  const current = () => !resolution.stopped() && !input.signal.aborted && (input.current?.() ?? true);
  if (!current()) return null;
  const deciderId = `ns-decider-${input.decisionId}`;
  const deciderDelivery = resolution.delegatedDelivery(deciderId);
  const windows: Array<PlannerWindow & { delivery: ReturnType<Resolution['delegatedDelivery']> }> =
    input.planners.map(rung => ({ ...rung, delivery: resolution.delegatedDelivery(rung.messageId) }));
  // A closed unknown window is not a known timeout. Even a resumed caller
  // must not interpret waitDelegatedAnswer's null as permission to advance.
  for (const [id, role, delivery] of [
    ...windows.map(window => [window.messageId, 'planner', window.delivery] as const),
    [deciderId, 'decider', deciderDelivery] as const,
  ]) {
    const events = resolution.store.eventsAll(`delegation:${id}`);
    if (!events.some(event => event.kind === 'delegated_answer') && events.some(event => event.kind === 'delegated_closed' && event.detail !== 'No command answer in the window')) {
      if (current()) input.onUnknown(role, delivery?.recipient, Error('Previous delivery outcome unknown; never resend'));
      return null;
    }
  }
  if (!current()) return null;
  let asked = false;
  let unavailable: string | null = null;
  for (const [index, window] of windows.entries()) {
    // A recorded decider window means the rungs already concluded; resume it below.
    if (deciderDelivery) break;
    if (!current()) return null;
    const last = index === windows.length - 1;
    const skipToNextRung = (detail: string): boolean => {
      if (last) return false;
      input.onSkip?.(window.rung, window.agentId, detail);
      return true;
    };
    if (!window.delivery) {
      try {
        await resolution.delegation.requireHost(task, window.agentId, 'planner');
      } catch (error) {
        if (!(error instanceof DelegatedHostUnavailable)) throw error;
        // The planner's host cannot take the question. A later rung is asked instead;
        // the last rung keeps the caller's host wait, which is its existing meaning.
        if (skipToNextRung(error.message)) continue;
        throw error;
      }
    }
    input.onIntent('planner', window.agentId, window.rung);
    let text: string | null;
    try {
      text = await resolution.askBound(task, window.agentId, {
        prompt: nativeDelegationPrompt('planner', input.context, window.rung), signal: input.signal,
        timeoutMs: DELEGATED_ANSWER_TIMEOUT_MS, messageId: window.messageId, sourceAgentId: input.sourceAgentId, rung: window.rung,
      }, 'planner');
    } catch (error) {
      if (error instanceof DelegatedHostUnavailable && !window.delivery && skipToNextRung(error.message)) continue;
      if (error instanceof DelegatedHostUnavailable) throw error;
      if (current()) input.onUnknown('planner', window.agentId, error);
      // Unknown delivery never opens the next rung, including on replay.
      return null;
    }
    // An observed receipt remains evidence after cancellation; its owner records
    // a stale answer without applying it. Cancellation still fences advancement.
    if (resolution.stopped() || input.current?.() === false) return null;
    if (!text && !window.delivery && !resolution.delegatedDelivery(window.messageId)) {
      // The planner's host cannot send a planner question at all. The next rung is
      // asked; only a project rung that cannot be asked raises the caller's board
      // decision, exactly as the single-rung route did before task planners.
      if (window.rung === 'project') unavailable = window.agentId;
      if (skipToNextRung('the host cannot send delegated planner questions')) continue;
      break;
    }
    asked = true;
    const reply = input.parse(text);
    if (reply) return { role: 'planner', agentId: window.agentId, rung: window.rung, reply };
    input.onMiss(`${window.rung} planner ${window.agentId} gave no usable answer (${text ? 'unparseable' : 'no answer in time'})`);
  }
  if (!asked && !deciderDelivery && unavailable && input.onUnavailable) {
    input.onUnavailable(unavailable);
    return null;
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
    if (!input.retainDecider || !current() || !usable) await retireDeciderThread(resolution.host, resolution.adapter, decided.agentId);
  }
}
