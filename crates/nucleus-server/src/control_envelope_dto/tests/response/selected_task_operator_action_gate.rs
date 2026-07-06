use nucleus_core::RevisionId;

use crate::{
    selected_task_action_readiness, selected_task_operator_action_gate, task_workflow_drilldown,
    ControlResponseBodyDto, ControlResponseEnvelopeDto, SelectedTaskOperatorActionGateInput,
    ServerControlResponse, ServerControlResponseBody, ServerControlResponseStatus,
    ServerQueryResult, TaskWorkflowDrilldownInput, TaskWorkflowNextStepInput,
    TaskWorkflowNextStepSource, TaskWorkflowReadinessInput, TaskWorkflowTaskInput,
};
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

#[test]
fn response_envelope_dto_serializes_selected_task_operator_action_gate_without_effects() {
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
        expected_revision: Some(RevisionId("rev:task:1".to_owned())),
        actor_ref: Some("operator:test".to_owned()),
    });
    let response = ServerControlResponse {
        request_id: crate::ids::ServerControlRequestId("request:gate".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::SelectedTaskOperatorActionGate(
            gate,
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let ControlResponseBodyDto::SelectedTaskOperatorActionGate { gate } = &dto.body else {
        panic!("expected gate body");
    };
    let json = serde_json::to_string(&dto).expect("serialize dto");

    assert_eq!(gate.source_counts.task_command_candidates, 2);
    assert!(gate.candidates.iter().any(|candidate| candidate.disposition
        == "task_command_candidate"
        && candidate.task_command.is_some()));
    assert!(gate
        .candidates
        .iter()
        .any(|candidate| candidate.disposition == "deferred" && candidate.task_command.is_none()));
    assert!(!gate.no_effects.task_mutation_performed);
    assert!(!gate.no_effects.provider_execution_performed);
    assert!(!gate.no_effects.scm_or_forge_mutation_performed);
    assert!(json.contains("\"type\":\"selected_task_operator_action_gate\""));
    assert!(!json.contains("raw_payload"));
}
