use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::{
    selected_task_action_readiness, selected_task_completion_route_apply,
    selected_task_operator_action_gate, selected_task_review_next,
    selected_task_review_outcome_route, selected_task_route_admission, task_workflow_drilldown,
    SelectedTaskCompletionRouteApplyInput, SelectedTaskCompletionRouteApplyRefusalKind,
    SelectedTaskCompletionRouteApplyStatus, SelectedTaskOperatorActionGateInput,
    SelectedTaskReviewDecisionAction, SelectedTaskReviewDecisionOutcome,
    SelectedTaskReviewDecisionPersistenceStatus, SelectedTaskReviewDecisionRecord,
    SelectedTaskReviewOutcomeRouteInput, SelectedTaskRouteAdmissionInput, TaskCommand,
    TaskWorkflowDrilldown, TaskWorkflowDrilldownInput, TaskWorkflowNextStepInput,
    TaskWorkflowNextStepSource, TaskWorkflowReadinessInput, TaskWorkflowTaskInput,
    TaskWorkflowWorkProgressInput,
};

#[test]
fn admitted_completion_route_apply_exposes_complete_command_without_effects() {
    let apply = selected_task_completion_route_apply(input(Some("rev:task:1")));

    assert_eq!(
        apply.status,
        SelectedTaskCompletionRouteApplyStatus::Admitted
    );
    assert!(apply.refusal.is_none());
    assert_eq!(
        apply.review_decision_ref.as_deref(),
        Some("selected-task-review-decision:task:1:001")
    );
    assert!(matches!(
        apply.command,
        Some(TaskCommand::Complete(command))
            if command.task_id == TaskId("task:1".to_owned())
                && command.expected_revision == Some(RevisionId("rev:task:1".to_owned()))
    ));
    assert!(!apply.evidence_refs.is_empty());
    assert!(!apply.no_effects.task_lifecycle_mutation_performed);
    assert!(!apply.no_effects.provider_execution_performed);
    assert!(!apply.no_effects.scm_or_forge_mutation_performed);
    assert!(!apply.no_effects.agent_scheduling_performed);
}

#[test]
fn completion_route_apply_requires_expected_revision() {
    let apply = selected_task_completion_route_apply(input(None));

    assert_eq!(
        apply.status,
        SelectedTaskCompletionRouteApplyStatus::Refused
    );
    assert_eq!(
        apply.refusal.as_ref().map(|refusal| refusal.kind),
        Some(SelectedTaskCompletionRouteApplyRefusalKind::MissingExpectedRevision)
    );
    assert!(apply.command.is_none());
}

#[test]
fn completion_route_apply_refuses_route_admission_id_mismatch() {
    let mut input = input(Some("rev:task:1"));
    input.route_admission_id = "selected-task-route-admission:wrong".to_owned();

    let apply = selected_task_completion_route_apply(input);

    assert_eq!(
        apply.status,
        SelectedTaskCompletionRouteApplyStatus::Refused
    );
    assert_eq!(
        apply.refusal.as_ref().map(|refusal| refusal.kind),
        Some(SelectedTaskCompletionRouteApplyRefusalKind::RouteAdmissionMismatch)
    );
}

#[test]
fn completion_route_apply_refuses_review_decision_mismatch() {
    let mut input = input(Some("rev:task:1"));
    input.review_decision_ref = "selected-task-review-decision:other".to_owned();

    let apply = selected_task_completion_route_apply(input);

    assert_eq!(
        apply.status,
        SelectedTaskCompletionRouteApplyStatus::Refused
    );
    assert_eq!(
        apply.refusal.as_ref().map(|refusal| refusal.kind),
        Some(SelectedTaskCompletionRouteApplyRefusalKind::ReviewDecisionMismatch)
    );
}

#[test]
fn completion_route_apply_refuses_evidence_not_on_admitted_route() {
    let mut input = input(Some("rev:task:1"));
    input.evidence_refs = vec!["private:context".to_owned()];

    let apply = selected_task_completion_route_apply(input);

    assert_eq!(
        apply.status,
        SelectedTaskCompletionRouteApplyStatus::Refused
    );
    assert_eq!(
        apply.refusal.as_ref().map(|refusal| refusal.kind),
        Some(SelectedTaskCompletionRouteApplyRefusalKind::EvidenceMismatch)
    );
}

#[test]
fn completion_route_apply_refuses_stale_command_revision() {
    let mut input = input(Some("rev:task:1"));
    input.expected_revision = Some(RevisionId("rev:task:2".to_owned()));

    let apply = selected_task_completion_route_apply(input);

    assert_eq!(
        apply.status,
        SelectedTaskCompletionRouteApplyStatus::Refused
    );
    assert_eq!(
        apply.refusal.as_ref().map(|refusal| refusal.kind),
        Some(SelectedTaskCompletionRouteApplyRefusalKind::StaleTaskState)
    );
}

fn input(expected_revision: Option<&str>) -> SelectedTaskCompletionRouteApplyInput {
    let route_admission = route_admission(expected_revision);
    let route_admission_id = route_admission.admission_id.clone();
    let review_decision_ref = route_admission
        .completion
        .decision_ref
        .clone()
        .expect("decision ref");
    let evidence_refs = route_admission.completion.evidence_refs.clone();

    SelectedTaskCompletionRouteApplyInput {
        project_id: ProjectId("project:1".to_owned()),
        task_id: TaskId("task:1".to_owned()),
        expected_revision: expected_revision.map(|revision| RevisionId(revision.to_owned())),
        operator_ref: "operator:test".to_owned(),
        route_admission_id,
        review_decision_ref,
        evidence_refs,
        route_admission,
    }
}

fn route_admission(expected_revision: Option<&str>) -> crate::SelectedTaskRouteAdmission {
    selected_task_route_admission(SelectedTaskRouteAdmissionInput {
        route: route(),
        gate: gate(),
        expected_revision: expected_revision.map(|revision| RevisionId(revision.to_owned())),
        operator_ref: "operator:test".to_owned(),
    })
}

fn route() -> crate::SelectedTaskReviewOutcomeRoute {
    selected_task_review_outcome_route(SelectedTaskReviewOutcomeRouteInput {
        review_next: selected_task_review_next(&drilldown()),
        decision_records: vec![decision()],
        scm_handoff_refs: Vec::new(),
    })
}

fn gate() -> crate::SelectedTaskOperatorActionGate {
    let readiness = selected_task_action_readiness(&drilldown());
    selected_task_operator_action_gate(SelectedTaskOperatorActionGateInput {
        readiness,
        expected_revision: None,
        actor_ref: Some("operator:test".to_owned()),
    })
}

fn drilldown() -> TaskWorkflowDrilldown {
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
        work_progress: vec![TaskWorkflowWorkProgressInput {
            work_item_ref: "work-item:task:1:001".to_owned(),
            runtime_status: "completed".to_owned(),
            review_status: "accepted".to_owned(),
            source_ref: "runtime:receipt:1".to_owned(),
            source_count: 1,
            session_ref: Some("session:codex:1".to_owned()),
            turn_refs: vec!["turn:1".to_owned()],
            receipt_refs: vec!["receipt:task:1".to_owned()],
            checkpoint_refs: vec!["checkpoint:task:1".to_owned()],
            diff_summary_refs: vec!["diff:task:1".to_owned()],
            timeline_entry_refs: vec!["timeline:task:1".to_owned()],
            validation_refs: vec!["validation:task:1".to_owned()],
            artifact_refs: Vec::new(),
            issue_refs: Vec::new(),
        }],
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

fn decision() -> SelectedTaskReviewDecisionRecord {
    SelectedTaskReviewDecisionRecord {
        decision_id: "selected-task-review-decision:task:1:001".to_owned(),
        admission_id: "selected-task-review-decision-admission:task:1:001".to_owned(),
        project_id: "project:1".to_owned(),
        task_id: "task:1".to_owned(),
        work_item_refs: vec!["work-item:task:1:001".to_owned()],
        action: SelectedTaskReviewDecisionAction::AcceptEvidence,
        outcome: SelectedTaskReviewDecisionOutcome::Accepted,
        operator_ref: "operator:test".to_owned(),
        expected_revision: "rev:task:1".to_owned(),
        reviewed_evidence_refs: vec![
            "receipt:task:1".to_owned(),
            "checkpoint:task:1".to_owned(),
            "diff:task:1".to_owned(),
            "validation:task:1".to_owned(),
        ],
        receipt_refs: vec!["receipt:task:1".to_owned()],
        timeline_refs: vec!["timeline:task:1".to_owned()],
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
