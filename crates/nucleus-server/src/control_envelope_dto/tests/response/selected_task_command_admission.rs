use nucleus_core::RevisionId;

use crate::{
    selected_task_action_readiness, selected_task_command_admission,
    selected_task_operator_action_gate, task_workflow_drilldown, ControlResponseBodyDto,
    ControlResponseEnvelopeDto, SelectedTaskActionFamily, SelectedTaskCommandAdmissionInput,
    SelectedTaskCommandOperatorIntent, SelectedTaskOperatorActionGateInput, ServerControlResponse,
    ServerControlResponseBody, ServerControlResponseStatus, ServerQueryResult,
    TaskWorkflowDrilldownInput, TaskWorkflowNextStepInput, TaskWorkflowNextStepSource,
    TaskWorkflowReadinessInput, TaskWorkflowTaskInput,
};
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

#[test]
fn response_envelope_dto_serializes_selected_task_command_admission_as_dry_run() {
    let drilldown = task_workflow_drilldown(TaskWorkflowDrilldownInput {
        project_id: ProjectId("project:1".to_owned()),
        task_id: TaskId("task:1".to_owned()),
        task: Some(TaskWorkflowTaskInput {
            title: "Selected task".to_owned(),
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
            next_ref: Some("task:1".to_owned()),
            summary: "Continue selected task".to_owned(),
            rationale_refs: vec!["readiness:1".to_owned()],
        }),
    });
    let readiness = selected_task_action_readiness(&drilldown);
    let gate = selected_task_operator_action_gate(SelectedTaskOperatorActionGateInput {
        readiness,
        expected_revision: None,
        actor_ref: Some("operator:test".to_owned()),
    });
    let admission = selected_task_command_admission(SelectedTaskCommandAdmissionInput {
        gate,
        intent: SelectedTaskCommandOperatorIntent {
            family: SelectedTaskActionFamily::StartSelectedTask,
            expected_revision: Some(RevisionId("rev:task:1".to_owned())),
            reason: None,
            operator_ref: "operator:test".to_owned(),
        },
    });
    let response = ServerControlResponse {
        request_id: crate::ids::ServerControlRequestId("request:admission".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::SelectedTaskCommandAdmission(
            admission,
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let ControlResponseBodyDto::SelectedTaskCommandAdmission { admission } = &dto.body else {
        panic!("expected selected task command admission body");
    };
    let json = serde_json::to_string(&dto).expect("serialize dto");

    assert_eq!(admission.status, "admitted");
    assert_eq!(admission.family, "start_selected_task");
    assert_eq!(
        admission
            .command
            .as_ref()
            .map(|command| command.action.as_str()),
        Some("start")
    );
    assert_eq!(admission.refusal, None);
    assert!(!admission.no_effects.task_mutation_performed);
    assert!(!admission.no_effects.provider_execution_performed);
    assert!(!admission.no_effects.scm_or_forge_mutation_performed);
    assert!(json.contains("\"type\":\"selected_task_command_admission\""));
    assert!(!json.contains("raw_payload"));
}
