import { readyReviewAtHead } from '../recovery/task-reasons';
import type { HoldBlocking, HoldKind, HoldUntil, Task, TaskHolds } from "../../shared/contracts";
import { DEFAULT_HOLD_ESCALATION_MINUTES, DEFAULT_HOLD_REMINDER_MINUTES, TASK_OWNER_HOLD, holdOwnerOf, holdsOf, isOperatorOrigin, operatorSourceAcceptance, qualifiedOwnerAcceptance, storedHoldOwner, syncHoldProjection } from "../../shared/contracts";
import { PREREQUISITE_WAIT_PREFIX, prerequisiteCannotComplete } from "../../shared/wait-state";
import type { Resolution } from "../resolution";
import { digest, now } from "../store/store";

export type HoldsContext = Pick<Resolution, 'reviewRequired' | 'store'>;

/** Spec 040: the owner of a hold placed by the board, and the reason legacy holds carry. */
export const OPERATOR_HOLD_OWNER = "operator";
/** Round 4: the reason prefix of the dispatch hold an owner `stop` places. */
export const OWNER_STOP_HOLD_PREFIX = "Owner stop:";
export const HOLD_REASON_NOT_RECORDED = "not recorded";

type HoldTask = Parameters<typeof holdsOf>[0];

/**
 * A new hold generation of one kind: owner, reason and start time, with the
 * blocking clock cleared on a merge fence. Spec 046: a self-lifting hold also
 * records its end condition (`until`), which an ordinary hold leaves null. The
 * other kind is left in place.
 */
export function holdPatch(task: HoldTask, kind: HoldKind, owner: string, reason: string, until: HoldUntil | null = null): Partial<Task> {
  const holds: TaskHolds = { ...holdsOf(task) };
  const previous = holds[kind];
  // The task owner's own hold follows the task's owner (Tom, 2026-10-26).
  holds[kind] = {
    owner: storedHoldOwner(task, owner), reason, at: now(), generation: (previous?.generation ?? 0) + 1, until,
    ...(kind === "merge" ? { blocking: null } : {}),
  };
  return syncHoldProjection(holds);
}
/** Release one hold kind. The other kind, if present, stays. */
export function releasePatch(task: HoldTask, kind: HoldKind): Partial<Task> {
  const holds: TaskHolds = { ...holdsOf(task) };
  delete holds[kind];
  return syncHoldProjection(holds);
}
/**
 * Keep: a fresh reason, a new generation of that kind, and the clock restarts.
 * A merge hold that is the last blocker re-arms from now, so the next prompt
 * waits a full reminder interval. A caller that is an agent takes ownership.
 * Spec 046: `keep_hold` leaves a self-lifting hold's `until` condition in force.
 */
export function keepPatch(task: HoldTask, kind: HoldKind, reason: string, agentId: string | undefined): Partial<Task> {
  const holds: TaskHolds = { ...holdsOf(task) };
  const current = holds[kind];
  if (!current) throw new Error(`Keep applies only to a ${kind} hold`);
  const generation = current.generation + 1, at = now();
  const holdBlocking: HoldBlocking | null | undefined = kind === "merge"
    ? current.blocking
      ? { since: at, head: current.blocking.head, generation, notices: current.blocking.notices, lastNoticeAt: at, escalatedAt: null }
      : null
    : undefined;
  holds[kind] = {
    ...current, owner: agentId ? storedHoldOwner(task, agentId) : current.owner, reason, generation, until: current.until,
    ...(kind === "merge" ? { blocking: holdBlocking ?? null } : {}),
  };
  return syncHoldProjection(holds);
}

/** Prompts the owner of a hold that is the last blocker, and lifts self-lifting holds. */
export class Holds {
  constructor(readonly resolution: HoldsContext) {}
  get store() { return this.resolution.store; }

  /**
   * Spec 040: a held task that would otherwise claim the integration turn, with the accepted
   * exact-head review applied and no attention, is blocked by the hold alone. Queue starts
   * the clock, prompts the owner once per hold generation and reviewed head, reminds them
   * every `holdReminderMinutes`, and after `holdEscalationMinutes` marks the hold for the
   * operator's Decisions view. A board hold is only shown: its owner is the operator.
   */
  holdLastBlocker(t: Task) {
    // A qualified owner acceptance or an explicit operator source acceptance
    // (2026-10-20) leaves the task ready but for the hold, so its owner keeps
    // the same prompt a reviewed head gets.
    const reviewed = !this.resolution.reviewRequired(t) || readyReviewAtHead(t)
      || Boolean(qualifiedOwnerAcceptance(t)) || Boolean(operatorSourceAcceptance(t));
    const merge = holdsOf(t).merge;
    if (!merge || !t.prHead || !reviewed || t.resolution.attention || (t.phase !== 'verifying' && t.phase !== 'merging')) return;
    const at = now(), nowMs = Date.parse(at);
    const reminderMs = (this.store.getMeta<number>('holdReminderMinutes') ?? DEFAULT_HOLD_REMINDER_MINUTES) * 60_000;
    const escalationMs = (this.store.getMeta<number>('holdEscalationMinutes') ?? DEFAULT_HOLD_ESCALATION_MINUTES) * 60_000;
    const owner = holdOwnerOf(t, merge.owner), reason = merge.reason, generation = merge.generation;
    // An owner-placed hold's prompt follows the task's owner to delivery (Spec 040).
    const recipientMark = merge.owner === TASK_OWNER_HOLD ? TASK_OWNER_HOLD : owner;
    // Any operator identity owns a hold from the board, never a thread (review #602: "operator (board)" too).
    const operatorOwned = isOperatorOrigin(owner);
    const current = merge.blocking;
    const fresh = !current || current.head !== t.prHead || current.generation !== generation;
    let next = fresh ? { since: at, head: t.prHead, generation, notices: 0, lastNoticeAt: null, escalatedAt: null } as HoldBlocking : current!;
    const promptDue = !operatorOwned && (!next.lastNoticeAt || nowMs - Date.parse(next.lastNoticeAt) >= reminderMs);
    const escalateDue = !operatorOwned && !next.escalatedAt && nowMs - Date.parse(next.since) >= escalationMs;
    if (!fresh && !promptDue && !escalateDue) return;
    if (promptDue) {
      const id = digest(`${t.id}:hold:${generation}:${t.prHead}:${next.notices}`);
      const age = `${Math.max(0, Math.round((nowMs - Date.parse(merge.at || next.since)) / 60_000))} minutes`;
      if (!this.store.notices(t.id).some(n => n.id === id)) this.store.putNotice({ id, taskId: t.id, agentId: owner, recipientAgentId: recipientMark, workspaceId: null, sources: [], originEntry: false, kind: 'hold', status: 'pending', error: '',
        text: `Nucleus: a merge hold is the only thing stopping a reviewed task\nTask: ${t.title} (${t.id})\nReviewed head: ${t.prHead}\nHold reason: ${reason}\nHold age: ${age}\nRelease it with queue.task action "release", or keep it with action "keep_hold" and a fresh reason. Nucleus reminds you again until you do.` });
      this.store.event(t.id, next.notices === 0 ? 'hold_ready_notified' : 'hold_reminded', `${owner}; head ${t.prHead}; generation ${generation}`);
      next = { ...next, notices: next.notices + 1, lastNoticeAt: at };
    }
    if (escalateDue) {
      next = { ...next, escalatedAt: at };
      this.store.event(t.id, 'hold_escalated', `Ready to merge, held for ${reason} since ${merge.at || next.since}`);
    }
    const holds = holdsOf(t);
    this.store.update(t.id, { holdBlocking: next, holds: { ...holds, merge: { ...merge, blocking: next } } });
  }
  /**
   * Spec 046: the state of a self-lifting hold's end condition. `met` releases the
   * hold, `impossible` means the named task can never reach `done` (cancelled,
   * removed, missing or goal-unmet) so the hold stays and its owner is prompted,
   * and `waiting` is a live target or a timestamp not yet reached.
   */
  private holdUntilState(t: Pick<Task, 'holdUntil'>): { state: 'met' | 'impossible' | 'waiting'; detail: string } | null {
    const until = t.holdUntil;
    if (!until) return null;
    if (until.kind === 'time') {
      if (Date.parse(now()) < Date.parse(until.at)) return { state: 'waiting', detail: '' };
      return { state: 'met', detail: `time ${until.at} reached` };
    }
    const wait = this.store.dependencyWait({ dependsOn: [until.taskId] });
    if (!wait) return { state: 'met', detail: `task ${until.taskId} reached done` };
    if (prerequisiteCannotComplete(wait)) {
      const status = wait.startsWith(PREREQUISITE_WAIT_PREFIX) ? wait.slice(PREREQUISITE_WAIT_PREFIX.length).trim() : wait;
      return { state: 'impossible', detail: `task ${until.taskId} cannot finish (${status})` };
    }
    return { state: 'waiting', detail: '' };
  }
  /**
   * Spec 046: reconcile a self-lifting hold. `auto_released` means the condition was
   * met: Queue cleared the hold, recorded `hold_auto_released` and queued one owner
   * notice. `condition_impossible` leaves the hold in place and prompts the owner
   * because its target can never finish. `waiting` and `none` change nothing.
   */
  reconcileHoldUntil(taskId: string): 'none' | 'waiting' | 'auto_released' | 'condition_impossible' {
    let t = this.store.task(taskId);
    if (t.removedAt || t.resolution.mergeIntent || t.resolution.mergedCommit) return 'none';
    let released = false, waiting = false, impossible = false;
    for (const kind of ['dispatch', 'merge'] as const) {
      t = this.store.task(taskId);
      const fence = holdsOf(t)[kind];
      if (!fence?.until) continue;
      const outcome = this.holdUntilState({ holdUntil: fence.until });
      if (!outcome) continue;
      if (outcome.state === 'waiting') { waiting = true; continue; }
      const owner = holdOwnerOf(t, fence.owner);
      const recipientMark = fence.owner === TASK_OWNER_HOLD ? TASK_OWNER_HOLD : owner;
      const agentOwner = !isOperatorOrigin(owner);
      if (outcome.state === 'impossible') {
        impossible = true;
        const generation = `generation ${fence.generation};`;
        if (!this.store.events(t.id).some(event => event.kind === 'hold_until_blocked' && event.detail.startsWith(generation))) {
          if (agentOwner) this.store.putNotice({ id: `hold-until-blocked:${t.id}:${kind}:${fence.generation}`, taskId: t.id, agentId: owner, recipientAgentId: recipientMark, workspaceId: null, sources: [], originEntry: false, kind: 'hold', status: 'pending', error: '',
            text: `Nucleus: a hold's end condition can never be met\nTask: ${t.title} (${t.id})\nHold kind: ${kind}\nHold reason: ${fence.reason || HOLD_REASON_NOT_RECORDED}\nEnd condition: ${outcome.detail}\nRelease the hold with queue.task action "release", or keep it with action "keep_hold" and a fresh reason. Nucleus cannot lift this hold by itself.` });
          this.store.event(t.id, 'hold_until_blocked', `${generation} ${kind}; ${outcome.detail}`);
        }
        continue;
      }
      this.store.transaction(() => {
        if (agentOwner) this.store.putNotice({ id: `hold-auto-release:${t.id}:${kind}:${fence.generation}`, taskId: t.id, agentId: owner, recipientAgentId: recipientMark, workspaceId: null, sources: [], originEntry: false, kind: 'hold_release', status: 'pending', error: '',
          text: `Nucleus: a hold lifted itself\nTask: ${t.title} (${t.id})\nHold kind: ${kind}\nHold reason: ${fence.reason || HOLD_REASON_NOT_RECORDED}\nEnd condition met: ${outcome.detail}\nNucleus released the hold and will continue.` });
        this.store.update(t.id, releasePatch(this.store.task(t.id), kind), 'hold_auto_released', `${kind}; ${outcome.detail}`);
      });
      released = true;
    }
    if (released) return 'auto_released';
    if (impossible) return 'condition_impossible';
    if (waiting) return 'waiting';
    return 'none';
  }
}
