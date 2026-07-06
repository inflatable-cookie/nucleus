use crate::{
    task_workflow_drilldown, ControlResponseBodyDto, ControlResponseEnvelopeDto,
    ServerControlRequestId, ServerControlResponse, ServerControlResponseBody,
    ServerControlResponseStatus, ServerQueryResult, TaskWorkflowDrilldownInput,
    TaskWorkflowNextStepInput, TaskWorkflowNextStepSource, TaskWorkflowReadinessInput,
    TaskWorkflowTaskInput, TaskWorkflowWorkProgressInput,
};
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

#[test]
fn response_envelope_dto_serializes_task_workflow_drilldown_without_effects() {
    let drilldown = task_workflow_drilldown(TaskWorkflowDrilldownInput {
        project_id: ProjectId("project:dto".to_owned()),
        task_id: TaskId("task:dto".to_owned()),
        task: Some(TaskWorkflowTaskInput {
            title: "DTO Task".to_owned(),
            activity: "ready".to_owned(),
            assignment: "unassigned".to_owned(),
            action_type: "execute".to_owned(),
        }),
        readiness: Some(TaskWorkflowReadinessInput {
            lane: "human_planning_ready".to_owned(),
            rationale_refs: vec!["readiness:1".to_owned()],
        }),
        timeline_entry_refs: vec!["timeline:1".to_owned()],
        work_progress: vec![TaskWorkflowWorkProgressInput {
            work_item_ref: "work:1".to_owned(),
            runtime_status: "running".to_owned(),
            review_status: "not_ready".to_owned(),
            source_ref: "source:1".to_owned(),
            source_count: 1,
            session_ref: None,
            turn_refs: Vec::new(),
            receipt_refs: vec!["receipt:1".to_owned()],
            checkpoint_refs: Vec::new(),
            diff_summary_refs: Vec::new(),
            timeline_entry_refs: vec!["timeline:1".to_owned()],
            validation_refs: Vec::new(),
            artifact_refs: Vec::new(),
            issue_refs: Vec::new(),
        }],
        runtime_receipt_refs: vec!["receipt:1".to_owned()],
        command_evidence_refs: vec!["command:evidence:1".to_owned()],
        task_completion_refs: Vec::new(),
        review_refs: Vec::new(),
        scm_handoff_refs: Vec::new(),
        next_step: Some(TaskWorkflowNextStepInput {
            source: TaskWorkflowNextStepSource::Task,
            next_ref: Some("task:dto".to_owned()),
            summary: "Continue selected task.".to_owned(),
            rationale_refs: vec!["readiness:1".to_owned()],
        }),
    });
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:task-workflow".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::TaskWorkflowDrilldown(drilldown)),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::TaskWorkflowDrilldown { drilldown }
            if drilldown.project_id == "project:dto"
                && drilldown.task_id == "task:dto"
                && drilldown.source_counts.work_items == 1
                && drilldown.next.source == "task"
                && !drilldown.no_effects.task_mutation_performed
                && !drilldown.no_effects.provider_execution_performed
                && !drilldown.no_effects.scm_or_forge_mutation_performed
                && !drilldown.no_effects.ui_effect_performed
    ));
    assert!(json.contains("\"type\":\"task_workflow_drilldown\""));
    assert!(json.contains("\"task_mutation_performed\":false"));
    assert!(json.contains("\"provider_execution_performed\":false"));
}
