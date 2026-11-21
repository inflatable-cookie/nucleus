/** Opt-in main-branch milestone scheduling; all execution uses ProjectQaRunner. */
import type { Notice, Project, ProjectQaRun, RepositorySettings } from '../../shared/contracts';
import { QA_MANAGED_LAUNCH_RETIRED } from '../../shared/contracts';
import { Decisions } from '../planning/decisions';
import { gitRaw } from '../hooks/hooks';
import { repositoryOrigin } from '../planning/lanes';
import { ProjectQaRunner } from './project-qa';
import { QaAdmissionRefusal, qaAdmissionRefusalResumesBatch, refuseQaAdmission } from './project-qa-refusals';
import { Store } from '../store/store';

/** True when a thrown value is the scheduler's own typed lifecycle refusal. */
const isQaScheduleRefusal = (error: unknown): error is QaAdmissionRefusal => error instanceof QaAdmissionRefusal;

type Merge = ReturnType<Store['qaScheduleMerges']>[number];
interface ScheduleState {
  enabledAt: string;
  requestGeneration: number;
  pending: { id: string; signature: string } | null;
  lastSignature: string | null;
  observedRun: string | null;
  redSince: string | null;
  lastReminderAt: string | null;
  decisionId: string | null;
  diagnostic: string;
}
export interface QaScheduleOptions {
  clock?: () => number;
  canAdmit?: () => boolean;
  refreshResponsibleThread?: (project: Project) => Promise<unknown>;
  includes?: (row: RepositorySettings, merge: Merge, run: ProjectQaRun) => Promise<boolean>;
}
export const qaScheduleStateKey = (key: string) => `projectQaSchedule:${key}`;
const active = (run: ProjectQaRun) => run.state === 'queued' || run.state === 'running';
const HOUR = 3_600_000;
/** A settlement notice stays live while its QA run exists; schedule notices keep their planner owner. */
export function qaNoticeOwner(store: Store, notice: Notice): string | null {
  if (notice.id.startsWith("project-qa-settled:")) {
    const runId = notice.taskId.startsWith("qa:") ? notice.taskId.slice(3) : "";
    return runId && store.qaRun(runId) ? notice.agentId : null;
  }
  return qaScheduleNoticeOwner(store, notice);
}

/** A scheduled notice remains eligible while its schedule and episode are current. */
export function qaScheduleNoticeProject(store: Store, notice: Notice): Project | null {
  const key = notice.taskId.slice('qa:'.length), row = store.repositoryFor(key);
  if (!row?.qa?.schedule) return null;
  const project = store.projectFor(row.repository.path, row.repository.origin);
  if (project?.visibility !== 'active') return null;
  if (notice.id.startsWith('qa-reminder:') || notice.id.startsWith('qa-admission:')) {
    const state = store.getMeta<ScheduleState>(qaScheduleStateKey(key));
    if (!state?.redSince || !notice.id.includes(state.redSince)) return null;
  }
  return project;
}

export function qaScheduleNoticeOwner(store: Store, notice: Notice): string | null {
  const project = qaScheduleNoticeProject(store, notice);
  return project ? store.projectPlannerRecipient(project) : null;
}

export class ProjectQaSchedules {
  private advancing: Promise<void> | null = null;
  private cursor = 0;
  constructor(readonly store: Store, readonly runner: ProjectQaRunner, readonly options: QaScheduleOptions = {}) {}
  /** One repository per pass; a slow Git fetch never serializes the task fleet. */
  tick(): Promise<void> {
    if (this.advancing) return this.advancing;
    const rows = this.store.repositories().filter(row => row.qa?.schedule);
    if (!rows.length || this.store.getMeta('paused')) return Promise.resolve();
    const row = rows[this.cursor++ % rows.length];
    this.advancing = this.advance(row).catch(error => {
      // Never hide a persistent checkout/coverage failure behind health=ready.
      if (this.options.canAdmit?.() === false) return;
      // A lifecycle refusal is one process's own pause, roll, handover or
      // configuration race: nothing was admitted, so nothing is recorded. Any
      // other failure is, including a guard that cannot read the store at all —
      // returning silently there hid real faults behind health=ready.
      if (isQaScheduleRefusal(error)) return;
      let guardFault: unknown = null;
      try { this.guard(row); } catch (thrown) { if (isQaScheduleRefusal(thrown)) return; guardFault = thrown; }
      const key = this.key(row), meta = qaScheduleStateKey(key), stamp = this.stamp();
      const diagnostic = String(guardFault ? `${String(error)}; ${String(guardFault)}` : error).slice(0, 2000);
      this.store.setMeta(`projectQaScheduleError:${key}`, diagnostic);
      const state = this.store.getMeta<ScheduleState>(meta) ?? this.initialState(stamp);
      state.diagnostic = diagnostic; state.redSince ??= stamp;
      const text = `Scheduled milestone QA for ${key} is blocked: ${diagnostic}\nMerge inventory/coverage could not be established; inspect outcome records. No QA was resubmitted.`;
      this.store.transaction(() => {
        if (!state.lastReminderAt) {
          this.notice(row, `qa-admission:${key}:${state.redSince}`, text); state.lastReminderAt = stamp;
        }
        this.remindAndEscalate(row, state, text, stamp);
        this.store.setMeta(meta, state);
      });
    }).finally(() => { this.advancing = null; });
    return this.advancing;
  }
  private key(row: RepositorySettings) { return row.repository.origin ?? row.repository.path; }
  private stamp() { return new Date(this.options.clock?.() ?? Date.now()).toISOString(); }
  /**
   * Every lifecycle boundary a scheduled admission must survive, thrown as a
   * typed refusal so the caller knows a race moved the world rather than the
   * owner failing. The pause/disable/settings case stays one code because one
   * read proves all three at once.
   */
  private guard(row: RepositorySettings) {
    if (this.options.canAdmit?.() === false) refuseQaAdmission('schedule_owner_closing', 'Scheduled QA owner is closing or disconnected');
    const current = this.store.repositoryFor(this.key(row));
    if (this.store.getMeta('paused') || !current?.qa?.schedule || current.revision !== row.revision)
      refuseQaAdmission('schedule_paused', 'Scheduled QA paused, disabled or repository settings changed before admission');
    const project = this.store.projectFor(current.repository.path, current.repository.origin);
    if (!project || project.visibility !== 'active' || !this.store.projectPlannerRecipient(project))
      refuseQaAdmission('schedule_no_planner', 'Scheduled QA requires an active project with a live responsible thread');
  }
  private async includes(row: RepositorySettings, merge: Merge, run: ProjectQaRun): Promise<boolean> {
    if (this.options.includes) return this.options.includes(row, merge, run);
    const resolved = await this.runner.resolveRepository(this.key(row), 'main');
    if (row.repository.origin && await repositoryOrigin(resolved.checkoutPath) !== row.repository.origin)
      throw new Error('Scheduled QA checkout origin changed');
    const result = await gitRaw(resolved.checkoutPath, ['merge-base', '--is-ancestor', merge.mergeCommit, run.base]);
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw new Error(`Cannot prove merge coverage for QA ${run.id}: ${result.stderr.trim()}`);
  }
  private owner(row: RepositorySettings) {
    return this.store.projectPlannerRecipient(this.store.projectFor(row.repository.path, row.repository.origin));
  }
  private notice(row: RepositorySettings, id: string, text: string) {
    const owner = this.owner(row);
    if (!owner) return;
    const taskId = `qa:${this.key(row)}`;
    if (this.store.notices(taskId).some(notice => notice.id === id)) return;
    this.store.putNotice({ id, taskId, agentId: owner, recipientAgentId: owner, originEntry: false,
      workspaceId: null, sources: [], kind: 'qa', status: 'pending', error: '', text });
  }
  private report(row: RepositorySettings, merges: Merge[], run: ProjectQaRun | null, diagnostic = '', verified: Merge[] = []) {
    return [`Nucleus scheduled milestone QA`, `Repository: ${this.key(row)}`,
      run ? `Run: ${run.id}\nHead: ${run.base}\nState: ${run.state}\nExit: ${run.exitCode ?? 'unknown'}\nFailed step: ${run.failedStep ?? 'none'}\n${run.outputTail}` : 'No admitted result yet.', diagnostic,
      ...(run?.state === 'passed' ? [`Merges covered since the previous green main run (${verified.length}):`,
        ...verified.slice(0,100).map(merge => `${merge.taskId} ${merge.title}\n${merge.prUrl ?? ''} ${merge.mergeCommit}`)] : []),
      `Merges not yet covered by a green main run (${merges.length}):`,
      ...merges.slice(0, 100).map(merge => `${merge.taskId} ${merge.title}\n${merge.prUrl ?? ''} ${merge.mergeCommit}`),
      ...(merges.length > 100 ? ['Remaining merges are in outcome records.'] : []),
      'This result grants no task approval or merge authority. Do not replay uncertain admission.'].join('\n');
  }
  private clearRed(state: ScheduleState) {
    if (state.decisionId) {
      const decision = this.store.decision(state.decisionId);
      if (decision.status === 'open') new Decisions(this.store).withdraw({ id: decision.id, version: decision.version,
        reason: 'A later main milestone QA passed; the scheduled QA failure episode ended.', withdrawnBy: decision.askedBy.agentId });
    }
    state.redSince = null; state.lastReminderAt = null; state.decisionId = null; state.diagnostic = '';
  }
  private initialState(stamp: string): ScheduleState {
    return { enabledAt: stamp, requestGeneration: 0, pending: null, lastSignature: null, observedRun: null,
      redSince: null, lastReminderAt: null, decisionId: null, diagnostic: '' };
  }
  private remindAndEscalate(row: RepositorySettings, state: ScheduleState, text: string, stamp: string) {
    if (!state.redSince) return;
    const key = this.key(row), at = Date.parse(stamp), interval = row.qa!.schedule!.maxIntervalHours * HOUR;
    if (at - Date.parse(state.lastReminderAt ?? state.redSince) >= interval) {
      this.notice(row, `qa-reminder:${key}:${state.redSince}:${Math.floor(at / interval)}`, text);
      state.lastReminderAt = stamp;
    }
    if (!state.decisionId && at - Date.parse(state.redSince) >= 24 * HOUR) {
      // Existing operator Decisions surface, not a Tom thread or content fix.
      state.decisionId = new Decisions(this.store).add({ askedBy: this.owner(row) ?? 'operator',
        project: row.repository.origin ? { origin: row.repository.origin, path: row.repository.path } : null,
        question: `Milestone QA for ${key} has remained unresolved for a day. How should it be resolved?`,
        context: text.slice(0,20000), options: ['Owner diagnoses and fixes the failure', 'Keep QA held pending an operator ruling'] }).id;
    }
  }
  async advance(row: RepositorySettings): Promise<void> {
    if (this.options.refreshResponsibleThread) {
      const project = this.store.projectFor(row.repository.path, row.repository.origin);
      if (project?.visibility === 'active') await this.options.refreshResponsibleThread(project);
    }
    this.guard(row);
    const key = this.key(row), meta = qaScheduleStateKey(key), stamp = this.stamp(), at = Date.parse(stamp);
    const schedule = row.qa!.schedule!, interval = schedule.maxIntervalHours * HOUR;
    const state = this.store.getMeta<ScheduleState>(meta) ?? this.initialState(stamp);
    const save = () => this.store.setMeta(meta, state);
    let pending = this.store.qaScheduleMerges(key);
    const beforeCoverage = pending;
    const runs = this.store.qaScheduleRuns(key);
    const runSnapshot = JSON.stringify(runs);
    const freshRuns = () => {
      this.guard(row);
      if (JSON.stringify(this.store.qaScheduleRuns(key)) !== runSnapshot)
        throw new Error('Milestone QA changed during coverage observation; reconcile on the next pass');
    };
    // Green is head/ancestry evidence, not a wall-clock cutoff. A late outcome
    // or a merge arriving after checkout capture cannot be silently credited.
    for (const run of [runs.green, runs.latest].filter((run): run is ProjectQaRun => Boolean(run && !active(run)))) {
      const included: string[] = [], checked: string[] = [];
      for (const merge of pending) {
        if (run.state === 'passed' ? merge.checkedGreenRun === run.id : merge.attemptedRun === run.id) continue;
        checked.push(merge.taskId);
        if (await this.includes(row, merge, run)) included.push(merge.taskId);
      }
      freshRuns();
      this.store.markQaScheduleMerges(included, run.id, run.state === 'passed');
      if (run.state === 'passed') this.store.checkQaScheduleGreen(checked, run.id);
    }
    freshRuns();
    pending = this.store.qaScheduleMerges(key);
    if (runs.latest && !active(runs.latest) && state.observedRun !== runs.latest.id) {
      this.notice(row, `qa-result:${runs.latest.id}`, this.report(row, pending, runs.latest, '', beforeCoverage.filter(merge => !pending.some(left => left.taskId === merge.taskId))));
      state.observedRun = runs.latest.id;
      if (runs.latest.state === 'passed') this.clearRed(state);
      else { state.redSince ??= runs.latest.finishedAt ?? stamp; state.lastReminderAt = stamp; }
    }
    pending = this.store.qaScheduleMerges(key);
    // Reconcile our durable request before considering another admission. An
    // unresolved old owner/response remains a hold, never permission to retry.
    if (state.pending) {
      // A predecessor's interrupted preparation settles first, so the batch
      // resumes under a new generation instead of waiting on it for good.
      this.runner.settleInterruptedPreparations();
      const request = this.runner.requestStatus({ requestId: state.pending.id }).requests[0];
      if (request?.state === 'admitted') {
        state.lastSignature = null; state.pending = null; state.diagnostic = '';
      } else if (request?.state === 'refused') {
        // A post-await lifecycle guard proves no run was claimed. Resume the
        // batch with a new durable identity once eligible; never replay the
        // refused identity or relabel unknown preparing delivery as refusal.
        // The typed code is the fact: no diagnostic text is read to decide this.
        const lifecycleRefusal = qaAdmissionRefusalResumesBatch(request.refusalCode);
        state.lastSignature = lifecycleRefusal ? null : state.pending.signature;
        state.pending = null; state.diagnostic = lifecycleRefusal ? '' : request.diagnostic;
        if (lifecycleRefusal) state.requestGeneration = (state.requestGeneration ?? 0) + 1;
      } else state.diagnostic = `QA admission unresolved: ${state.pending.id}; inspect project.qa.request-status`;
    }
    if (state.diagnostic) {
      state.redSince ??= stamp;
      if (!state.lastReminderAt) {
        this.notice(row, `qa-admission:${key}:${state.redSince}`, this.report(row, pending, null, state.diagnostic));
        state.lastReminderAt = stamp;
      }
    }
    this.store.transaction(() => {
      this.remindAndEscalate(row, state, this.report(row, pending, runs.latest, state.diagnostic), stamp);
      save();
    });
    save();
    if (state.pending || runs.active) return;
    const fresh = pending.filter(merge => !merge.attemptedRun);
    if (!fresh.length) return; // Reminder/escalation, not repeated unchanged red QA.
    const lastAttempt = runs.latest?.submittedAt ?? runs.latest?.startedAt ?? state.enabledAt;
    if (fresh.length < schedule.afterMerges && at - Date.parse(lastAttempt) < interval) return;
    // nucleus#1475: managed milestone QA launch is retired, so a schedule never
    // admits another run. The batch waits whole under one durable notice that
    // names the report-only recipe; clearing `qa.schedule` removes the row from
    // this pass, which removes the notice with it. Nothing is orphaned: an
    // admitted or running run keeps settling through the recovery and teardown
    // owners, and every settled run stays readable.
    this.notice(row, `qa-managed-retired:${key}`, QA_MANAGED_LAUNCH_RETIRED);
    save();
  }
}
