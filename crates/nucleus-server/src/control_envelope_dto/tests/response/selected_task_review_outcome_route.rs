use crate::{
    selected_task_review_next, selected_task_review_outcome_route, task_workflow_drilldown,
    ControlResponseBodyDto, ControlResponseEnvelopeDto, SelectedTaskReviewDecisionAction,
    SelectedTaskReviewDecisionOutcome, SelectedTaskReviewDecisionPersistenceStatus,
    SelectedTaskReviewDecisionRecord, SelectedTaskReviewOutcomeRouteInput, ServerControlResponse,
    ServerControlResponseBody, ServerControlResponseStatus, ServerQueryResult,
    TaskWorkflowDrilldownInput, TaskWorkflowNextStepInput, TaskWorkflowNextStepSource,
    TaskWorkflowReadinessInput, TaskWorkflowTaskInput, TaskWorkflowWorkProgressInput,
};
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

#[test]
fn response_envelope_dto_serializes_selected_task_review_outcome_route_without_effects() {
    let review_next =
        selected_task_review_next(&task_workflow_drilldown(TaskWorkflowDrilldownInput {
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
                work_item_ref: "work:1".to_owned(),
                runtime_status: "completed".to_owned(),
                review_status: "accepted".to_owned(),
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
            }],
            runtime_receipt_refs: vec!["receipt:task:1".to_owned()],
            command_evidence_refs: Vec::new(),
            task_completion_refs: vec!["completion:task:1".to_owned()],
            review_refs: vec!["review:accepted:1".to_owned()],
            scm_handoff_refs: vec!["scm:handoff:1".to_owned()],
            next_step: Some(TaskWorkflowNextStepInput {
                source: TaskWorkflowNextStepSource::Review,
                next_ref: Some("review:task:1".to_owned()),
                summary: "Review selected task evidence".to_owned(),
                rationale_refs: vec!["completion:task:1".to_owned()],
            }),
        }));
    let route = selected_task_review_outcome_route(SelectedTaskReviewOutcomeRouteInput {
        review_next,
        decision_records: vec![decision()],
        scm_handoff_refs: vec!["scm:handoff:1".to_owned()],
    });
    let response = ServerControlResponse {
        request_id: crate::ids::ServerControlRequestId("request:review-outcome-route".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::SelectedTaskReviewOutcomeRoute(
            route,
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let ControlResponseBodyDto::SelectedTaskReviewOutcomeRoute { route } = &dto.body else {
        panic!("expected selected task review outcome route body");
    };
    let json = serde_json::to_string(&dto).expect("serialize dto");

    assert_eq!(route.project_id, "project:1");
    assert_eq!(route.task_id, "task:1");
    assert_eq!(route.status, "ready");
    assert_eq!(route.primary_route, "ready_for_completion_admission");
    assert!(route
        .candidates
        .contains(&"ready_for_scm_handoff_review".to_owned()));
    assert_eq!(route.decision_outcome.as_deref(), Some("accepted"));
    assert!(!route.no_effects.review_mutation_performed);
    assert!(!route.no_effects.task_lifecycle_mutation_performed);
    assert!(!route.no_effects.provider_execution_performed);
    assert!(!route.no_effects.scm_or_forge_mutation_performed);
    assert!(json.contains("\"type\":\"selected_task_review_outcome_route\""));
    assert!(json.contains("\"task_lifecycle_mutation_performed\":false"));
    assert!(!json.contains("raw_payload"));
}

fn decision() -> SelectedTaskReviewDecisionRecord {
    SelectedTaskReviewDecisionRecord {
        decision_id: "selected-task-review-decision:task:1:accept".to_owned(),
        admission_id: "selected-task-review-decision-admission:task:1:accept".to_owned(),
        project_id: "project:1".to_owned(),
        task_id: "task:1".to_owned(),
        work_item_refs: vec!["work:1".to_owned()],
        action: SelectedTaskReviewDecisionAction::AcceptEvidence,
        outcome: SelectedTaskReviewDecisionOutcome::Accepted,
        operator_ref: "operator:test".to_owned(),
        expected_revision: "rev:task:1".to_owned(),
        reviewed_evidence_refs: vec!["checkpoint:work:1".to_owned()],
        receipt_refs: vec!["receipt:work:1".to_owned()],
        timeline_refs: vec!["timeline:review:1".to_owned()],
        reason_summary: None,
        idempotency_key: "accept".to_owned(),
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
