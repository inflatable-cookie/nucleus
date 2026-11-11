import type { Task } from '../../shared/contracts';
import { qaCapacityWaitReason } from '../../shared/wait-state';
import type { Resolution } from '../resolution';
import { latestRunCompletion } from '../store/store';
import { VALIDATION_SCAN_PASS_LIMIT, VALIDATION_SCAN_PASS_MAX_MS, repositoryQaArgv } from '../recovery/task-reasons';
import type { WorktreeValidationScan } from '../workspaces/worktree-validation';

/** Whether validation is alive in a task's worktree, with one host scan per pass. */
export class ValidationEvidence {
  constructor(readonly resolution: Resolution) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  get hooks() { return this.resolution.hooks; }

  /** Tests replace this with a stub; production scans the worktree for `effigy qa` / repo QA. */
  /**
   * The worktree validation scan comes from the adapter, like every other host
   * observation: the Paseo adapter reads the live process table; an adapter that
   * offers no scan observes no validation. Tests may still set this directly.
   */
  worktreeValidationProbe: (directory: string, extraArgv: string[][]) => WorktreeValidationScan =
    (directory, extraArgv) => this.adapter.worktreeValidation ? this.adapter.worktreeValidation(directory, extraArgv) : { state: 'absent' };
  /**
   * This pass's worktree-validation scans, keyed by the exact evidence each one
   * answers for (task, worktree directory, effective selector argv and the run
   * being judged). In memory only: `beginValidationScanPass` clears it, no entry
   * answers in a later pass, and none answers for longer than
   * `validationScanShareMs`. See `validationEvidence`.
   */
  private validationScanPass = 0;
  private readonly validationScans = new Map<string, { pass: number; at: number; scan: WorktreeValidationScan }>();
  /** The longest one shared scan may answer, even inside one pass. `0` disables sharing. */
  validationScanShareMs = VALIDATION_SCAN_PASS_MAX_MS;
  /**
   * True while a Queue-scheduled client host run or a live `effigy qa` / repo QA
   * process is still in the task worktree, or while that scan is unverified.
   * Sets the waiting reason as a side effect. An unverified scan is not absence.
   */
  async heavyRunAlive(t: Task): Promise<boolean> {
    const found = this.resolution.validationEvidence(t);
    const runs = this.store.runs(t.id);
    const revisionBlock = latestRunCompletion(runs.filter(run => run.role === 'revision'), ['blocked', 'error']);
    const currentWorkerBlock = t.completion && t.completion.runId === t.runId && ['blocked', 'error'].includes(t.completion.status)
      ? t.completion : null;
    const blockedWorkerSummary = ['blocked', 'error'].includes(t.phase)
      ? revisionBlock?.summary ?? currentWorkerBlock?.summary ?? null
      : t.phase === 'working' ? currentWorkerBlock?.summary ?? null : null;
    if (found.state === 'unverified') {
      this.resolution.waiting(t, found.reason, 'validation');
      return true;
    }
    if (blockedWorkerSummary) {
      // Spec 058 slice 17: a ladder park (consult or planner escalation) owns the
      // visible wait; the blocked summary must not overwrite it with operator_needed.
      const stop = this.store.task(t.id).resolution.stop;
      if (stop?.reason !== 'escalated' && stop?.reason !== 'responsible_question')
        this.resolution.waiting(t, `Waiting for blocked-report classification: ${blockedWorkerSummary}`, 'lifecycle');
    }
    else if (found.state === 'alive') this.resolution.waiting(t, found.reason, 'validation');
    return found.state === 'alive';
  }
  /**
   * Live validation in the worktree without writing task state. Incomplete scans
   * are not live. Always a fresh scan: the callers release a retained run's lease
   * or hand a stopped revision back to work, which is not a decision a scan taken
   * earlier in the pass may authorize.
   */
  validationAlive(t: Task): { reason: string } | null {
    const found = this.resolution.validationEvidence(t, { fresh: true });
    return found.state === 'alive' ? { reason: found.reason } : null;
  }
  /**
   * Host-run or worktree-QA evidence. `absent` is a complete scan with no match;
   * `unverified` is a listing this host could not finish and is never absence.
   *
   * One pass asks the host at most once per worktree evidence: repeated reads in
   * the same pass (the stopping run, its reminder and its recovery route) share
   * the pass's scan, and the next pass reads again. `fresh` is for the contexts
   * that decide a consequential action — a recovery launch, a revision — where
   * the answer must be this moment's, including after work has appeared since an
   * earlier read. `unverified` is never shared: it is a failed listing, not an
   * observation, and the next read retries it (with the listing's own bounded
   * retry inside `findWorktreeValidation`).
   */
  validationEvidence(t: Task, options: { fresh?: boolean } = {}): { state: 'alive'; reason: string } | { state: 'unverified'; reason: string } | { state: 'absent' } {
    if (!t.directory) return { state: 'absent' };
    if (this.hooks) {
      const run = this.hooks.liveClientHostRunAt(t.directory);
      if (run) return { state: 'alive', reason: run.state === 'queued'
        ? qaCapacityWaitReason(run.position ?? 1)
        : run.state === 'admitted' ? "Worker's QA run was admitted by Nucleus and is starting"
          : "Worker's QA run is running under Nucleus's scheduler" };
    }
    const found = this.resolution.worktreeValidationFor(t, options.fresh === true);
    if (found.state === 'alive') return { state: 'alive', reason: `Worker's validation is still running in the worktree: ${found.command.slice(0, 120)}` };
    if (found.state === 'unverified') return { state: 'unverified', reason: `Worktree validation scan is unverified (${found.reason}); holding rather than treating QA as absent` };
    return { state: 'absent' };
  }
  /**
   * Begin one lifecycle pass (the task quantum). Scans taken before it never
   * answer inside it, so a task that starts work, a new run or a new checkout is
   * observed by the pass that follows, not by the one that already read.
   */
  beginValidationScanPass(): void {
    this.validationScanPass++;
    this.validationScans.clear();
  }
  /**
   * The scan behind `validationEvidence`: one host read per pass for one task's
   * worktree and selector argv. A shared answer must still be from this pass and
   * no older than `validationScanShareMs`, and only complete scans (`alive`,
   * `absent`) are kept — an unverified listing is never remembered as an
   * observation of anything.
   */
  worktreeValidationFor(t: Task, fresh: boolean): WorktreeValidationScan {
    const argv = repositoryQaArgv(this.store, t);
    const key = JSON.stringify([t.id, t.directory, argv, t.runId, t.resolution.currentRunId ?? null]);
    const shared = this.validationScans.get(key);
    const at = Date.now();
    if (!fresh && shared && shared.pass === this.validationScanPass && at - shared.at < this.validationScanShareMs) return shared.scan;
    const scan = this.worktreeValidationProbe(t.directory!, argv);
    if (scan.state === 'unverified') { this.validationScans.delete(key); return scan; }
    if (this.validationScans.size >= VALIDATION_SCAN_PASS_LIMIT) this.validationScans.delete(this.validationScans.keys().next().value!);
    this.validationScans.set(key, { pass: this.validationScanPass, at, scan });
    return scan;
  }
}
