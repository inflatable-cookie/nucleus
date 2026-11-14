import type { Engine } from '../engine';
import type { Task } from '../../shared/contracts';
import { isDispositionActive } from '../../shared/contracts';
import type { Adapter } from '../host/adapter';
import type { Resolution } from '../resolution';
import { capacityRefusal, dispatchBlocked } from './capacity';
import { startsNoRuns } from '../closeout/queue-drain';
import type { ReviewEntryInput } from '../../shared/contracts';
import {
  assertReviewEntryUnowned, assertReviewEntryWriterYielded, reviewEntryInputForTask, ReviewEntryRefusal,
  verifyReviewEntry, type ReviewEntryAdapter,
} from '../review/review-entry';

/** The engine and resolution facts review-entry admission reads. */
export type ReviewEntryAdmissionContext = Pick<Engine,
  'adapter' | 'cleanContext' | 'host' | 'hostAvailable' | 'hooks' | 'note' | 'notePreDispatchHold' | 'noteStepFailure'
  | 'store' | 'wakeRepository' | 'withHost'> & {
    readonly resolution: Pick<Resolution, 'requiredRouteNote' | 'select' | 'usageCeilingNote'>;
  };

/**
 * The review adapter an admission uses when the task's origin host is not the
 * host running this admission: the originating thread and its state are read on
 * the origin host, and the inspection runs there, so acceptance never proves a
 * foreign host's thread against the local catalog.
 */
function originHostReviewAdapter(context: ReviewEntryAdmissionContext, adapter: Adapter & ReviewEntryAdapter,
  originHostId: string, reviewInput: ReviewEntryInput): ReviewEntryAdapter {
  return {
    hostId: adapter.hostId,
    originAgent: id => context.host.originAgent(id),
    ...(adapter.reviewEntryGithubCommand ? { reviewEntryGithubCommand: adapter.reviewEntryGithubCommand.bind(adapter) } : {}),
    inspectReviewEntry: async (input, taskId) => {
      const proof = await context.withHost(originHostId, async () => {
        const origin = await context.host.originAgent(reviewInput.submission.originAgentId);
        if (!origin || origin.archived || !origin.workspaceId) throw new Error('Review entry requires a live originating thread');
        return { origin, state: await context.host.observe(origin.id) };
      });
      return adapter.inspectReviewEntry(input, taskId, proof);
    },
  };
}

/**
 * Review-entry admission: prove the external submission's source, then bind the
 * task to the exact base it was proved at and hand it to an independent reviewer.
 * The proof runs before the awaited pre-dispatch hook; admission re-proves the
 * writer's yield as the last awaited proof and re-checks every gate inside the
 * transaction that writes the binding. A transient condition keeps the task
 * queued with its reason instead of parking it.
 */
export class ReviewEntryAdmission {
  constructor(readonly context: ReviewEntryAdmissionContext) {}
  get store() { return this.context.store; }
  get adapter() { return this.context.adapter; }
  get resolution() { return this.context.resolution; }
  async admit(task: Task): Promise<void> {
    if (!task.reviewEntry || !this.adapter.inspectReviewEntry || !this.adapter.originAgent) throw Error('Review-entry task is missing immutable provenance or adapter support');
    // Task 405: an unreleased run (including a proof executor finishing its turn)
    // owns the workspace; review admission waits for it to be observed and released.
    if (this.store.runs(task.id).some(run => !run.released)) return;
    if (!this.resolution.select(task, 'reviewer')) {
      this.context.note(task.id, `No eligible independent reviewer profile; check the profile pool${this.resolution.requiredRouteNote(task, 'reviewer') || this.resolution.usageCeilingNote(task, 'reviewer')}`, 'route_unavailable');
      this.store.markRoutingAttempt(task.id);
      void this.context.cleanContext(() => this.context.wakeRepository(task.repoPath));
      return;
    }
    const input = reviewEntryInputForTask(task);
    try {
      const target = this.adapter as Adapter & ReviewEntryAdapter;
      if (!task.originHostId) { if (task.reason !== 'Waiting for a proven origin host') this.context.note(task.id, 'Waiting for a proven origin host', 'lifecycle'); return; }
      if (!this.context.withHost(task.originHostId, () => this.context.hostAvailable(task.originHostId!))) {
        const reason = `Waiting for origin host ${task.originHostId}`;
        if (task.reason !== reason) this.context.note(task.id, reason, 'lifecycle');
        return;
      }
      const reviewAdapter = task.originHostId === task.hostId ? target : originHostReviewAdapter(this.context, target, task.originHostId, input);
      const proof = await verifyReviewEntry(input, reviewAdapter, { allowBaseAdvance: true, taskId: task.id });
      const latest = this.store.task(task.id);
      if (latest.phase !== "queued" || dispatchBlocked(latest) || isDispositionActive(latest) || startsNoRuns(this.store)) return;
      const dependencyWait = this.store.dependencyWait(latest);
      if (dependencyWait) return;
      if (capacityRefusal(this.store, latest)) return;
      const preDispatch = await this.context.hooks.emit("task.pre_dispatch", latest, { event: "task.pre_dispatch", baseCommit: proof.base, summary: latest.reason });
      if (preDispatch.hold) { this.context.notePreDispatchHold(latest.id, preDispatch); return; }
      // The writer observation inside verifyReviewEntry bounds acceptance only:
      // it precedes the awaited hook and canonical proofs above. Admission is the
      // execution decision, so the writer's yield is re-proved here as the last
      // awaited proof before the admission write. A writer that resumed during
      // those proofs keeps the task queued with its visible wait instead of
      // promising independent review.
      try { await assertReviewEntryWriterYielded(input, reviewAdapter, task.id); }
      catch (error) {
        if (error instanceof ReviewEntryRefusal && error.transient) { this.context.note(task.id, error.message, 'origin_busy'); return; }
        throw error;
      }
      this.store.transaction(() => {
        const current = this.store.task(task.id);
        if (current.phase !== "queued" || dispatchBlocked(current) || isDispositionActive(current)) throw Error('Review-entry admission changed before binding');
        if (this.store.runs(current.id).some(run => !run.released)) throw Error('Review-entry admission changed before binding');
        if (startsNoRuns(this.store)) return null;
        const wait = this.store.dependencyWait(current);
        if (wait) return wait;
        assertReviewEntryUnowned(this.store, input, current.id);
        if (capacityRefusal(this.store, current)) throw Error('Concurrent task-slot limit reached');
        this.store.update(current.id, { phase: "awaiting_review", planningBase: proof.base, reviewEntry: { ...current.reviewEntry!, dispatchBase: proof.base }, reason: "Review entry admitted; awaiting independent review" }, "review_entry_admitted", proof.head);
        return null;
      });
    } catch (error) {
      // A transient admission condition (an active origin or workspace turn)
      // waits in `queued` with its reason instead of parking the task in
      // needs_attention; the next admission pass retries and the wait clears
      // itself once the condition ends. The pending handover this task was
      // accepted under is a source-writer wait: it has no owner verb, because
      // only the writer yielding clears it. A foreign Queue ownership conflict
      // is not transient and still parks.
      if (error instanceof ReviewEntryRefusal && error.transient) {
        this.context.note(task.id, error.message, error.code === 'workspace_busy' ? 'origin_busy' : 'classify');
        return;
      }
      this.context.noteStepFailure(task.id, error);
    }
  }
}
