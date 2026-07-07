use nucleus_server::{
    ControlSelectedTaskCommandAdmissionCandidateDto, ControlSelectedTaskCommandAdmissionCommandDto,
    ControlSelectedTaskCommandAdmissionDto, ControlSelectedTaskCommandAdmissionNoEffectsDto,
};

use super::*;

#[test]
fn selected_task_command_admission_response_lines_are_dry_run_and_sanitized() {
    let lines = typed_response::selected_task_command_admission_response_lines(
        "selected-task-command-admission",
        ControlSelectedTaskCommandAdmissionDto {
            admission_id: "selected-task-command-admission:task:nucleus-local:bootstrap".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            task_id: "task:nucleus-local:bootstrap".to_owned(),
            family: "start_selected_task".to_owned(),
            status: "admitted".to_owned(),
            command: Some(ControlSelectedTaskCommandAdmissionCommandDto {
                action: "start".to_owned(),
                task_id: "task:nucleus-local:bootstrap".to_owned(),
                expected_revision: Some("rev:nucleus-local:bootstrap".to_owned()),
                reason: None,
            }),
            candidate: Some(ControlSelectedTaskCommandAdmissionCandidateDto {
                family: "start_selected_task".to_owned(),
                readiness_status: "allowed".to_owned(),
                disposition: "task_command_candidate".to_owned(),
                label: "Start selected task".to_owned(),
                reason: "selected task has enough readiness".to_owned(),
                evidence_refs: vec!["readiness:1".to_owned()],
                blocker_refs: Vec::new(),
                expected_revision_required: true,
                reason_required: false,
            }),
            refusal: None,
            operator_ref: "operator:test".to_owned(),
            evidence_refs: vec!["readiness:1".to_owned()],
            no_effects: ControlSelectedTaskCommandAdmissionNoEffectsDto {
                task_mutation_performed: false,
                provider_execution_performed: false,
                provider_write_performed: false,
                scm_or_forge_mutation_performed: false,
                accepted_memory_apply_performed: false,
                planning_apply_performed: false,
                projection_write_performed: false,
                agent_scheduling_performed: false,
                ui_effect_performed: false,
            },
        },
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=selected-task-command-admission"));
    assert!(rendered.contains("mode=dry_run"));
    assert!(rendered.contains("status=admitted"));
    assert!(rendered.contains("command_action=start"));
    assert!(rendered.contains("expected_revision_required=true"));
    assert!(rendered.contains("task_mutation_performed=false"));
    assert!(rendered.contains("provider_execution_performed=false"));
    assert!(rendered.contains("scm_or_forge_mutation_performed=false"));
    assert!(rendered.contains("command_executed=false"));
    assert!(rendered.contains("client_can_mutate=false"));
    assert!(!rendered.contains("raw_payload"));
}
