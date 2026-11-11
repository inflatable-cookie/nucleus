import type { CheckpointIntent, Task } from '../../shared/contracts';
import { CHECKPOINT_BUDGET, isDispositionActive } from '../../shared/contracts';
import { randomBytes } from 'node:crypto';
import { now } from '../store/store';
import { checkpointPrompt } from '../dispatch/prompts';
import type { Resolution } from '../resolution';

/**
 * Bounded worker checkpoint continuation.
 *
 * The durable accepted record and the persisted continuation intent are the
 * restart and duplicate-delivery authority. A pending intent is delivered at
 * most twice (the original attempt plus one restart resume) through the exact
 * retained worker, workspace and branch; the intent id is reused as the message
 * identity, so a replay never creates a second turn. Failed or uncertain
 * provider delivery hands the fault to ordinary attention instead of looping.
 */
export type CheckpointsContext = Pick<Resolution, 'adapter' | 'attention' | 'hostAvailable' | 'paused' | 'store' | 'withHost'>;

export class Checkpoints {
  constructor(readonly resolution: CheckpointsContext) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }

  /** Deliver each persisted continuation intent to the same retained worker exactly once. */
  async pass() {
    for (const initial of this.store.maintenanceTasks()) {
      if (this.resolution.paused()) return;
      const task = this.store.task(initial.id);
      if (!task.hostId || !this.resolution.withHost(task.hostId, () => this.resolution.hostAvailable(task))) continue;
      const intent = task.checkpoints.intent;
      if (!intent) continue;
      if (isDispositionActive(task)) continue;
      if (intent.status === 'delivered') continue;
      const target = this.continuationTarget(task, intent);
      if (!target) { this.clear(task, intent, 'the checkpoint run is no longer the task\'s current worker run'); continue; }
      const closedTurn = target.runId === task.runId ? Boolean(task.completion) : false;
      if (closedTurn || !['working', 'dispatching', 'needs_attention', ...(target.runId === task.runId ? [] : ['changes_requested'])].includes(task.phase)) { this.clear(task, intent, 'the worker result closed the turn before continuation'); continue; }
      if (intent.status === 'uncertain') continue;
      await this.resolution.withHost(task.hostId, () => this.deliver(target, intent));
    }
  }

  /**
   * The task view a checkpoint intent continues: the initial worker on the task
   * row, or the task's current revision run. Null when that run is gone, settled
   * or no longer the retained worker's own revision.
   */
  private continuationTarget(task: Task, intent: CheckpointIntent): Task | null {
    if (intent.runId === task.runId) return task;
    const run = this.store.run(intent.runId);
    if (!run || run.role !== 'revision' || run.released || run.completion
      || task.resolution.currentRunId !== run.id || run.agentId !== task.agentId || run.workspaceId !== task.workspaceId) return null;
    return { ...task, runId: run.id };
  }

  private async deliver(task: Task, intent: CheckpointIntent) {
    if (!task.agentId || !task.workspaceId || !task.runId) {
      this.save(task, intent, { status: 'uncertain', error: 'The retained worker identity is missing' });
      this.resolution.attention(this.store.task(task.id), 'Checkpoint continuation requires the retained worker, workspace and run; inspect the task before resuming');
      return;
    }
    if (!this.adapter.continueWorker) {
      this.save(task, intent, { status: 'uncertain', error: 'No continuation delivery channel' });
      this.resolution.attention(this.store.task(task.id), 'No delivery channel exists for the checkpoint continuation; coordinator attention required');
      return;
    }
    if (!this.adapter.preflightWorkerContinuation) {
      this.failPreflight(task, intent, 'Retained worker workspace preflight is unavailable; no continuation was sent');
      return;
    }
    let workspace: { available: true } | { available: false; reason: string };
    try {
      workspace = await this.adapter.preflightWorkerContinuation(task);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const detail = `${intent.id}: retained worker workspace could not be checked before continuation dispatch: ${message}`.slice(0, 2000);
      const previous = this.store.events(task.id).at(-1);
      if (previous?.kind !== 'checkpoint_continuation_preflight_deferred' || previous.detail !== detail)
        this.store.event(task.id, 'checkpoint_continuation_preflight_deferred', detail);
      return;
    }
    if (!workspace.available) {
      this.failPreflight(task, intent, workspace.reason);
      return;
    }
    if (intent.attempts >= 2) {
      this.save(task, intent, { status: 'uncertain', error: 'Bounded continuation delivery attempts are exhausted' });
      this.resolution.attention(this.store.task(task.id), 'Checkpoint continuation delivery remains unresolved after its bounded attempts; inspect the retained thread before retrying');
      return;
    }
    // Persist the attempt count before sending. A crash before the confirmation
    // leaves the intent pending, so restart resumes it once with the same
    // message identity; a thrown transport error fails closed into attention.
    const attempted = this.save(task, intent, { attempts: intent.attempts + 1 });
    // The intent names the run that stopped: the initial worker on the task row, or
    // the task's current revision run. Delivery and its credential follow that run.
    const continued = intent.runId === attempted.runId ? attempted : { ...attempted, runId: intent.runId };
    try {
      await this.adapter.continueWorker(continued, intent.id, checkpointPrompt(continued, intent), () => {
        // Only a rotated binding needs a fresh credential; a matched binding is
        // left byte-for-byte as the running session already holds it.
        const token = randomBytes(32).toString('hex');
        this.store.setCredential(continued.runId!, token);
        return { runId: continued.runId!, token };
      });
      if (this.resolution.paused()) return;
      this.store.transaction(() => {
        const current = this.store.task(task.id);
        const latest = current.checkpoints.intent;
        if (!latest || latest.id !== intent.id) return;
        this.store.event(current.id, 'checkpoint_continued', `${intent.ordinal}/${CHECKPOINT_BUDGET} ${intent.id} run ${intent.runId} at ${intent.head}`);
        this.save(current, latest, { status: 'delivered', deliveredAt: now(), error: '' });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.save(this.store.task(task.id), intent, { status: 'uncertain', error: message.slice(0, 2000) });
      this.resolution.attention(this.store.task(task.id), `Checkpoint continuation delivery failed: ${message}`);
    }
  }

  private failPreflight(task: Task, intent: CheckpointIntent, reason: string) {
    const evidence = reason.slice(0, 2000);
    this.save(task, intent, { status: 'uncertain', error: evidence });
    this.store.event(task.id, 'checkpoint_continuation_preflight_failed', `${intent.id}: ${evidence}`);
    this.resolution.attention(this.store.task(task.id), `Checkpoint continuation was not sent: ${evidence}`);
  }

  private clear(task: Task, intent: CheckpointIntent, detail: string) {
    const current = this.store.task(task.id);
    if (current.checkpoints.intent?.id !== intent.id) return;
    this.store.update(current.id, { checkpoints: { ...current.checkpoints, intent: null } }, 'checkpoint_intent_superseded', `${intent.id}: ${detail}`);
  }

  private save(task: Task, intent: CheckpointIntent, patch: Partial<CheckpointIntent>): Task {
    const current = this.store.task(task.id);
    const latest = current.checkpoints.intent;
    if (!latest || latest.id !== intent.id) return current;
    return this.store.update(current.id, { checkpoints: { ...current.checkpoints, intent: { ...latest, ...patch } } });
  }
}
