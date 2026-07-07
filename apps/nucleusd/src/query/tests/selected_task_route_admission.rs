use nucleus_server::{
    ControlSelectedTaskCommandAdmissionDto, ControlSelectedTaskCommandAdmissionNoEffectsDto,
    ControlSelectedTaskCompletionRouteAdmissionDto,
    ControlSelectedTaskReviewOutcomeRouteNoEffectsDto,
    ControlSelectedTaskReworkDelegationRouteAdmissionDto, ControlSelectedTaskRouteAdmissionDto,
    ControlSelectedTaskRouteAdmissionPreviewDto, ControlSelectedTaskRouteAdmissionRefusalDto,
};

use super::*;

#[test]
fn selected_task_route_admission_response_lines_are_read_only_and_sanitized() {
    let lines = typed_response::selected_task_route_admission_response_lines(
        "selected-task-route-admission",
        ControlSelectedTaskRouteAdmissionDto {
            admission_id: "selected-task-route-admission:task:nucleus-local:bootstrap".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            task_id: "task:nucleus-local:bootstrap".to_owned(),
            route_id: "selected-task-review-outcome-route:task:nucleus-local:bootstrap".to_owned(),
            completion: ControlSelectedTaskCompletionRouteAdmissionDto {
                admission_id:
                    "selected-task-completion-route-admission:task:nucleus-local:bootstrap"
                        .to_owned(),
                project_id: "project:nucleus-local".to_owned(),
                task_id: "task:nucleus-local:bootstrap".to_owned(),
                route_id: "selected-task-review-outcome-route:task:nucleus-local:bootstrap"
                    .to_owned(),
                route_candidate: "ready_for_completion_admission".to_owned(),
                decision_ref: Some("review-decision:1".to_owned()),
                status: "admitted".to_owned(),
                command_admission: Some(ControlSelectedTaskCommandAdmissionDto {
                    admission_id: "selected-task-command-admission:task:nucleus-local:bootstrap"
                        .to_owned(),
                    project_id: "project:nucleus-local".to_owned(),
                    task_id: "task:nucleus-local:bootstrap".to_owned(),
                    family: "complete_selected_task".to_owned(),
                    status: "admitted".to_owned(),
                    command: None,
                    candidate: None,
                    refusal: None,
                    operator_ref: "operator:nucleusd".to_owned(),
                    evidence_refs: vec!["checkpoint:1".to_owned()],
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
                }),
                refusal: None,
                evidence_refs: vec!["checkpoint:1".to_owned()],
                no_effects: no_effects(),
            },
            rework_delegation: ControlSelectedTaskReworkDelegationRouteAdmissionDto {
                admission_id:
                    "selected-task-rework-delegation-route-admission:task:nucleus-local:bootstrap"
                        .to_owned(),
                project_id: "project:nucleus-local".to_owned(),
                task_id: "task:nucleus-local:bootstrap".to_owned(),
                route_id: "selected-task-review-outcome-route:task:nucleus-local:bootstrap"
                    .to_owned(),
                route_candidate: "ready_for_rework_admission".to_owned(),
                decision_ref: Some("review-decision:1".to_owned()),
                status: "refused".to_owned(),
                rework_preview: Some(ControlSelectedTaskRouteAdmissionPreviewDto {
                    family: "prepare_rework".to_owned(),
                    summary: "Prepare rework from reviewed evidence".to_owned(),
                    source_refs: vec!["review-decision:1".to_owned()],
                    evidence_refs: vec!["checkpoint:1".to_owned()],
                }),
                delegation_preview: Some(ControlSelectedTaskRouteAdmissionPreviewDto {
                    family: "delegate_rework".to_owned(),
                    summary: "Delegate rework to an agent work unit".to_owned(),
                    source_refs: vec!["review-decision:1".to_owned()],
                    evidence_refs: vec!["checkpoint:1".to_owned()],
                }),
                refusal: Some(ControlSelectedTaskRouteAdmissionRefusalDto {
                    kind: "unsupported_route".to_owned(),
                    reason: "current route does not request rework or delegation".to_owned(),
                }),
                work_item_refs: vec!["work:1".to_owned()],
                evidence_refs: vec!["checkpoint:1".to_owned()],
                no_effects: no_effects(),
            },
            no_effects: no_effects(),
        },
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=selected-task-route-admission"));
    assert!(rendered.contains("completion_status=admitted"));
    assert!(rendered.contains("rework_delegation_status=refused"));
    assert!(rendered.contains("rework_preview=prepare_rework"));
    assert!(rendered.contains("delegation_preview=delegate_rework"));
    assert!(rendered.contains("provider_execution=false"));
    assert!(rendered.contains("scm_or_forge_mutation=false"));
    assert!(rendered.contains("agent_scheduling_available=false"));
    assert!(rendered.contains("payloads_exposed=false"));
    assert!(!rendered.contains("raw_payload"));
    assert!(!rendered.contains("private:context"));
}

fn no_effects() -> ControlSelectedTaskReviewOutcomeRouteNoEffectsDto {
    ControlSelectedTaskReviewOutcomeRouteNoEffectsDto {
        review_mutation_performed: false,
        task_lifecycle_mutation_performed: false,
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
