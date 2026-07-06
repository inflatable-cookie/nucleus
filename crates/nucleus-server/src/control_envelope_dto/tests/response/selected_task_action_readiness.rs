use crate::{
    selected_task_action_readiness, task_workflow_drilldown, ControlResponseBodyDto,
    ControlResponseEnvelopeDto, ServerControlRequestId, ServerControlResponse,
    ServerControlResponseBody, ServerControlResponseStatus, ServerQueryResult,
    TaskWorkflowDrilldownInput, TaskWorkflowNextStepInput, TaskWorkflowNextStepSource,
    TaskWorkflowReadinessInput, TaskWorkflowTaskInput,
};
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

#[test]
fn response_envelope_dto_serializes_selected_task_action_readiness_without_effects() {
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
            lane: "agent_delegation_ready".to_owned(),
            rationale_refs: vec!["readiness:1".to_owned()],
        }),
        timeline_entry_refs: vec!["timeline:1".to_owned()],
        work_progress: Vec::new(),
        runtime_receipt_refs: Vec::new(),
        command_evidence_refs: Vec::new(),
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
    let readiness = selected_task_action_readiness(&drilldown);
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:selected-task-action".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::SelectedTaskActionReadiness(
            readiness,
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::SelectedTaskActionReadiness { readiness }
            if readiness.project_id == "project:dto"
                && readiness.task_id == "task:dto"
                && readiness.actions.len() == 9
                && readiness.actions.iter().any(|action|
                    action.family == "start_selected_task" && action.status == "allowed"
                )
                && !readiness.no_effects.task_mutation_performed
                && !readiness.no_effects.provider_execution_performed
                && !readiness.no_effects.scm_or_forge_mutation_performed
                && !readiness.no_effects.ui_effect_performed
    ));
    assert!(json.contains("\"type\":\"selected_task_action_readiness\""));
    assert!(json.contains("\"family\":\"prepare_delegation\""));
    assert!(json.contains("\"provider_execution_performed\":false"));
}
