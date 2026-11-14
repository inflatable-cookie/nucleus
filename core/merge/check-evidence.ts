import type { Task } from '../../shared/contracts';
import type { Resolution } from '../resolution';
import type { CheckObservationFields, MergeGateResult, RequiredChecksResult } from '../resolution';
import { checkHistoryFromStore, checkPolicyObservationKey, type CheckObservation } from '../forge/index';
import { now } from '../store/store';
import { MERGE_GATE_SETTINGS_ATTEMPTS } from '../recovery/task-reasons';

/** The adapter, settings and store facts one check observation reads. */
export type CheckEvidenceContext = Pick<Resolution, 'adapter' | 'reviewerSetting'> & { readonly store: Resolution['store'] };

/**
 * The settings-bound check evidence: every observation is read against the
 * repository settings revision it ran under, so a policy that changed during the
 * read never decides a merge or a check wait. One observation loop serves the
 * merge gate and the pending-check poll, and it records the bounded advisory
 * observation both of them produce.
 */
export class CheckEvidence {
  constructor(readonly context: CheckEvidenceContext) {}
  private get store() { return this.context.store; }
  private get adapter() { return this.context.adapter; }
  /** The monotonic write revision of the repository settings row a gate reads, so evidence is bound to the settings it was observed under. */
  settingsRevision(t: Task): number | null {
    return this.store.canonicalRepository(t.repoPath, t.repository)?.revision ?? null;
  }
  /**
   * A gate result is usable only while the settings row it read has not changed.
   * Evidence that names no revision is current only while there is still no
   * settings row to have changed: an unknown revision is never silently current.
   */
  settingsCurrent(t: Task, gate: MergeGateResult): boolean {
    const current = this.settingsRevision(t);
    return gate.settingsRevision === undefined
      ? current === null
      : gate.settingsRevision === current;
  }
  /**
   * Always pass store-backed check history; admission snapshots mergeGate before
   * any Engine wrap. A settings write during the observation makes its check
   * policy stale, so the gate is re-observed rather than used: a policy that
   * changed mid-gate never decides a merge. If the row keeps moving, the gate
   * holds visibly instead of merging on evidence from an unknown policy.
   */
  async mergeGate(t: Task): Promise<MergeGateResult> {
    return this.settingsBoundObservation(t, revision => this.adapter.mergeGate!(t,
      checkHistoryFromStore(this.store, t.repoPath, Date.now(), t.prHead ?? ""),
      this.context.reviewerSetting(t) ?? undefined, this.store.checksPolicyFor(t)), {
      timings: observed => observed.timings,
      observed: 'the merge gate observed hosted checks',
      then: 'using its result',
    }, current => {
      this.store.event(t.id, 'merge_gate_settings_changed', `Repository settings changed during ${MERGE_GATE_SETTINGS_ATTEMPTS} consecutive merge-gate observations; holding instead of merging on a stale policy`);
      return { head: current.prHead ?? '', base: current.resolution.mergeBase ?? '', wait: 'Repository settings have been changing during the merge gate; re-observing the exact-head gates' };
    });
  }
  /** The same freshness-checked read for the pending-check poll, which yields the integration turn and is re-run before any merge. */
  async requiredChecks(t: Task): Promise<RequiredChecksResult> {
    return this.settingsBoundObservation(t, revision => this.adapter.requiredChecks
      ? this.adapter.requiredChecks(t, checkHistoryFromStore(this.store, t.repoPath, Date.now(), t.prHead ?? ""), this.store.checksPolicyFor(t))
      : this.mergeGate(t), {
      observed: 'required checks were observed',
      then: 'acting on the result',
    }, current => ({ head: current.prHead ?? '', wait: 'Repository settings have been changing during the required-check observation; re-observing the exact-head gates', pendingCheck: true }));
  }
  /** One observation, repeated only while the settings revision it read changed under it. */
  private async settingsBoundObservation<T extends { head?: string } & CheckObservationFields>(
    t: Task,
    observe: (revision: number | null) => Promise<T>,
    record: { timings?: (observed: T) => Record<string, number> | undefined; observed: string; then: string },
    exhausted: (current: Task) => T,
  ): Promise<T> {
    for (let attempt = 0; attempt < MERGE_GATE_SETTINGS_ATTEMPTS; attempt++) {
      const revision = this.settingsRevision(t);
      const observed = await observe(revision);
      const after = this.settingsRevision(t);
      const timings = record.timings?.(observed);
      if (timings) this.store.event(t.id, 'merge_gate_steps', JSON.stringify(timings));
      this.recordObservation(t, { ...observed, settingsRevision: revision });
      if (revision === after) return { ...observed, settingsRevision: revision };
      this.store.event(t.id, 'merge_gate_settings_changed', `Repository settings changed from revision ${revision} to ${after} while ${record.observed}; re-observing before ${record.then}`);
    }
    return exhausted(this.store.task(t.id));
  }
  observationLine(check: CheckObservation) {
    return `${check.name} [${check.classification}] ${check.identity}${check.databaseId === null ? '' : `#${check.databaseId}`}${check.appId === null ? '' : ` app ${check.appId}`} ${check.state}${check.conclusion ? `:${check.conclusion}` : ''} (job URL: ${check.jobUrl})`;
  }
  /**
   * Task 382: record the bounded hosted-check observation an advisory policy
   * produced, so both the required results that gated the task and the negative
   * non-required results stay visible in task detail at the exact head. The
   * record names the settings revision whose policy produced it, is
   * deduplicated on the observed facts (never on the observation time) and
   * replaces the previous head's record, so it cannot grow without bound.
   * Recorded evidence never rewrites a check outcome, a prior author return or
   * a review, and proves no targeted test ran.
   */
  recordObservation(t: Task, gate: { head?: string } & CheckObservationFields) {
    if (gate.checksPolicy !== 'required') return;
    const head = gate.head ?? t.prHead ?? '';
    const facts = {
      head,
      policy: 'required' as const,
      settingsRevision: gate.settingsRevision ?? null,
      requirements: gate.requirements ?? null,
      required: (gate.requiredEvidence ?? []).slice(0, 50),
      advisory: (gate.advisory ?? []).slice(0, 50),
    };
    const encoded = JSON.stringify(facts);
    const key = checkPolicyObservationKey(t.id);
    const previous = this.store.getMeta<{ digest: string; observedAt: string } & typeof facts>(key);
    if (previous?.digest === encoded) return;
    this.store.setMeta(key, { ...facts, digest: encoded, observedAt: now() });
    const requirements = facts.requirements?.known
      ? `${facts.requirements.required} required check(s) for the base branch`
      : `required checks unknown: ${facts.requirements?.reason ?? 'not observed'}`;
    const required = facts.required.map(check => this.observationLine(check)).join(', ');
    const advisory = facts.advisory.map(check => this.observationLine(check)).join(', ');
    const detail = `Checks policy 'required' at ${head.slice(0, 12)} (settings revision ${facts.settingsRevision ?? 'unknown'}): ${requirements}`
      + `; required: ${required || 'none observed'}; advisory: ${advisory || 'none observed'}`;
    this.store.event(t.id, 'check_policy_observation', detail.slice(0, 2000));
  }
}
