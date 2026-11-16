import type { Task } from "../../shared/contracts";
import { doublingDelay } from "../../shared/backoff";
import type { Engine } from "../engine";
import { ProjectionOccurrences, titleOccurrenceKey } from "../scheduling/projection-occurrences";
import { taskReferenceLabel, taskWorkspaceTitle, type TitleReferenceLookup } from "./workspace-title";

/**
 * One task's durable workspace-title intent. `confirmed` is the title the host last
 * acknowledged, `intent` marks a send whose outcome is unknown, `error` and `failures`
 * are the last refusal and its count, and `retryAt` is the backoff the next sweep honours.
 */
export type WorkspaceTitleIntent = {
  desired: string;
  phase?: Task["phase"];
  held?: boolean;
  confirmed: string | null;
  requestId: string;
  intent: boolean;
  error: string;
  failures?: number;
  retryAt?: number;
};

/** The meta key one task's title intent is stored under. */
export const workspaceTitleIntentKey = (taskId: string): string => `workspaceTitle:${taskId}`;

/**
 * The workspace-title projection: one latest title intent per task, sent outside the
 * delivery lane pool so a slow host title never holds a callback, control or turn lane.
 * The durable intent carries its own failure and backoff, so a refused or unknown send is
 * retried by a later sweep instead of being resent blindly now. Cross-owner calls go
 * through the same-name `Engine` methods, so an instance override still fires.
 */
export class WorkspaceTitleProjection {
  /** One latest title intent per task; a re-enqueue coalesces onto the queued entry. */
  queue = new Set<string>();
  draining: Promise<void> | null = null;
  constructor(readonly engine: Engine, private readonly occurrences: ProjectionOccurrences) {}
  private get store() { return this.engine.store; }
  private get adapter() { return this.engine.adapter; }
  private get admission() { return this.engine.admission; }
  private get stopped() { return this.engine.stopped; }

  enqueue(taskId: string): void {
    if (this.stopped) return;
    if (!this.queue.has(taskId)) this.occurrences.enqueue(titleOccurrenceKey(taskId));
    this.queue.add(taskId);
    void this.engine.drainTitles();
  }

  drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      while (!this.stopped && this.queue.size) {
        const taskId = this.queue.values().next().value as string;
        this.queue.delete(taskId);
        const key = titleOccurrenceKey(taskId);
        this.occurrences.begin(key);
        try {
          // A purged task owes no title: the row that would carry the intent is gone too.
          const task = this.store.taskOrNull(taskId);
          if (task?.hostId) await this.engine.withHost(task.hostId, async () => {
            if (this.engine.taskHostAvailable(task)) await this.engine.syncWorkspaceTitle(task);
          });
        }
        // A send refusal is recorded by `sync` on the durable intent, which is also the
        // backoff the next sweep reads; a fault before the send names no intent to write.
        catch { /* the durable title intent records its own failure and backoff */ }
        this.occurrences.end(key);
      }
    })().finally(() => { this.draining = null; this.occurrences.settle(); });
    return this.draining;
  }

  async sync(task: Task): Promise<void> {
    if (!this.adapter.setTaskWorkspaceTitle) return;
    if (this.stopped) return;
    if (!task.workspaceId || task.resolution.archivedWorkspaceIds.includes(task.workspaceId)) return;
    const references: TitleReferenceLookup = taskId => {
      const candidate = this.store.taskOrNull(taskId);
      return candidate && candidate.removedAt == null ? taskReferenceLabel(candidate) : undefined;
    };
    const hasPendingQuestion = this.store.listDecisions({ status: 'open', task: task.id }).length > 0;
    const desired = taskWorkspaceTitle(hasPendingQuestion ? { ...task, waitState: { state: 'needs_operator_input', owner: 'operator' } } : task, references);
    const key = workspaceTitleIntentKey(task.id);
    const state = this.store.getMeta<WorkspaceTitleIntent>(key);
    // Work is emitted only from an actual phase transition: an unchanged,
    // already-confirmed title is not re-sent to Paseo on an ordinary sweep.
    if (state?.confirmed === desired && !state.intent && state.phase === task.phase && state.held === task.held) return;
    if (state?.desired === desired && state.retryAt && Date.now() < state.retryAt) return;
    // Degraded admission defers nonessential workspace mutation. The durable
    // intent is unchanged, so the next healthy sweep retries the same title.
    if (this.admission?.degradedNow) return;
    const uncertain = Boolean(state?.intent && state.desired === desired);
    const requestId = state?.desired === desired ? state.requestId : `ns-title-${task.id}-${task.version}`;
    const intent: WorkspaceTitleIntent = { desired, phase: task.phase, held: task.held, confirmed: state?.confirmed ?? null, requestId, intent: true, error: '', failures: state?.desired === desired ? state.failures ?? 0 : 0 };
    this.store.setMeta(key, intent);
    try {
      await this.adapter.setTaskWorkspaceTitle(task, desired, requestId, uncertain);
      this.store.setMeta(key, { desired, phase: task.phase, held: task.held, confirmed: desired, requestId, intent: false, error: '', failures: 0 } satisfies WorkspaceTitleIntent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failures = (state?.desired === desired ? state.failures ?? 0 : 0) + 1;
      const retryAt = Date.now() + doublingDelay(5_000, 300_000, failures);
      this.store.setMeta(key, { desired, phase: task.phase, held: task.held, confirmed: state?.confirmed ?? null, requestId, intent: true, error: message, failures, retryAt } satisfies WorkspaceTitleIntent);
      if (state?.error !== message) this.store.event(task.id, 'workspace_title_failed', message);
    }
  }
}
