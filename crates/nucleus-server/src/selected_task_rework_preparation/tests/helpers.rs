use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::{
    selected_task_action_readiness, selected_task_operator_action_gate, selected_task_review_next,
    selected_task_review_outcome_route, selected_task_route_admission, task_workflow_drilldown,
    SelectedTaskOperatorActionGateInput, SelectedTaskReviewDecisionAction,
    SelectedTaskReviewDecisionOutcome, SelectedTaskReviewDecisionPersistenceStatus,
    SelectedTaskReviewDecisionRecord, SelectedTaskReviewNextGap, SelectedTaskReviewNextGapArea,
    SelectedTaskReviewOutcomeRouteInput, SelectedTaskReworkPreparationInput,
    SelectedTaskRouteAdmissionInput, TaskWorkflowDrilldown, TaskWorkflowDrilldownInput,
    TaskWorkflowNextStepInput, TaskWorkflowNextStepSource, TaskWorkflowReadinessInput,
    TaskWorkflowTaskInput, TaskWorkflowWorkProgressInput,
};

pub(super) fn input(
    review_status: &str,
    outcome: SelectedTaskReviewDecisionOutcome,
) -> SelectedTaskReworkPreparationInput {
    let route_admission = selected_task_route_admission(SelectedTaskRouteAdmissionInput {
        route: route(review_status, outcome),
        gate: gate(),
        expected_revision: Some(RevisionId("rev:task:1".to_owned())),
        operator_ref: "operator:test".to_owned(),
    });
    input_from_route_admission(route_admission)
}

pub(super) fn planning_ambiguous_input() -> SelectedTaskReworkPreparationInput {
    let route_admission = selected_task_route_admission(SelectedTaskRouteAdmissionInput {
        route: route_with_next_pathway_gap("rejected", SelectedTaskReviewDecisionOutcome::Rejected),
        gate: gate(),
        expected_revision: Some(RevisionId("rev:task:1".to_owned())),
        operator_ref: "operator:test".to_owned(),
    });
    input_from_route_admission(route_admission)
}

fn input_from_route_admission(
    route_admission: crate::SelectedTaskRouteAdmission,
) -> SelectedTaskReworkPreparationInput {
    let route_admission_id = route_admission.rework_delegation.admission_id.clone();
    let review_decision_ref = route_admission
        .rework_delegation
        .decision_ref
        .clone()
        .unwrap_or_else(|| "selected-task-review-decision:task:1:001".to_owned());
    let reviewed_work_item_refs = route_admission.rework_delegation.work_item_refs.clone();
    let reviewed_evidence_refs = route_admission.rework_delegation.evidence_refs.clone();

    SelectedTaskReworkPreparationInput {
        project_id: ProjectId("project:1".to_owned()),
        task_id: TaskId("task:1".to_owned()),
        operator_ref: "operator:test".to_owned(),
        route_admission_id,
        review_decision_ref,
        reviewed_work_item_refs,
        reviewed_evidence_refs,
        expected_task_revision: Some(RevisionId("rev:task:1".to_owned())),
        expected_work_item_revision: None,
        route_admission,
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

fn route_with_next_pathway_gap(
    review_status: &str,
    outcome: SelectedTaskReviewDecisionOutcome,
) -> crate::SelectedTaskReviewOutcomeRoute {
    let mut review_next = selected_task_review_next(&drilldown(review_status));
    review_next.gaps.push(SelectedTaskReviewNextGap {
        area: SelectedTaskReviewNextGapArea::NextPathway,
        reason: "ambiguous next pathway".to_owned(),
    });
    selected_task_review_outcome_route(SelectedTaskReviewOutcomeRouteInput {
        review_next,
        decision_records: vec![decision(outcome)],
        scm_handoff_refs: Vec::new(),
    })
}

fn gate() -> crate::SelectedTaskOperatorActionGate {
    let readiness = selected_task_action_readiness(&drilldown("accepted"));
    selected_task_operator_action_gate(SelectedTaskOperatorActionGateInput {
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
