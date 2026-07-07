use crate::{
    selected_task_review_next, task_workflow_drilldown, ControlResponseBodyDto,
    ControlResponseEnvelopeDto, ServerControlResponse, ServerControlResponseBody,
    ServerControlResponseStatus, ServerQueryResult, TaskWorkflowDrilldownInput,
    TaskWorkflowNextStepInput, TaskWorkflowNextStepSource, TaskWorkflowReadinessInput,
    TaskWorkflowTaskInput, TaskWorkflowWorkProgressInput,
};
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

#[test]
fn response_envelope_dto_serializes_selected_task_review_next_without_effects() {
    let drilldown = task_workflow_drilldown(TaskWorkflowDrilldownInput {
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
            review_status: "awaiting_review".to_owned(),
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
        review_refs: Vec::new(),
        scm_handoff_refs: Vec::new(),
        next_step: Some(TaskWorkflowNextStepInput {
            source: TaskWorkflowNextStepSource::Review,
            next_ref: Some("review:task:1".to_owned()),
            summary: "Review selected task evidence".to_owned(),
            rationale_refs: vec!["completion:task:1".to_owned()],
        }),
    });
    let review_next = selected_task_review_next(&drilldown);
    let response = ServerControlResponse {
        request_id: crate::ids::ServerControlRequestId("request:review-next".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::SelectedTaskReviewNext(
            review_next,
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let ControlResponseBodyDto::SelectedTaskReviewNext { review_next } = &dto.body else {
        panic!("expected selected task review next body");
    };
    let json = serde_json::to_string(&dto).expect("serialize dto");

    assert_eq!(review_next.project_id, "project:1");
    assert_eq!(review_next.task_id, "task:1");
    assert_eq!(review_next.review.state, "awaiting_review");
    assert_eq!(review_next.next.category, "review_evidence");
    assert!(!review_next.no_effects.review_mutation_performed);
    assert!(!review_next.no_effects.task_mutation_performed);
    assert!(!review_next.no_effects.provider_execution_performed);
    assert!(!review_next.no_effects.scm_or_forge_mutation_performed);
    assert!(json.contains("\"type\":\"selected_task_review_next\""));
    assert!(json.contains("\"review_mutation_performed\":false"));
    assert!(!json.contains("raw_payload"));
}
