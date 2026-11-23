import { type Run, type Task } from '../../shared/contracts';
import { boundInlineReport } from '../review/ordinary-review';
import type { Resolution } from '../resolution';
import { digest } from '../store/store';
import { RESPONSIBLE_QUESTION_WAIT } from '../recovery/task-reasons';

/** The event that records Spec 068 Decision 2's automatic continue at the third round. */
export const ROUND_CONTINUED_EVENT = 'review_round_continued';

/** Once one of these is recorded for a continued round, its tell is never sent again: a send was attempted. */
const TELL_SETTLED_EVENTS = ['review_round_planner_tell_intent', 'review_round_planner_told'];
const TELL_MISSED_EVENT = 'review_round_planner_tell_missed';
/** How long a missed tell (no planner, no proven or available host) waits before the task's pass tries it again. */
export const ROUND_TELL_RETRY_MS = 5 * 60_000;

/** The one tell the task's planner gets when the third non-converging round continues. */
export function reviewRoundTellText(facts: { reference: string; title: string; head: string; finding: string; workerReturn: string }): string {
  return `Nucleus continued ${facts.reference} ("${facts.title}") past its third non-converging review round at ${facts.head} without asking (Spec 068 Decision 2): `
    + `the current approach continues up to the revision cap, which still stops the task and asks. No answer is needed. `
    + `To change the approach, use move to=work with your direction, or route role=worker. `
    + `The reviewer's findings: ${facts.finding} The worker's latest return: ${facts.workerReturn}`;
}

/** The third non-converging review round (Spec 058, Spec 068 Decision 2), and the joint question raised before it. */
export class JointReviewQuestion {
  constructor(readonly resolution: Resolution) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  async responsibleJointQuestion(t: Task): Promise<boolean> {
    const applied = new Set(this.store.eventsAll(t.id)
      .filter(event => ['review_result_applied', 'review_reapplied'].includes(event.kind)).map(event => event.detail));
    const receipts = this.store.db.prepare('SELECT id,run FROM receipts WHERE task=? ORDER BY rowid').all(t.id) as { id: string; run: string }[];
    const runs = new Map(this.store.runs(t.id).map(run => [run.id, run]));
    let reviews: Run[] = [];
    const seen = new Set<string>();
    for (const receipt of receipts) {
      if (seen.has(receipt.run)) continue;
      const run = runs.get(receipt.run), completion = run?.completion;
      if (!run || !completion || run.role !== 'reviewer' || run.mechanicalReviewProof
        || run.status !== 'finished' || !run.released || completion.eventId !== receipt.id
        || completion.taskId !== t.id || completion.runId !== run.id || !completion.head || completion.head !== run.head
        || !applied.has(run.id)) continue;
      seen.add(run.id);
      if (completion.status === 'ready_to_merge') { reviews = []; continue; }
      if (completion.status === 'changes_required' && (completion.reviewResponsibility === 'author'
        || !run.reviewResponsibilityRequired && completion.reviewResponsibility === undefined)) reviews.push(run);
    }
    if (reviews.length !== 3) return false;
    const latest = reviews.at(-1)!;
    const id = digest(`responsible-question:${t.id}:${latest.id}`);
    const events = this.store.eventsAll(t.id);
    const marked = (kind: string) => events.find(event => event.kind === kind && event.detail.startsWith(`${id}:`));
    if (marked('responsible_question_answered')) return false;
    if (marked('responsible_question_unknown')) return false;
    // An owner control moved past the question, so it no longer holds the task.
    if (marked('responsible_question_superseded')) return false;
    // A question raised before Spec 068 Decision 2 still waits for its answer.
    if (marked('responsible_question')) { this.resolution.waiting(this.store.task(t.id), RESPONSIBLE_QUESTION_WAIT, 'responsible_question'); return true; }
    if (marked(ROUND_CONTINUED_EVENT)) return false;
    this.continueAutomatically(t, id, latest);
    return false;
  }

  /**
   * Spec 068 Decision 2 (Tom, 2026-11-22): at the third non-converging review round
   * Nucleus continues the current approach on its own and asks nothing; planners
   * chose "Continue the current approach" 48 times out of 50. The task's planner
   * gets one tell with the reviewer's findings, so a change of approach stays theirs
   * (`move to=work` with direction, or `route role=worker`). The revision cap itself
   * still stops the task and asks.
   */
  private continueAutomatically(t: Task, id: string, latest: Run): void {
    const head = latest.completion?.head ?? t.prHead ?? 'the recorded head';
    const { finding } = this.tellFacts(t, latest);
    this.store.event(t.id, ROUND_CONTINUED_EVENT,
      `${id}: run ${latest.id}; head ${head}; the current approach continues automatically (Spec 068 Decision 2); reviewer finding ${digest(finding)} (${finding.length} chars)`);
    this.tellPlanner(t, id, latest);
  }

  /**
   * The task's own pass: a continued round whose tell has no intent or outcome
   * recorded, and is not in flight in this process, has sent nothing. Either the
   * service stopped between the continued marker and the intent, or the tell was
   * missed (no planner, or no proven or available host). It is tried again, a missed
   * one at most every `ROUND_TELL_RETRY_MS`. A tell whose intent is recorded is never
   * sent again: its delivery may already have landed.
   */
  resumeRoundTells(t: Task): void {
    if (t.removedAt || ['done', 'cancelled'].includes(t.phase)) return;
    const events = this.store.eventsAll(t.id);
    for (const event of events) {
      if (event.kind !== ROUND_CONTINUED_EVENT) continue;
      const id = event.detail.split(':', 1)[0]!;
      if (this.tellsInFlight.has(id)) continue;
      if (events.some(other => TELL_SETTLED_EVENTS.includes(other.kind) && other.detail.startsWith(`${id}:`))) continue;
      const missed = events.some(other => other.kind === TELL_MISSED_EVENT && other.detail.startsWith(`${id}:`));
      const tried = this.lastTellAttempt.get(id);
      if (missed && tried !== undefined && Date.now() - tried < ROUND_TELL_RETRY_MS) continue;
      const runId = /^[^:]+: run ([^;]+);/.exec(event.detail)?.[1];
      const run = runId ? this.store.run(runId) : null;
      if (!run || run.taskId !== t.id) {
        this.missTell(t.id, id, "the continued round's review run is not recorded");
        this.lastTellAttempt.set(id, Date.now());
        continue;
      }
      this.tellPlanner(t, id, run);
    }
  }

  private readonly tellsInFlight = new Set<string>();
  /** When this process last tried each round's tell; a restart retries a missed one at once. */
  private readonly lastTellAttempt = new Map<string, number>();

  /** Records a miss once per distinct cause, so a retried tell does not repeat the same event. */
  private missTell(taskId: string, id: string, why: string): void {
    const detail = `${id}: ${why}`.slice(0, 4000);
    const last = this.store.eventsAll(taskId).findLast(event => event.kind === TELL_MISSED_EVENT && event.detail.startsWith(`${id}:`));
    if (last?.detail !== detail) this.store.event(taskId, TELL_MISSED_EVENT, detail);
  }

  private tellFacts(t: Task, latest: Run) {
    const reviewer = latest.completion;
    const worker = this.store.runs(t.id).findLast(run => run.role === 'revision' && run.completion)?.completion;
    return {
      head: reviewer?.head ?? t.prHead ?? 'the recorded head',
      finding: boundInlineReport(reviewer?.reviewText?.trim() || reviewer?.summary?.trim() || 'not recorded', 'reviewer finding'),
      workerReturn: boundInlineReport(worker?.summary?.trim() || 'not recorded', 'worker return'),
    };
  }

  /** One tell to the task's planner. Its intent is recorded before the send, and an unknown delivery is never resent. */
  private tellPlanner(t: Task, id: string, latest: Run): void {
    if (this.tellsInFlight.has(id)) return;
    this.tellsInFlight.add(id);
    this.lastTellAttempt.set(id, Date.now());
    const { head, finding, workerReturn } = this.tellFacts(t, latest);
    void (async () => {
      const planner = (await this.resolution.taskPlannerFor(t))?.agentId
        ?? (await this.resolution.projectPlannerFor(t)).planner;
      if (!planner) {
        this.missTell(t.id, id, 'no task or project planner to tell');
        return;
      }
      const host = await this.resolution.identifyOriginHost(planner);
      if (!host) {
        this.missTell(t.id, id, `planner ${planner} has no proven host`);
        return;
      }
      await this.resolution.withHost(host, async () => {
        if (!this.resolution.originHostAvailable(host) || !this.adapter.notify) {
          this.missTell(t.id, id, `planner ${planner}'s host is unavailable`);
          return;
        }
        const reference = this.store.task(t.id).reference ?? t.title;
        this.store.event(t.id, 'review_round_planner_tell_intent', `${id}: planner ${planner}`);
        await this.resolution.host.sendMessage(planner, {
          messageId: `ns-review-round-${id}`,
          text: reviewRoundTellText({ reference, title: t.title, head, finding, workerReturn }),
        });
        this.store.event(t.id, 'review_round_planner_told', `${id}: planner ${planner}`);
      });
    })().catch(error => {
      if (this.resolution.stopped()) return;
      try {
        // After the intent this is an unknown delivery, which the intent keeps from
        // ever being resent; before it nothing was sent, so a later pass retries.
        this.missTell(t.id, id, error instanceof Error ? error.message : String(error));
      } catch { /* store closed after shutdown */ }
    }).finally(() => this.tellsInFlight.delete(id));
  }
  settleJointQuestion(taskId: string, id: string, answer: string): void {
    const delegated = this.resolution.delegatedAnswers.get(id); this.resolution.delegatedAnswers.delete(id);
    const boardBy = this.resolution.queueAskRaiseAnsweredBy.get(id); this.resolution.queueAskRaiseAnsweredBy.delete(id);
    if (this.store.eventsAll(taskId).some(event => event.kind === 'responsible_question_superseded' && event.detail.startsWith(`${id}:`))) {
      this.store.event(taskId, 'responsible_question_stale_answered', `${id}: ${answer} — answered by ${delegated ? `delegated ${delegated.role} ${delegated.agentId}` : boardBy ?? 'operator'}; no effect because the question was superseded`);
      if (delegated) this.resolution.notifyStaleQuestionAnswer(taskId, id, `${delegated.role} ${delegated.agentId}`);
      return;
    }
    this.store.event(taskId, 'responsible_question_answered', `${id}: ${answer} — answered by ${delegated ? `delegated ${delegated.role} ${delegated.agentId}` : boardBy ?? 'operator'}`);
    const current = this.store.task(taskId);
    this.resolution.update(current, { stop: null }, { reason: `${delegated ? `A delegated ${delegated.role} answered` : 'The operator answered'} the joint review question; the next review round continues with that answer` }, 'responsible_question_resumed', answer.slice(0, 2000));
  }
}
