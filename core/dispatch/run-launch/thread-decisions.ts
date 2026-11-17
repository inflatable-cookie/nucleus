/**
 * The thread-choice rules for a launch, as typed facts in and one decision out.
 * Every caller states the facts it observed; no rule reads a task, an event or
 * a provider message. `RunLaunchThread` applies the decision.
 */
/** Keep the retained thread, drop it for a fresh agent, or reselect its profile. */
export type LaunchThreadDecision = 'keep' | 'fresh' | 'reselect' | 'wait' | 'attention' | 'continue';
export type ExecutorThreadFacts =
  | { stage: 'collision'; collided: boolean }
  | { stage: 'replacement'; allowed: boolean; profileMismatch: boolean }
  | { stage: 'unbound' };
/** Task 405/582: a proof executor never resumes another role; consecutive proofs keep one executor thread unless replacement is allowed. */
export function executorThreadDecision(facts: ExecutorThreadFacts): LaunchThreadDecision {
  switch (facts.stage) {
    case 'collision': return facts.collided ? 'fresh' : 'continue';
    case 'replacement':
      if (facts.allowed) return 'fresh';
      return facts.profileMismatch ? 'reselect' : 'keep';
    case 'unbound': return 'fresh';
  }
}

export type ReviewerThreadFacts =
  | { stage: 'author'; authored: boolean; superseding: boolean; reselected: boolean }
  | { stage: 'issue'; issue: boolean; atLimit: boolean; selected: boolean }
  | { stage: 'round'; eligible: boolean }
  | { stage: 'unbound_profile'; drop: boolean }
  | { stage: 'critical_fresh'; critical: boolean; explicitProfile: boolean }
  | { stage: 'select'; hasProfile: boolean; selected: boolean };
/**
 * Whether the retained reviewer launches again, a fresh agent takes the
 * profile, or selection picks another route. Wait and attention stay the
 * caller's visible stops when no independent profile exists.
 */
export function reviewerThreadDecision(facts: ReviewerThreadFacts): LaunchThreadDecision {
  switch (facts.stage) {
    case 'author':
      if (!facts.authored) return 'continue';
      if (facts.reselected) return 'reselect';
      return 'fresh';
    case 'issue':
      if (!facts.issue) return 'continue';
      if (facts.atLimit) return 'attention';
      return facts.selected ? 'reselect' : 'wait';
    case 'round': return facts.eligible ? 'keep' : 'fresh';
    case 'unbound_profile': return facts.drop ? 'fresh' : 'continue';
    case 'critical_fresh': return facts.critical && !facts.explicitProfile ? 'fresh' : 'continue';
    case 'select':
      if (facts.hasProfile) return 'keep';
      return facts.selected ? 'reselect' : 'wait';
  }
}

/** A released round does not require a replacement reviewer, even without a report. */
export function reviewerRoundEligible(prior: { released?: boolean; status?: string; completion?: unknown; retainedRounds?: number | null; head?: string } | null | undefined, prHead: string | null | undefined): boolean {
  void prHead;
  return !prior || Boolean(prior.released && ['finished', 'superseded'].includes(prior.status ?? ''));
}

/** The one condition that made a retained reviewer ineligible for another round. */
export type ReviewerSwapCondition = 'round' | 'participant' | 'runtime' | 'context' | 'error';
