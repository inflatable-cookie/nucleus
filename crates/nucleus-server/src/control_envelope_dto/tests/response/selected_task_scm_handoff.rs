use crate::{
    selected_task_scm_handoff_readiness, task_workflow_drilldown, ControlResponseBodyDto,
    ControlResponseEnvelopeDto, ServerControlResponse, ServerControlResponseBody,
    ServerControlResponseStatus, ServerQueryResult, TaskWorkflowDrilldownInput,
    TaskWorkflowNextStepInput, TaskWorkflowNextStepSource, TaskWorkflowReadinessInput,
    TaskWorkflowTaskInput, TaskWorkflowWorkProgressInput,
};
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

#[test]
fn response_envelope_dto_serializes_selected_task_scm_handoff_without_effects() {
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
        scm_handoff_refs: vec![
            "scm-session:1".to_owned(),
            "change:1".to_owned(),
            "change-request-prep:1".to_owned(),
            "forge-review:target:1".to_owned(),
        ],
        next_step: Some(TaskWorkflowNextStepInput {
            source: TaskWorkflowNextStepSource::ScmHandoff,
            next_ref: Some("change-request-prep:1".to_owned()),
            summary: "Review selected task SCM handoff".to_owned(),
            rationale_refs: vec!["completion:task:1".to_owned()],
        }),
    });
    let handoff = selected_task_scm_handoff_readiness(&drilldown);
    let response = ServerControlResponse {
        request_id: crate::ids::ServerControlRequestId("request:scm-handoff".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::SelectedTaskScmHandoff(handoff)),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let ControlResponseBodyDto::SelectedTaskScmHandoff { handoff } = &dto.body else {
        panic!("expected selected task SCM handoff body");
    };
    let json = serde_json::to_string(&dto).expect("serialize dto");

    assert_eq!(handoff.project_id, "project:1");
    assert_eq!(handoff.task_id, "task:1");
    assert_eq!(handoff.readiness.state, "prep_ready");
    assert_eq!(handoff.target.shape, "forge_review");
    assert_eq!(handoff.next.category, "review_preparation");
    assert!(!handoff.no_effects.scm_mutation_performed);
    assert!(!handoff.no_effects.forge_mutation_performed);
    assert!(!handoff.no_effects.credential_resolution_performed);
    assert!(!handoff.no_effects.provider_execution_performed);
    assert!(json.contains("\"type\":\"selected_task_scm_handoff\""));
    assert!(json.contains("\"scm_mutation_performed\":false"));
    assert!(!json.contains("raw_payload"));
}
