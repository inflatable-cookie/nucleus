use nucleus_server::{
    ControlSelectedTaskReworkPreparationDto, ControlSelectedTaskReworkPreparationNoEffectsDto,
    ControlSelectedTaskReworkPreparationRefusalDto,
};

use super::*;

#[test]
fn selected_task_rework_preparation_response_lines_are_read_only_and_sanitized() {
    let lines = typed_response::selected_task_rework_preparation_response_lines(
        "selected-task-rework-preparation",
        ControlSelectedTaskReworkPreparationDto {
            preparation_id: "selected-task-rework-preparation:task:nucleus-local:bootstrap"
                .to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            task_id: "task:nucleus-local:bootstrap".to_owned(),
            route_admission_id:
                "selected-task-rework-delegation-route-admission:task:nucleus-local:bootstrap"
                    .to_owned(),
            route_id: "selected-task-review-outcome-route:task:nucleus-local:bootstrap".to_owned(),
            review_decision_ref: Some("selected-task-review-decision:1".to_owned()),
            status: "refused".to_owned(),
            refusal: Some(ControlSelectedTaskReworkPreparationRefusalDto {
                kind: "route_admission_refused".to_owned(),
                reason: "route refused".to_owned(),
            }),
            reviewed_work_item_refs: vec!["work:1".to_owned()],
            reviewed_evidence_refs: vec!["checkpoint:1".to_owned()],
            operator_ref: "operator:nucleusd".to_owned(),
            expected_task_revision: Some("rev:task:1".to_owned()),
            expected_work_item_revision: Some("rev:work:1".to_owned()),
            rework_summary: None,
            no_effects: no_effects(),
        },
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=selected-task-rework-preparation"));
    assert!(rendered.contains("status=refused"));
    assert!(rendered.contains("refusal=route_admission_refused"));
    assert!(rendered.contains("reviewed_work_item_refs=1"));
    assert!(rendered.contains("reviewed_evidence_refs=1"));
    assert!(rendered.contains("mode=read_only_preview"));
    assert!(rendered.contains("work_item_creation_available=false"));
    assert!(rendered.contains("work_item_creation=false"));
    assert!(rendered.contains("provider_execution=false"));
    assert!(rendered.contains("scm_or_forge_mutation=false"));
    assert!(rendered.contains("payloads_exposed=false"));
    assert!(!rendered.contains("raw_payload"));
    assert!(!rendered.contains("private:context"));
}

fn no_effects() -> ControlSelectedTaskReworkPreparationNoEffectsDto {
    ControlSelectedTaskReworkPreparationNoEffectsDto {
        review_mutation_performed: false,
        task_lifecycle_mutation_performed: false,
        work_item_creation_performed: false,
        provider_execution_performed: false,
        provider_write_performed: false,
        scm_or_forge_mutation_performed: false,
        accepted_memory_apply_performed: false,
        planning_apply_performed: false,
        projection_write_performed: false,
        agent_scheduling_performed: false,
        ui_effect_performed: false,
    }
}
