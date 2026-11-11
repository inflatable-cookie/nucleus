import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  executorThreadDecision, reviewerThreadDecision, reviewerRoundEligible,
  type ExecutorThreadFacts, type LaunchThreadDecision, type ReviewerThreadFacts,
} from '../core/dispatch/run-launch/thread';
import { revisionRunPlan, type RevisionRunFacts, type RevisionRunPlan } from '../core/dispatch/run-launch/source';

test('executorThreadDecision outcomes', () => {
  const cases: [string, ExecutorThreadFacts, LaunchThreadDecision][] = [
    ['collision with another role drops the binding', { stage: 'collision', collided: true }, 'fresh'],
    ['no collision continues observation', { stage: 'collision', collided: false }, 'continue'],
    ['allowed replacement drops the retained executor', { stage: 'replacement', allowed: true, profileMismatch: true }, 'fresh'],
    ['allowed replacement drops even when the profile matches', { stage: 'replacement', allowed: true, profileMismatch: false }, 'fresh'],
    ['refused replacement with a profile mismatch pins the prior profile', { stage: 'replacement', allowed: false, profileMismatch: true }, 'reselect'],
    ['refused replacement with a matching profile keeps the thread', { stage: 'replacement', allowed: false, profileMismatch: false }, 'keep'],
    ['unbound executor is always fresh', { stage: 'unbound' }, 'fresh'],
  ];
  for (const [label, facts, expected] of cases) assert.equal(executorThreadDecision(facts), expected, label);
});

test('reviewerThreadDecision outcomes', () => {
  const cases: [string, ReviewerThreadFacts, LaunchThreadDecision][] = [
    ['not an author continues', { stage: 'author', authored: false, superseding: false, reselected: false }, 'continue'],
    ['authored and reselected takes the new route', { stage: 'author', authored: true, superseding: true, reselected: true }, 'reselect'],
    ['authored without a reselect is fresh (caller still clears a superseded profile)', { stage: 'author', authored: true, superseding: true, reselected: false }, 'fresh'],
    ['authored without a superseding route is fresh on the retained profile', { stage: 'author', authored: true, superseding: false, reselected: false }, 'fresh'],
    ['no profile issue continues', { stage: 'issue', issue: false, atLimit: false, selected: false }, 'continue'],
    ['issue at the replacement ceiling is attention', { stage: 'issue', issue: true, atLimit: true, selected: false }, 'attention'],
    ['issue with a selected replacement is reselect', { stage: 'issue', issue: true, atLimit: false, selected: true }, 'reselect'],
    ['issue with no selected replacement waits', { stage: 'issue', issue: true, atLimit: false, selected: false }, 'wait'],
    ['eligible round keeps the retained reviewer', { stage: 'round', eligible: true }, 'keep'],
    ['ineligible round is fresh', { stage: 'round', eligible: false }, 'fresh'],
    ['unbound profile drop is fresh', { stage: 'unbound_profile', drop: true }, 'fresh'],
    ['unbound profile keep continues', { stage: 'unbound_profile', drop: false }, 'continue'],
    ['critical without an explicit profile is fresh', { stage: 'critical_fresh', critical: true, explicitProfile: false }, 'fresh'],
    ['critical with an explicit profile continues', { stage: 'critical_fresh', critical: true, explicitProfile: true }, 'continue'],
    ['non-critical continues', { stage: 'critical_fresh', critical: false, explicitProfile: false }, 'continue'],
    ['select with a profile keeps it', { stage: 'select', hasProfile: true, selected: false }, 'keep'],
    ['select without a profile that found one is reselect', { stage: 'select', hasProfile: false, selected: true }, 'reselect'],
    ['select without a profile or a selection waits', { stage: 'select', hasProfile: false, selected: false }, 'wait'],
  ];
  for (const [label, facts, expected] of cases) assert.equal(reviewerThreadDecision(facts), expected, label);
});

test('reviewerRoundEligible outcomes', () => {
  const head = 'a'.repeat(40);
  const cases: [string, Parameters<typeof reviewerRoundEligible>[0], Parameters<typeof reviewerRoundEligible>[1], boolean][] = [
    ['finished released verdict under the round cap', { released: true, status: 'finished', completion: {}, retainedRounds: 1, head }, head, true],
    ['finished released verdict at the round cap', { released: true, status: 'finished', completion: {}, retainedRounds: 3, head }, head, false],
    ['finished without a completion', { released: true, status: 'finished', completion: null, retainedRounds: 0, head }, head, false],
    ['unreleased finished verdict', { released: false, status: 'finished', completion: {}, retainedRounds: 0, head }, head, false],
    ['superseded stopped reader on the same head', { released: true, status: 'superseded', completion: null, head }, head, true],
    ['superseded stopped reader on a different head', { released: true, status: 'superseded', completion: null, head }, 'b'.repeat(40), false],
    ['superseded with a completion is not a stopped reader', { released: true, status: 'superseded', completion: {}, head }, head, false],
    ['missing prior', null, head, false],
  ];
  for (const [label, prior, prHead, expected] of cases) assert.equal(reviewerRoundEligible(prior, prHead), expected, label);
});

test('revisionRunPlan outcomes', () => {
  const base: RevisionRunFacts = {
    firstReviewEntryWorker: false, firstWorkerSelected: false, revision: true,
    retainedProfileIssue: false, superseding: false, hasAgent: true, failoverArmed: false, replacementMatches: false,
  };
  const cases: [string, RevisionRunFacts, RevisionRunPlan][] = [
    ['first review-entry worker selected is fresh', { ...base, firstReviewEntryWorker: true, firstWorkerSelected: true }, 'fresh'],
    ['first review-entry worker missing is wait', { ...base, firstReviewEntryWorker: true, firstWorkerSelected: false }, 'wait'],
    ['non-revision continues', { ...base, revision: false }, 'continue'],
    ['retained worker profile issue is attention', { ...base, retainedProfileIssue: true }, 'attention'],
    ['superseding required route with a bound agent is reselect', { ...base, superseding: true }, 'reselect'],
    ['superseding route without a bound agent keeps', { ...base, superseding: true, hasAgent: false }, 'keep'],
    ['superseding route already armed keeps', { ...base, superseding: true, failoverArmed: true }, 'keep'],
    ['superseding route already matching the replacement keeps', { ...base, superseding: true, replacementMatches: true }, 'keep'],
    ['ordinary revision keeps the retained worker', base, 'keep'],
  ];
  for (const [label, facts, expected] of cases) assert.equal(revisionRunPlan(facts), expected, label);
});
