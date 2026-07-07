use std::collections::HashSet;

use crate::{
    SelectedTaskReviewDecisionOutcome, SelectedTaskReviewDecisionRecord,
    SelectedTaskReviewOutcomeCommandHint, SelectedTaskReviewOutcomeRoute,
    SelectedTaskReviewOutcomeRouteBlocker, SelectedTaskReviewOutcomeRouteCandidate,
    SelectedTaskReviewOutcomeRouteInput, SelectedTaskReviewOutcomeRouteNoEffects,
    SelectedTaskReviewOutcomeRouteSourceCounts, SelectedTaskReviewOutcomeRouteStatus,
    SelectedTaskReviewState,
};

pub fn selected_task_review_outcome_route(
    input: SelectedTaskReviewOutcomeRouteInput,
) -> SelectedTaskReviewOutcomeRoute {
    let decision = latest_decision_for_task(&input);
    let mut blockers = Vec::new();
    let mut candidates = Vec::new();
    let mut downstream_command_hints = Vec::new();
    let work_item_refs = work_item_refs(&input, decision);
    let evidence_refs = evidence_refs(&input, decision);
    let decision_ref = decision.map(|record| record.decision_id.clone());

    let (status, primary_route, decision_outcome) = match decision {
        None => {
            blockers.push(SelectedTaskReviewOutcomeRouteBlocker::MissingDecisionRecord);
            (
                SelectedTaskReviewOutcomeRouteStatus::Missing,
                SelectedTaskReviewOutcomeRouteCandidate::NoReviewDecision,
                None,
            )
        }
        Some(decision) => {
            let outcome = decision.outcome;
            if evidence_refs.is_empty() {
                blockers.push(SelectedTaskReviewOutcomeRouteBlocker::MissingReviewEvidence);
                (
                    SelectedTaskReviewOutcomeRouteStatus::Blocked,
                    SelectedTaskReviewOutcomeRouteCandidate::BlockedOnMissingEvidence,
                    Some(outcome),
                )
            } else if !review_state_matches_outcome(input.review_next.review.state, outcome) {
                blockers.push(SelectedTaskReviewOutcomeRouteBlocker::StaleTaskState);
                (
                    SelectedTaskReviewOutcomeRouteStatus::Stale,
                    SelectedTaskReviewOutcomeRouteCandidate::BlockedOnStaleTaskState,
                    Some(outcome),
                )
            } else {
                route_for_outcome(
                    outcome,
                    &input,
                    &mut blockers,
                    &mut candidates,
                    &mut downstream_command_hints,
                )
            }
        }
    };

    if planning_ambiguous(&input) {
        blockers.push(SelectedTaskReviewOutcomeRouteBlocker::PlanningAmbiguity);
        if matches!(status, SelectedTaskReviewOutcomeRouteStatus::Ready) {
            candidates.push(SelectedTaskReviewOutcomeRouteCandidate::BlockedOnPlanningAmbiguity);
        }
    }

    if !matches!(
        primary_route,
        SelectedTaskReviewOutcomeRouteCandidate::NoReviewDecision
            | SelectedTaskReviewOutcomeRouteCandidate::BlockedOnMissingEvidence
            | SelectedTaskReviewOutcomeRouteCandidate::BlockedOnStaleTaskState
            | SelectedTaskReviewOutcomeRouteCandidate::BlockedOnPlanningAmbiguity
    ) {
        blockers.push(SelectedTaskReviewOutcomeRouteBlocker::DownstreamCommandNotDefined);
    }

    let candidates = with_primary_candidate(primary_route, candidates);
    let downstream_command_hints = sorted_hints(downstream_command_hints);
    let blockers = sorted_blockers(blockers);
    let source_counts = SelectedTaskReviewOutcomeRouteSourceCounts {
        decision_records: input.decision_records.len(),
        work_item_refs: work_item_refs.len(),
        evidence_refs: evidence_refs.len(),
        review_gap_count: input.review_next.gaps.len(),
        scm_handoff_refs: input.scm_handoff_refs.len(),
        downstream_command_hints: downstream_command_hints.len(),
        blockers: blockers.len(),
    };

    SelectedTaskReviewOutcomeRoute {
        route_id: format!(
            "selected-task-review-outcome-route:{}",
            input.review_next.task_id.0
        ),
        project_id: input.review_next.project_id.clone(),
        task_id: input.review_next.task_id.clone(),
        status: final_status(status, &blockers),
        primary_route,
        candidates,
        decision_ref,
        decision_outcome,
        work_item_refs,
        evidence_refs,
        downstream_command_hints,
        blockers,
        source_counts,
        no_effects: SelectedTaskReviewOutcomeRouteNoEffects::read_only(),
    }
}

fn route_for_outcome(
    outcome: SelectedTaskReviewDecisionOutcome,
    input: &SelectedTaskReviewOutcomeRouteInput,
    blockers: &mut Vec<SelectedTaskReviewOutcomeRouteBlocker>,
    candidates: &mut Vec<SelectedTaskReviewOutcomeRouteCandidate>,
    downstream_command_hints: &mut Vec<SelectedTaskReviewOutcomeCommandHint>,
) -> (
    SelectedTaskReviewOutcomeRouteStatus,
    SelectedTaskReviewOutcomeRouteCandidate,
    Option<SelectedTaskReviewDecisionOutcome>,
) {
    match outcome {
        SelectedTaskReviewDecisionOutcome::Accepted => {
            downstream_command_hints
                .push(SelectedTaskReviewOutcomeCommandHint::CompleteSelectedTask);
            if !input.scm_handoff_refs.is_empty() {
                candidates.push(SelectedTaskReviewOutcomeRouteCandidate::ReadyForScmHandoffReview);
                downstream_command_hints
                    .push(SelectedTaskReviewOutcomeCommandHint::ReviewScmHandoff);
            }
            (
                SelectedTaskReviewOutcomeRouteStatus::Ready,
                SelectedTaskReviewOutcomeRouteCandidate::ReadyForCompletionAdmission,
                Some(outcome),
            )
        }
        SelectedTaskReviewDecisionOutcome::Rejected
        | SelectedTaskReviewDecisionOutcome::NeedsChanges => {
            candidates.push(SelectedTaskReviewOutcomeRouteCandidate::ReadyForDelegationAdmission);
            downstream_command_hints.push(SelectedTaskReviewOutcomeCommandHint::PrepareRework);
            downstream_command_hints.push(SelectedTaskReviewOutcomeCommandHint::DelegateRework);
            (
                SelectedTaskReviewOutcomeRouteStatus::Ready,
                SelectedTaskReviewOutcomeRouteCandidate::ReadyForReworkAdmission,
                Some(outcome),
            )
        }
        SelectedTaskReviewDecisionOutcome::Abandoned => {
            blockers.push(SelectedTaskReviewOutcomeRouteBlocker::UnsupportedReviewState);
            downstream_command_hints
                .push(SelectedTaskReviewOutcomeCommandHint::ResolveOperatorChoice);
            (
                SelectedTaskReviewOutcomeRouteStatus::Blocked,
                SelectedTaskReviewOutcomeRouteCandidate::BlockedOnOperatorChoice,
                Some(outcome),
            )
        }
    }
}

fn latest_decision_for_task(
    input: &SelectedTaskReviewOutcomeRouteInput,
) -> Option<&SelectedTaskReviewDecisionRecord> {
    let task_id = input.review_next.task_id.0.as_str();
    input
        .decision_records
        .iter()
        .filter(|record| record.task_id == task_id)
        .max_by(|left, right| left.decision_id.cmp(&right.decision_id))
}

fn review_state_matches_outcome(
    state: SelectedTaskReviewState,
    outcome: SelectedTaskReviewDecisionOutcome,
) -> bool {
    matches!(
        (state, outcome),
        (
            SelectedTaskReviewState::Accepted,
            SelectedTaskReviewDecisionOutcome::Accepted
        ) | (
            SelectedTaskReviewState::Rejected,
            SelectedTaskReviewDecisionOutcome::Rejected
        ) | (
            SelectedTaskReviewState::NeedsChanges,
            SelectedTaskReviewDecisionOutcome::NeedsChanges
        ) | (
            SelectedTaskReviewState::Abandoned,
            SelectedTaskReviewDecisionOutcome::Abandoned
        )
    )
}

fn planning_ambiguous(input: &SelectedTaskReviewOutcomeRouteInput) -> bool {
    input
        .review_next
        .gaps
        .iter()
        .any(|gap| matches!(gap.area, crate::SelectedTaskReviewNextGapArea::NextPathway))
}

fn work_item_refs(
    input: &SelectedTaskReviewOutcomeRouteInput,
    decision: Option<&SelectedTaskReviewDecisionRecord>,
) -> Vec<String> {
    let mut refs = input.review_next.review.work_item_refs.clone();
    if let Some(decision) = decision {
        refs.extend(decision.work_item_refs.clone());
    }
    clean_refs(refs)
}

fn evidence_refs(
    input: &SelectedTaskReviewOutcomeRouteInput,
    decision: Option<&SelectedTaskReviewDecisionRecord>,
) -> Vec<String> {
    let mut refs = input.review_next.review.evidence_refs.clone();
    refs.extend(input.review_next.evidence.receipt_refs.clone());
    refs.extend(input.review_next.evidence.checkpoint_refs.clone());
    refs.extend(input.review_next.evidence.diff_summary_refs.clone());
    refs.extend(input.review_next.evidence.validation_refs.clone());
    refs.extend(input.review_next.evidence.timeline_refs.clone());
    refs.extend(input.review_next.evidence.review_refs.clone());
    if let Some(decision) = decision {
        refs.extend(decision.reviewed_evidence_refs.clone());
        refs.extend(decision.receipt_refs.clone());
        refs.extend(decision.timeline_refs.clone());
    }
    clean_refs(refs)
}

fn clean_refs(refs: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut cleaned = refs
        .into_iter()
        .map(|reference| reference.trim().to_owned())
        .filter(|reference| !reference.is_empty())
        .filter(|reference| seen.insert(reference.clone()))
        .collect::<Vec<_>>();
    cleaned.sort();
    cleaned
}

fn with_primary_candidate(
    primary: SelectedTaskReviewOutcomeRouteCandidate,
    candidates: Vec<SelectedTaskReviewOutcomeRouteCandidate>,
) -> Vec<SelectedTaskReviewOutcomeRouteCandidate> {
    let mut candidates = candidates;
    candidates.push(primary);
    candidates.sort_by_key(|candidate| format!("{candidate:?}"));
    candidates.dedup();
    candidates
}

fn sorted_hints(
    hints: Vec<SelectedTaskReviewOutcomeCommandHint>,
) -> Vec<SelectedTaskReviewOutcomeCommandHint> {
    let mut hints = hints;
    hints.sort_by_key(|hint| format!("{hint:?}"));
    hints.dedup();
    hints
}

fn sorted_blockers(
    blockers: Vec<SelectedTaskReviewOutcomeRouteBlocker>,
) -> Vec<SelectedTaskReviewOutcomeRouteBlocker> {
    let mut blockers = blockers;
    blockers.sort_by_key(|blocker| format!("{blocker:?}"));
    blockers.dedup();
    blockers
}

fn final_status(
    status: SelectedTaskReviewOutcomeRouteStatus,
    blockers: &[SelectedTaskReviewOutcomeRouteBlocker],
) -> SelectedTaskReviewOutcomeRouteStatus {
    if status == SelectedTaskReviewOutcomeRouteStatus::Ready
        && blockers.iter().any(|blocker| {
            *blocker != SelectedTaskReviewOutcomeRouteBlocker::DownstreamCommandNotDefined
        })
    {
        SelectedTaskReviewOutcomeRouteStatus::Blocked
    } else {
        status
    }
}
