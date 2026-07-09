use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use super::{
    selected_task_product_aggregate, SelectedTaskProductAggregateInput, SelectedTaskProductSource,
    SelectedTaskProductSourceState,
};
use crate::{
    selected_task_action_readiness, selected_task_command_admission,
    selected_task_completion_route_apply, selected_task_operator_action_gate,
    selected_task_review_next, selected_task_review_outcome_route,
    selected_task_rework_preparation, selected_task_route_admission,
    selected_task_scm_handoff_readiness, task_workflow_drilldown, SelectedTaskActionFamily,
    SelectedTaskCommandAdmissionInput, SelectedTaskCommandOperatorIntent,
    SelectedTaskCompletionRouteApplyInput, SelectedTaskOperatorActionGateInput,
    SelectedTaskReviewDecisionAction, SelectedTaskReviewDecisionOutcome,
    SelectedTaskReviewDecisionPersistenceStatus, SelectedTaskReviewDecisionRecord,
    SelectedTaskReviewOutcomeRouteCandidate, SelectedTaskReviewOutcomeRouteInput,
    SelectedTaskReviewOutcomeRouteStatus, SelectedTaskReviewState,
    SelectedTaskReworkPreparationInput, SelectedTaskReworkPreparationStatus,
    SelectedTaskRouteAdmissionInput, TaskWorkflowDrilldown, TaskWorkflowDrilldownInput,
    TaskWorkflowNextStepInput, TaskWorkflowNextStepSource, TaskWorkflowReadinessInput,
    TaskWorkflowTaskInput, TaskWorkflowWorkProgressInput,
};

#[test]
fn aggregate_composes_product_groups_from_existing_sources() {
    let input = accepted_input();

    let aggregate = selected_task_product_aggregate(input);

    assert_eq!(
        aggregate.aggregate_id,
        "selected-task-product-aggregate:task:1"
    );
    assert_eq!(aggregate.identity.title, Some("Selected task".to_owned()));
    assert_eq!(aggregate.identity.activity, Some("active".to_owned()));
    assert_eq!(aggregate.workflow.phase, "operator_action");
    assert!(!aggregate.workflow.primary_next_action.is_empty());
    assert_eq!(aggregate.work_evidence.completed_work_item_count, 1);
    assert_eq!(aggregate.work_evidence.active_work_item_count, 0);
    assert!(aggregate
        .work_evidence
        .evidence_refs
        .contains(&"checkpoint:work:1".to_owned()));
    assert_eq!(
        aggregate.review.state,
        Some(SelectedTaskReviewState::Accepted)
    );
    assert_eq!(
        aggregate.review.route_status,
        Some(SelectedTaskReviewOutcomeRouteStatus::Ready)
    );
    assert_eq!(
        aggregate.review.primary_route,
        Some(SelectedTaskReviewOutcomeRouteCandidate::ReadyForCompletionAdmission)
    );
    assert!(aggregate.review.decision_available);
    assert!(aggregate.completion.status.is_some());
    assert!(!aggregate.completion.command_available);
    assert!(aggregate.completion.refusal_reason.is_some());
    assert_eq!(
        aggregate.command_previews.admitted_count + aggregate.command_previews.refused_count,
        1
    );
    assert_eq!(aggregate.command_previews.previews.len(), 1);
    assert_eq!(
        aggregate.rework.status,
        Some(SelectedTaskReworkPreparationStatus::Refused)
    );
    assert!(aggregate.scm_handoff.state.is_some());
    assert_eq!(aggregate.source_health.missing_count, 0);
    assert_eq!(aggregate.source_health.partial_count, 0);
    assert!(aggregate.gaps.is_empty());
    assert!(!aggregate.no_effects.task_mutation_performed);
    assert!(!aggregate.no_effects.provider_execution_performed);
    assert!(!aggregate.no_effects.scm_or_forge_mutation_performed);
    assert!(!aggregate.no_effects.ui_effect_performed);
}

#[test]
fn aggregate_reports_missing_sources_as_blocked_product_state() {
    let aggregate = selected_task_product_aggregate(SelectedTaskProductAggregateInput {
        project_id: project_id(),
        task_id: task_id(),
        expected_revision: None,
        drilldown: None,
        action_readiness: None,
        operator_gate: None,
        command_admissions: Vec::new(),
        review_next: None,
        review_outcome_route: None,
        route_admission: None,
        completion_apply: None,
        rework_preparation: None,
        scm_handoff: None,
    });

    assert_eq!(aggregate.workflow.phase, "source_gap");
    assert_eq!(
        aggregate.workflow.blocked_reason,
        Some("selected task workflow sources are missing".to_owned())
    );
    assert_eq!(aggregate.source_health.missing_count, 10);
    assert_eq!(aggregate.gaps.len(), 10);
    assert!(aggregate
        .source_health
        .sources
        .iter()
        .all(|source| source.state == SelectedTaskProductSourceState::Missing));
    assert!(aggregate
        .gaps
        .iter()
        .any(|gap| gap.source == SelectedTaskProductSource::Drilldown));
    assert_eq!(aggregate.readiness.allowed_action_count, 0);
    assert!(!aggregate.no_effects.agent_scheduling_performed);
}

fn accepted_input() -> SelectedTaskProductAggregateInput {
    let drilldown = drilldown("accepted");
    let action_readiness = selected_task_action_readiness(&drilldown);
    let operator_gate = selected_task_operator_action_gate(SelectedTaskOperatorActionGateInput {
        readiness: action_readiness.clone(),
        expected_revision: Some(revision()),
        actor_ref: Some("operator:test".to_owned()),
    });
    let review_next = selected_task_review_next(&drilldown);
    let review_outcome_route =
        selected_task_review_outcome_route(SelectedTaskReviewOutcomeRouteInput {
            review_next: review_next.clone(),
            decision_records: vec![decision(SelectedTaskReviewDecisionOutcome::Accepted)],
            scm_handoff_refs: vec!["scm:handoff:1".to_owned()],
        });
    let route_admission = selected_task_route_admission(SelectedTaskRouteAdmissionInput {
        route: review_outcome_route.clone(),
        gate: operator_gate.clone(),
        expected_revision: Some(revision()),
        operator_ref: "operator:test".to_owned(),
    });
    let command_admissions = vec![selected_task_command_admission(
        SelectedTaskCommandAdmissionInput {
            gate: operator_gate.clone(),
            intent: SelectedTaskCommandOperatorIntent {
                family: SelectedTaskActionFamily::CompleteSelectedTask,
                expected_revision: Some(revision()),
                reason: None,
                operator_ref: "operator:test".to_owned(),
            },
        },
    )];
    let completion_apply =
        selected_task_completion_route_apply(SelectedTaskCompletionRouteApplyInput {
            project_id: project_id(),
            task_id: task_id(),
            expected_revision: Some(revision()),
            operator_ref: "operator:test".to_owned(),
            route_admission_id: route_admission.completion.admission_id.clone(),
            review_decision_ref: route_admission
                .completion
                .decision_ref
                .clone()
                .expect("decision ref"),
            evidence_refs: route_admission.completion.evidence_refs.clone(),
            route_admission: route_admission.clone(),
        });
    let rework_preparation = selected_task_rework_preparation(SelectedTaskReworkPreparationInput {
        project_id: project_id(),
        task_id: task_id(),
        operator_ref: "operator:test".to_owned(),
        route_admission_id: route_admission.rework_delegation.admission_id.clone(),
        review_decision_ref: route_admission
            .rework_delegation
            .decision_ref
            .clone()
            .unwrap_or_else(|| "selected-task-review-decision:task:1:001".to_owned()),
        reviewed_work_item_refs: route_admission.rework_delegation.work_item_refs.clone(),
        reviewed_evidence_refs: route_admission.rework_delegation.evidence_refs.clone(),
        expected_task_revision: Some(revision()),
        expected_work_item_revision: None,
        route_admission: route_admission.clone(),
    });
    let scm_handoff = selected_task_scm_handoff_readiness(&drilldown);

    SelectedTaskProductAggregateInput {
        project_id: project_id(),
        task_id: task_id(),
        expected_revision: Some(revision()),
        drilldown: Some(drilldown),
        action_readiness: Some(action_readiness),
        operator_gate: Some(operator_gate),
        command_admissions,
        review_next: Some(review_next),
        review_outcome_route: Some(review_outcome_route),
        route_admission: Some(route_admission),
        completion_apply: Some(completion_apply),
        rework_preparation: Some(rework_preparation),
        scm_handoff: Some(scm_handoff),
    }
}

fn drilldown(review_status: &str) -> TaskWorkflowDrilldown {
    task_workflow_drilldown(TaskWorkflowDrilldownInput {
        project_id: project_id(),
        task_id: task_id(),
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
        scm_handoff_refs: vec!["scm:handoff:1".to_owned()],
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
        project_id: project_id().0,
        task_id: task_id().0,
        work_item_refs: vec!["work:1".to_owned()],
        action: SelectedTaskReviewDecisionAction::AcceptEvidence,
        outcome,
        operator_ref: "operator:test".to_owned(),
        expected_revision: revision().0,
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

fn project_id() -> ProjectId {
    ProjectId("project:1".to_owned())
}

fn task_id() -> TaskId {
    TaskId("task:1".to_owned())
}

fn revision() -> RevisionId {
    RevisionId("rev:task:1".to_owned())
}
