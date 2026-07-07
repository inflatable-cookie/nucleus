use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::{
    selected_task_action_readiness, selected_task_completion_route_admission,
    selected_task_operator_action_gate, selected_task_review_next,
    selected_task_review_outcome_route, selected_task_rework_delegation_route_admission,
    task_workflow_drilldown, SelectedTaskCompletionRouteAdmissionInput,
    SelectedTaskReviewDecisionAction, SelectedTaskReviewDecisionOutcome,
    SelectedTaskReviewDecisionPersistenceStatus, SelectedTaskReviewDecisionRecord,
    SelectedTaskReviewOutcomeRouteInput, SelectedTaskReworkDelegationRouteAdmissionInput,
    SelectedTaskRouteAdmissionPreviewFamily, SelectedTaskRouteAdmissionRefusalKind,
    SelectedTaskRouteAdmissionStatus, TaskCommand, TaskWorkflowDrilldown,
    TaskWorkflowDrilldownInput, TaskWorkflowNextStepInput, TaskWorkflowNextStepSource,
    TaskWorkflowReadinessInput, TaskWorkflowTaskInput, TaskWorkflowWorkProgressInput,
};

#[test]
fn accepted_review_admits_completion_preview_without_effects() {
    let admission = selected_task_completion_route_admission(input(
        route("accepted", SelectedTaskReviewDecisionOutcome::Accepted),
        Some("rev:task:1"),
    ));

    assert_eq!(admission.status, SelectedTaskRouteAdmissionStatus::Admitted);
    assert_eq!(
        admission.decision_ref.as_deref(),
        Some("selected-task-review-decision:task:1:001")
    );
    assert!(admission.refusal.is_none());
    assert!(!admission.evidence_refs.is_empty());
    assert!(matches!(
        admission
            .command_admission
            .as_ref()
            .and_then(|admission| admission.command.as_ref()),
        Some(TaskCommand::Complete(command))
            if command.task_id == TaskId("task:1".to_owned())
                && command.expected_revision == Some(RevisionId("rev:task:1".to_owned()))
    ));
    assert!(!admission.no_effects.task_lifecycle_mutation_performed);
    assert!(!admission.no_effects.review_mutation_performed);
    assert!(!admission.no_effects.provider_execution_performed);
    assert!(!admission.no_effects.scm_or_forge_mutation_performed);
    assert!(!admission.no_effects.agent_scheduling_performed);
}

#[test]
fn missing_decision_refuses_before_command_admission() {
    let route = selected_task_review_outcome_route(SelectedTaskReviewOutcomeRouteInput {
        review_next: selected_task_review_next(&drilldown("awaiting_review")),
        decision_records: Vec::new(),
        scm_handoff_refs: Vec::new(),
    });
    let admission = selected_task_completion_route_admission(input(route, Some("rev:task:1")));

    assert_eq!(admission.status, SelectedTaskRouteAdmissionStatus::Refused);
    assert_eq!(
        admission.refusal.as_ref().map(|refusal| refusal.kind),
        Some(SelectedTaskRouteAdmissionRefusalKind::MissingDecisionRecord)
    );
    assert!(admission.command_admission.is_none());
}

#[test]
fn missing_evidence_refuses_before_command_admission() {
    let mut review_next = selected_task_review_next(&drilldown("accepted"));
    review_next.review.evidence_refs.clear();
    review_next.evidence.receipt_refs.clear();
    review_next.evidence.checkpoint_refs.clear();
    review_next.evidence.diff_summary_refs.clear();
    review_next.evidence.validation_refs.clear();
    review_next.evidence.timeline_refs.clear();
    review_next.evidence.review_refs.clear();
    let mut decision = decision(SelectedTaskReviewDecisionOutcome::Accepted);
    decision.reviewed_evidence_refs.clear();
    decision.receipt_refs.clear();
    decision.timeline_refs.clear();
    let route = selected_task_review_outcome_route(SelectedTaskReviewOutcomeRouteInput {
        review_next,
        decision_records: vec![decision],
        scm_handoff_refs: Vec::new(),
    });
    let admission = selected_task_completion_route_admission(input(route, Some("rev:task:1")));

    assert_eq!(admission.status, SelectedTaskRouteAdmissionStatus::Refused);
    assert_eq!(
        admission.refusal.as_ref().map(|refusal| refusal.kind),
        Some(SelectedTaskRouteAdmissionRefusalKind::MissingReviewEvidence)
    );
    assert!(admission.command_admission.is_none());
}

#[test]
fn stale_route_refuses_before_command_admission() {
    let route = selected_task_review_outcome_route(SelectedTaskReviewOutcomeRouteInput {
        review_next: selected_task_review_next(&drilldown("awaiting_review")),
        decision_records: vec![decision(SelectedTaskReviewDecisionOutcome::Accepted)],
        scm_handoff_refs: Vec::new(),
    });
    let admission = selected_task_completion_route_admission(input(route, Some("rev:task:1")));

    assert_eq!(admission.status, SelectedTaskRouteAdmissionStatus::Refused);
    assert_eq!(
        admission.refusal.as_ref().map(|refusal| refusal.kind),
        Some(SelectedTaskRouteAdmissionRefusalKind::StaleTaskState)
    );
    assert!(admission.command_admission.is_none());
}

#[test]
fn unsupported_review_outcome_refuses_completion() {
    let admission = selected_task_completion_route_admission(input(
        route(
            "needs_changes",
            SelectedTaskReviewDecisionOutcome::NeedsChanges,
        ),
        Some("rev:task:1"),
    ));

    assert_eq!(admission.status, SelectedTaskRouteAdmissionStatus::Refused);
    assert_eq!(
        admission.refusal.as_ref().map(|refusal| refusal.kind),
        Some(SelectedTaskRouteAdmissionRefusalKind::UnsupportedRoute)
    );
    assert!(admission.command_admission.is_none());
}

#[test]
fn command_admission_refusal_is_preserved() {
    let admission = selected_task_completion_route_admission(input(
        route("accepted", SelectedTaskReviewDecisionOutcome::Accepted),
        None,
    ));

    assert_eq!(admission.status, SelectedTaskRouteAdmissionStatus::Refused);
    assert_eq!(
        admission.refusal.as_ref().map(|refusal| refusal.kind),
        Some(SelectedTaskRouteAdmissionRefusalKind::CommandAdmissionRefused)
    );
    assert!(admission.command_admission.is_some());
}

#[test]
fn rejected_and_needs_changes_reviews_admit_rework_and_delegation_previews() {
    for (review_status, outcome) in [
        ("rejected", SelectedTaskReviewDecisionOutcome::Rejected),
        (
            "needs_changes",
            SelectedTaskReviewDecisionOutcome::NeedsChanges,
        ),
    ] {
        let admission = selected_task_rework_delegation_route_admission(
            SelectedTaskReworkDelegationRouteAdmissionInput {
                route: route(review_status, outcome),
            },
        );

        assert_eq!(admission.status, SelectedTaskRouteAdmissionStatus::Admitted);
        assert_eq!(
            admission
                .rework_preview
                .as_ref()
                .map(|preview| preview.family),
            Some(SelectedTaskRouteAdmissionPreviewFamily::PrepareRework)
        );
        assert_eq!(
            admission
                .delegation_preview
                .as_ref()
                .map(|preview| preview.family),
            Some(SelectedTaskRouteAdmissionPreviewFamily::DelegateRework)
        );
        assert!(!admission.work_item_refs.is_empty());
        assert!(!admission.evidence_refs.is_empty());
        assert!(!admission.no_effects.task_lifecycle_mutation_performed);
        assert!(!admission.no_effects.provider_execution_performed);
        assert!(!admission.no_effects.agent_scheduling_performed);
    }
}

#[test]
fn accepted_review_refuses_rework_preview() {
    let admission = selected_task_rework_delegation_route_admission(
        SelectedTaskReworkDelegationRouteAdmissionInput {
            route: route("accepted", SelectedTaskReviewDecisionOutcome::Accepted),
        },
    );

    assert_eq!(admission.status, SelectedTaskRouteAdmissionStatus::Refused);
    assert_eq!(
        admission.refusal.as_ref().map(|refusal| refusal.kind),
        Some(SelectedTaskRouteAdmissionRefusalKind::UnsupportedRoute)
    );
    assert!(admission.rework_preview.is_none());
    assert!(admission.delegation_preview.is_none());
}

fn input(
    route: crate::SelectedTaskReviewOutcomeRoute,
    expected_revision: Option<&str>,
) -> SelectedTaskCompletionRouteAdmissionInput {
    SelectedTaskCompletionRouteAdmissionInput {
        route,
        gate: gate(),
        expected_revision: expected_revision.map(|revision| RevisionId(revision.to_owned())),
        operator_ref: "operator:test".to_owned(),
    }
}

fn route(
    review_status: &str,
    outcome: SelectedTaskReviewDecisionOutcome,
) -> crate::SelectedTaskReviewOutcomeRoute {
    selected_task_review_outcome_route(SelectedTaskReviewOutcomeRouteInput {
        review_next: selected_task_review_next(&drilldown(review_status)),
        decision_records: vec![decision(outcome)],
        scm_handoff_refs: Vec::new(),
    })
}

fn gate() -> crate::SelectedTaskOperatorActionGate {
    let readiness = selected_task_action_readiness(&drilldown("accepted"));
    selected_task_operator_action_gate(crate::SelectedTaskOperatorActionGateInput {
        readiness,
        expected_revision: None,
        actor_ref: Some("operator:test".to_owned()),
    })
}

fn drilldown(review_status: &str) -> TaskWorkflowDrilldown {
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
        scm_handoff_refs: Vec::new(),
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

fn decision(outcome: SelectedTaskReviewDecisionOutcome) -> SelectedTaskReviewDecisionRecord {
    SelectedTaskReviewDecisionRecord {
        decision_id: "selected-task-review-decision:task:1:001".to_owned(),
        admission_id: "selected-task-review-decision-admission:task:1:001".to_owned(),
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
        idempotency_key: "test:001".to_owned(),
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
