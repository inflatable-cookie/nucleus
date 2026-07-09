use crate::{
    selected_task_rework_preparation, SelectedTaskReviewDecisionOutcome,
    SelectedTaskReworkPreparationRefusalKind, SelectedTaskReworkPreparationStatus,
};

use super::helpers::{input, planning_ambiguous_input};

#[test]
fn refuses_accepted_review_route() {
    let preparation = selected_task_rework_preparation(input(
        "accepted",
        SelectedTaskReviewDecisionOutcome::Accepted,
    ));

    assert_refusal(
        preparation.status,
        preparation.refusal.map(|refusal| refusal.kind),
        SelectedTaskReworkPreparationRefusalKind::RouteAdmissionRefused,
    );
    assert!(preparation.rework_summary.is_none());
}

#[test]
fn requires_route_admission_id_match() {
    let mut input = input("rejected", SelectedTaskReviewDecisionOutcome::Rejected);
    input.route_admission_id = "selected-task-rework-delegation-route-admission:other".to_owned();

    let preparation = selected_task_rework_preparation(input);

    assert_refusal(
        preparation.status,
        preparation.refusal.map(|refusal| refusal.kind),
        SelectedTaskReworkPreparationRefusalKind::RouteAdmissionMismatch,
    );
}

#[test]
fn requires_review_decision_match() {
    let mut input = input("rejected", SelectedTaskReviewDecisionOutcome::Rejected);
    input.review_decision_ref = "selected-task-review-decision:other".to_owned();

    let preparation = selected_task_rework_preparation(input);

    assert_refusal(
        preparation.status,
        preparation.refusal.map(|refusal| refusal.kind),
        SelectedTaskReworkPreparationRefusalKind::ReviewDecisionMismatch,
    );
}

#[test]
fn requires_reviewed_work_items() {
    let mut input = input("rejected", SelectedTaskReviewDecisionOutcome::Rejected);
    input.reviewed_work_item_refs.clear();

    let preparation = selected_task_rework_preparation(input);

    assert_refusal(
        preparation.status,
        preparation.refusal.map(|refusal| refusal.kind),
        SelectedTaskReworkPreparationRefusalKind::MissingReviewedWorkItems,
    );
}

#[test]
fn requires_reviewed_evidence() {
    let mut input = input("rejected", SelectedTaskReviewDecisionOutcome::Rejected);
    input.reviewed_evidence_refs.clear();

    let preparation = selected_task_rework_preparation(input);

    assert_refusal(
        preparation.status,
        preparation.refusal.map(|refusal| refusal.kind),
        SelectedTaskReworkPreparationRefusalKind::MissingReviewedEvidence,
    );
}

#[test]
fn refuses_work_item_refs_not_on_route() {
    let mut input = input("rejected", SelectedTaskReviewDecisionOutcome::Rejected);
    input.reviewed_work_item_refs = vec!["work:other".to_owned()];

    let preparation = selected_task_rework_preparation(input);

    assert_refusal(
        preparation.status,
        preparation.refusal.map(|refusal| refusal.kind),
        SelectedTaskReworkPreparationRefusalKind::WorkItemMismatch,
    );
}

#[test]
fn refuses_evidence_refs_not_on_route() {
    let mut input = input("rejected", SelectedTaskReviewDecisionOutcome::Rejected);
    input.reviewed_evidence_refs = vec!["evidence:private".to_owned()];

    let preparation = selected_task_rework_preparation(input);

    assert_refusal(
        preparation.status,
        preparation.refusal.map(|refusal| refusal.kind),
        SelectedTaskReworkPreparationRefusalKind::EvidenceMismatch,
    );
}

#[test]
fn refuses_stale_route_admission() {
    let preparation = selected_task_rework_preparation(input(
        "awaiting_review",
        SelectedTaskReviewDecisionOutcome::Rejected,
    ));

    assert_refusal(
        preparation.status,
        preparation.refusal.map(|refusal| refusal.kind),
        SelectedTaskReworkPreparationRefusalKind::RouteAdmissionRefused,
    );
}

#[test]
fn refuses_planning_ambiguous_route_admission() {
    let preparation = selected_task_rework_preparation(planning_ambiguous_input());

    assert_refusal(
        preparation.status,
        preparation.refusal.map(|refusal| refusal.kind),
        SelectedTaskReworkPreparationRefusalKind::RouteAdmissionRefused,
    );
}

fn assert_refusal(
    status: SelectedTaskReworkPreparationStatus,
    kind: Option<SelectedTaskReworkPreparationRefusalKind>,
    expected_kind: SelectedTaskReworkPreparationRefusalKind,
) {
    assert_eq!(status, SelectedTaskReworkPreparationStatus::Refused);
    assert_eq!(kind, Some(expected_kind));
}
