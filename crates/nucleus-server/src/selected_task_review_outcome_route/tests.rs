use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::{
    selected_task_review_next, selected_task_review_outcome_route, task_workflow_drilldown,
    SelectedTaskReviewDecisionAction, SelectedTaskReviewDecisionOutcome,
    SelectedTaskReviewDecisionPersistenceStatus, SelectedTaskReviewDecisionRecord,
    SelectedTaskReviewOutcomeCommandHint, SelectedTaskReviewOutcomeRouteBlocker,
    SelectedTaskReviewOutcomeRouteCandidate, SelectedTaskReviewOutcomeRouteInput,
    SelectedTaskReviewOutcomeRouteStatus, TaskWorkflowDrilldown, TaskWorkflowDrilldownInput,
    TaskWorkflowNextStepInput, TaskWorkflowNextStepSource, TaskWorkflowReadinessInput,
    TaskWorkflowTaskInput, TaskWorkflowWorkProgressInput,
};

#[test]
fn accepted_review_routes_to_completion_without_effects() {
    let route = selected_task_review_outcome_route(SelectedTaskReviewOutcomeRouteInput {
        review_next: review_next("accepted", Vec::new()),
        decision_records: vec![decision("001", SelectedTaskReviewDecisionOutcome::Accepted)],
        scm_handoff_refs: Vec::new(),
    });

    assert_eq!(route.status, SelectedTaskReviewOutcomeRouteStatus::Ready);
    assert_eq!(
        route.primary_route,
        SelectedTaskReviewOutcomeRouteCandidate::ReadyForCompletionAdmission
    );
    assert_eq!(
        route.downstream_command_hints,
        vec![SelectedTaskReviewOutcomeCommandHint::CompleteSelectedTask]
    );
    assert!(route
        .blockers
        .contains(&SelectedTaskReviewOutcomeRouteBlocker::DownstreamCommandNotDefined));
    assert!(!route.no_effects.task_lifecycle_mutation_performed);
    assert!(!route.no_effects.review_mutation_performed);
    assert!(!route.no_effects.provider_execution_performed);
    assert!(!route.no_effects.scm_or_forge_mutation_performed);
}

#[test]
fn accepted_review_can_surface_scm_handoff_candidate() {
    let route = selected_task_review_outcome_route(SelectedTaskReviewOutcomeRouteInput {
        review_next: review_next("accepted", vec!["scm:handoff:1"]),
        decision_records: vec![decision("001", SelectedTaskReviewDecisionOutcome::Accepted)],
        scm_handoff_refs: vec!["scm:handoff:1".to_owned()],
    });

    assert!(route
        .candidates
        .contains(&SelectedTaskReviewOutcomeRouteCandidate::ReadyForScmHandoffReview));
    assert!(route
        .downstream_command_hints
        .contains(&SelectedTaskReviewOutcomeCommandHint::ReviewScmHandoff));
    assert_eq!(route.source_counts.scm_handoff_refs, 1);
}

#[test]
fn rejected_and_needs_changes_route_to_rework() {
    for (review_state, outcome) in [
        ("rejected", SelectedTaskReviewDecisionOutcome::Rejected),
        (
            "needs_changes",
            SelectedTaskReviewDecisionOutcome::NeedsChanges,
        ),
    ] {
        let route = selected_task_review_outcome_route(SelectedTaskReviewOutcomeRouteInput {
            review_next: review_next(review_state, Vec::new()),
            decision_records: vec![decision("001", outcome)],
            scm_handoff_refs: Vec::new(),
        });

        assert_eq!(route.status, SelectedTaskReviewOutcomeRouteStatus::Ready);
        assert_eq!(
            route.primary_route,
            SelectedTaskReviewOutcomeRouteCandidate::ReadyForReworkAdmission
        );
        assert!(route
            .candidates
            .contains(&SelectedTaskReviewOutcomeRouteCandidate::ReadyForDelegationAdmission));
        assert!(route
            .downstream_command_hints
            .contains(&SelectedTaskReviewOutcomeCommandHint::PrepareRework));
    }
}

#[test]
fn abandoned_review_blocks_on_operator_choice() {
    let route = selected_task_review_outcome_route(SelectedTaskReviewOutcomeRouteInput {
        review_next: review_next("abandoned", Vec::new()),
        decision_records: vec![decision(
            "001",
            SelectedTaskReviewDecisionOutcome::Abandoned,
        )],
        scm_handoff_refs: Vec::new(),
    });

    assert_eq!(route.status, SelectedTaskReviewOutcomeRouteStatus::Blocked);
    assert_eq!(
        route.primary_route,
        SelectedTaskReviewOutcomeRouteCandidate::BlockedOnOperatorChoice
    );
    assert!(route
        .blockers
        .contains(&SelectedTaskReviewOutcomeRouteBlocker::UnsupportedReviewState));
}

#[test]
fn missing_decision_reports_no_review_decision() {
    let route = selected_task_review_outcome_route(SelectedTaskReviewOutcomeRouteInput {
        review_next: review_next("awaiting_review", Vec::new()),
        decision_records: Vec::new(),
        scm_handoff_refs: Vec::new(),
    });

    assert_eq!(route.status, SelectedTaskReviewOutcomeRouteStatus::Missing);
    assert_eq!(
        route.primary_route,
        SelectedTaskReviewOutcomeRouteCandidate::NoReviewDecision
    );
    assert!(route
        .blockers
        .contains(&SelectedTaskReviewOutcomeRouteBlocker::MissingDecisionRecord));
}

#[test]
fn mismatched_review_state_reports_stale_task_state() {
    let route = selected_task_review_outcome_route(SelectedTaskReviewOutcomeRouteInput {
        review_next: review_next("awaiting_review", Vec::new()),
        decision_records: vec![decision("001", SelectedTaskReviewDecisionOutcome::Accepted)],
        scm_handoff_refs: Vec::new(),
    });

    assert_eq!(route.status, SelectedTaskReviewOutcomeRouteStatus::Stale);
    assert_eq!(
        route.primary_route,
        SelectedTaskReviewOutcomeRouteCandidate::BlockedOnStaleTaskState
    );
    assert!(route
        .blockers
        .contains(&SelectedTaskReviewOutcomeRouteBlocker::StaleTaskState));
}

#[test]
fn missing_evidence_blocks_route() {
    let mut review_next = review_next("accepted", Vec::new());
    review_next.review.evidence_refs.clear();
    review_next.evidence.receipt_refs.clear();
    review_next.evidence.checkpoint_refs.clear();
    review_next.evidence.diff_summary_refs.clear();
    review_next.evidence.validation_refs.clear();
    review_next.evidence.timeline_refs.clear();
    review_next.evidence.review_refs.clear();

    let mut record = decision("001", SelectedTaskReviewDecisionOutcome::Accepted);
    record.reviewed_evidence_refs.clear();
    record.receipt_refs.clear();
    record.timeline_refs.clear();

    let route = selected_task_review_outcome_route(SelectedTaskReviewOutcomeRouteInput {
        review_next,
        decision_records: vec![record],
        scm_handoff_refs: Vec::new(),
    });

    assert_eq!(route.status, SelectedTaskReviewOutcomeRouteStatus::Blocked);
    assert_eq!(
        route.primary_route,
        SelectedTaskReviewOutcomeRouteCandidate::BlockedOnMissingEvidence
    );
    assert!(route
        .blockers
        .contains(&SelectedTaskReviewOutcomeRouteBlocker::MissingReviewEvidence));
}

fn review_next(review_status: &str, scm_handoff_refs: Vec<&str>) -> crate::SelectedTaskReviewNext {
    selected_task_review_next(&drilldown(review_status, scm_handoff_refs))
}

fn drilldown(review_status: &str, scm_handoff_refs: Vec<&str>) -> TaskWorkflowDrilldown {
    task_workflow_drilldown(TaskWorkflowDrilldownInput {
        project_id: ProjectId("project:1".to_owned()),
        task_id: TaskId("task:1".to_owned()),
        task: Some(TaskWorkflowTaskInput {
            title: "Selected task".to_owned(),
            activity: "active".to_owned(),
            assignment: "agent".to_owned(),
            action_type: "execute".to_owned(),
        }),
        readiness: Some(TaskWorkflowReadinessInput {
            lane: "agent_delegation_ready".to_owned(),
            rationale_refs: vec!["readiness:1".to_owned()],
        }),
        timeline_entry_refs: vec!["timeline:task:1".to_owned()],
        work_progress: vec![completed_item(review_status)],
        runtime_receipt_refs: vec!["receipt:task:1".to_owned()],
        command_evidence_refs: Vec::new(),
        task_completion_refs: vec!["completion:task:1".to_owned()],
        review_refs: vec!["review:decision:1".to_owned()],
        scm_handoff_refs: scm_handoff_refs
            .into_iter()
            .map(ToOwned::to_owned)
            .collect(),
        next_step: Some(TaskWorkflowNextStepInput {
            source: TaskWorkflowNextStepSource::Review,
            next_ref: Some("review:task:1".to_owned()),
            summary: "Review selected task evidence".to_owned(),
            rationale_refs: vec!["completion:task:1".to_owned()],
        }),
    })
}

fn completed_item(review_status: &str) -> TaskWorkflowWorkProgressInput {
    TaskWorkflowWorkProgressInput {
        work_item_ref: "work:1".to_owned(),
        runtime_status: "completed".to_owned(),
        review_status: review_status.to_owned(),
        source_ref: "source:work:1".to_owned(),
        source_count: 1,
        session_ref: Some("session:work:1".to_owned()),
        turn_refs: vec!["turn:work:1".to_owned()],
        receipt_refs: vec!["receipt:work:1".to_owned()],
        checkpoint_refs: vec!["checkpoint:work:1".to_owned()],
        diff_summary_refs: vec!["diff:work:1".to_owned()],
        timeline_entry_refs: vec!["timeline:work:1".to_owned()],
        validation_refs: vec!["validation:work:1".to_owned()],
        artifact_refs: Vec::new(),
        issue_refs: Vec::new(),
    }
}

fn decision(
    suffix: &str,
    outcome: SelectedTaskReviewDecisionOutcome,
) -> SelectedTaskReviewDecisionRecord {
    SelectedTaskReviewDecisionRecord {
        decision_id: format!("selected-task-review-decision:task:1:{suffix}"),
        admission_id: format!("selected-task-review-decision-admission:task:1:{suffix}"),
        project_id: "project:1".to_owned(),
        task_id: "task:1".to_owned(),
        work_item_refs: vec!["work:1".to_owned()],
        action: action_for_outcome(outcome),
        outcome,
        operator_ref: "operator:test".to_owned(),
        expected_revision: "rev:task:1".to_owned(),
        reviewed_evidence_refs: vec!["checkpoint:work:1".to_owned()],
        receipt_refs: vec!["receipt:work:1".to_owned()],
        timeline_refs: vec!["timeline:review:1".to_owned()],
        reason_summary: Some("reviewed".to_owned()),
        idempotency_key: format!("test:{suffix}"),
        status: SelectedTaskReviewDecisionPersistenceStatus::Persisted,
        blockers: Vec::new(),
        duplicate_decision_detected: false,
        review_mutation_performed: false,
        task_lifecycle_mutation_performed: false,
        provider_execution_performed: false,
        provider_write_performed: false,
        scm_or_forge_mutation_performed: false,
        accepted_memory_apply_performed: false,
        planning_apply_performed: false,
        projection_write_performed: false,
        agent_scheduling_performed: false,
        ui_effect_performed: false,
        raw_provider_material_retained: false,
        raw_command_output_retained: false,
    }
}

fn action_for_outcome(
    outcome: SelectedTaskReviewDecisionOutcome,
) -> SelectedTaskReviewDecisionAction {
    match outcome {
        SelectedTaskReviewDecisionOutcome::Accepted => {
            SelectedTaskReviewDecisionAction::AcceptEvidence
        }
        SelectedTaskReviewDecisionOutcome::Rejected => {
            SelectedTaskReviewDecisionAction::RejectEvidence
        }
        SelectedTaskReviewDecisionOutcome::NeedsChanges => {
            SelectedTaskReviewDecisionAction::RequestChanges
        }
        SelectedTaskReviewDecisionOutcome::Abandoned => {
            SelectedTaskReviewDecisionAction::AbandonReview
        }
    }
}
