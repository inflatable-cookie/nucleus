use nucleus_server::{
    ControlSelectedTaskActionBlockerDto, ControlSelectedTaskActionDto,
    ControlSelectedTaskActionNoEffectsDto, ControlSelectedTaskActionReadinessDto,
    ControlSelectedTaskActionSourceCountsDto,
};

use super::*;

#[test]
fn selected_task_action_readiness_response_lines_are_read_only_and_sanitized() {
    let lines = typed_response::selected_task_action_readiness_response_lines(
        "selected-task-action-readiness",
        ControlSelectedTaskActionReadinessDto {
            readiness_id: "selected-task-action-readiness:task:nucleus-local:bootstrap".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            task_id: "task:nucleus-local:bootstrap".to_owned(),
            actions: vec![
                ControlSelectedTaskActionDto {
                    family: "start_selected_task".to_owned(),
                    status: "allowed".to_owned(),
                    label: "Start selected task".to_owned(),
                    reason: "selected task has enough readiness".to_owned(),
                    evidence_refs: vec!["readiness:1".to_owned()],
                    blocker_refs: Vec::new(),
                },
                ControlSelectedTaskActionDto {
                    family: "complete_selected_task".to_owned(),
                    status: "blocked".to_owned(),
                    label: "Complete selected task".to_owned(),
                    reason: "no completion evidence exists".to_owned(),
                    evidence_refs: vec!["gap:Runtime".to_owned()],
                    blocker_refs: vec!["gap:Runtime".to_owned()],
                },
            ],
            source_counts: ControlSelectedTaskActionSourceCountsDto {
                task_records: 1,
                readiness_refs: 1,
                work_items: 0,
                active_work_items: 0,
                completed_work_items: 0,
                runtime_evidence_refs: 0,
                completion_refs: 0,
                review_refs: 0,
                scm_handoff_refs: 0,
                gap_count: 4,
            },
            blockers: vec![ControlSelectedTaskActionBlockerDto {
                family: "complete_selected_task".to_owned(),
                reason: "no completion evidence exists".to_owned(),
                evidence_refs: vec!["gap:Runtime".to_owned()],
            }],
            no_effects: ControlSelectedTaskActionNoEffectsDto {
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

    assert!(rendered.contains("domain=selected-task-action-readiness"));
    assert!(rendered.contains("actions=2 blockers=1"));
    assert!(rendered.contains("action family=start_selected_task status=allowed"));
    assert!(rendered.contains("blocker family=complete_selected_task"));
    assert!(rendered.contains("task_mutation=false"));
    assert!(rendered.contains("provider_execution=false"));
    assert!(rendered.contains("scm_or_forge_mutation=false"));
    assert!(rendered.contains("client_can_execute=false"));
    assert!(rendered.contains("payloads_exposed=false"));
    assert!(!rendered.contains("raw_payload"));
}
