use nucleus_server::{
    ControlSelectedTaskOperatorActionBlockerDto, ControlSelectedTaskOperatorActionCandidateDto,
    ControlSelectedTaskOperatorActionGateDto, ControlSelectedTaskOperatorActionGateSourceCountsDto,
    ControlSelectedTaskOperatorActionNoEffectsDto,
    ControlSelectedTaskOperatorTaskCommandCandidateDto,
};

use super::*;

#[test]
fn selected_task_operator_action_gate_response_lines_are_read_only_and_sanitized() {
    let lines = typed_response::selected_task_operator_action_gate_response_lines(
        "selected-task-operator-action-gate",
        ControlSelectedTaskOperatorActionGateDto {
            gate_id: "selected-task-operator-action-gate:task:nucleus-local:bootstrap".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            task_id: "task:nucleus-local:bootstrap".to_owned(),
            expected_revision: None,
            actor_ref: Some("client:nucleusd".to_owned()),
            candidates: vec![
                ControlSelectedTaskOperatorActionCandidateDto {
                    family: "start_selected_task".to_owned(),
                    readiness_status: "allowed".to_owned(),
                    disposition: "task_command_candidate".to_owned(),
                    task_command: Some(ControlSelectedTaskOperatorTaskCommandCandidateDto {
                        action: "start".to_owned(),
                        task_id: "task:nucleus-local:bootstrap".to_owned(),
                        expected_revision: None,
                    }),
                    label: "Start selected task".to_owned(),
                    reason: "selected task has enough readiness".to_owned(),
                    evidence_refs: vec!["readiness:1".to_owned()],
                    blocker_refs: Vec::new(),
                    expected_revision_required: true,
                    reason_required: false,
                },
                ControlSelectedTaskOperatorActionCandidateDto {
                    family: "prepare_delegation".to_owned(),
                    readiness_status: "allowed".to_owned(),
                    disposition: "deferred".to_owned(),
                    task_command: None,
                    label: "Prepare delegation".to_owned(),
                    reason: "delegation scheduling is not in scope".to_owned(),
                    evidence_refs: vec!["readiness:1".to_owned()],
                    blocker_refs: Vec::new(),
                    expected_revision_required: false,
                    reason_required: false,
                },
            ],
            source_counts: ControlSelectedTaskOperatorActionGateSourceCountsDto {
                readiness_actions: 2,
                task_command_candidates: 1,
                blocked_actions: 0,
                read_only_actions: 0,
                deferred_actions: 1,
                evidence_refs: 2,
                blocker_refs: 0,
            },
            blockers: vec![ControlSelectedTaskOperatorActionBlockerDto {
                family: "complete_selected_task".to_owned(),
                reason: "no completion evidence exists".to_owned(),
                evidence_refs: vec!["gap:Runtime".to_owned()],
            }],
            no_effects: ControlSelectedTaskOperatorActionNoEffectsDto {
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

    assert!(rendered.contains("domain=selected-task-operator-action-gate"));
    assert!(rendered.contains("task_command_candidates=1"));
    assert!(rendered
        .contains("candidate family=start_selected_task disposition=task_command_candidate"));
    assert!(rendered.contains("candidate family=prepare_delegation disposition=deferred"));
    assert!(rendered.contains("task_command=start"));
    assert!(rendered.contains("expected_revision=required_at_command_time"));
    assert!(rendered.contains("candidate family=prepare_delegation disposition=deferred readiness_status=allowed task_command=none expected_revision_required=false expected_revision=not_applicable"));
    assert!(rendered.contains("task_mutation=false"));
    assert!(rendered.contains("client_can_execute=false"));
    assert!(rendered.contains("payloads_exposed=false"));
    assert!(!rendered.contains("raw_payload"));
}
