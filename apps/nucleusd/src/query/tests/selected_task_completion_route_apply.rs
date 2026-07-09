use nucleus_server::{
    ControlSelectedTaskCommandAdmissionCommandDto, ControlSelectedTaskCompletionRouteApplyDto,
    ControlSelectedTaskCompletionRouteApplyRefusalDto,
    ControlSelectedTaskReviewOutcomeRouteNoEffectsDto,
};

use super::*;

#[test]
fn selected_task_completion_route_apply_response_lines_are_read_only_and_sanitized() {
    let lines = typed_response::selected_task_completion_route_apply_response_lines(
        "selected-task-completion-route-apply",
        ControlSelectedTaskCompletionRouteApplyDto {
            apply_id: "selected-task-completion-route-apply:task:nucleus-local:bootstrap"
                .to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            task_id: "task:nucleus-local:bootstrap".to_owned(),
            route_admission_id: "selected-task-route-admission:task:nucleus-local:bootstrap"
                .to_owned(),
            route_id: "selected-task-review-outcome-route:task:nucleus-local:bootstrap".to_owned(),
            review_decision_ref: Some("selected-task-review-decision:1".to_owned()),
            status: "refused".to_owned(),
            command: Some(ControlSelectedTaskCommandAdmissionCommandDto {
                action: "complete".to_owned(),
                task_id: "task:nucleus-local:bootstrap".to_owned(),
                expected_revision: Some("rev:nucleus-local:bootstrap".to_owned()),
                reason: None,
            }),
            command_admission: None,
            refusal: Some(ControlSelectedTaskCompletionRouteApplyRefusalDto {
                kind: "route_admission_refused".to_owned(),
                reason: "route refused".to_owned(),
            }),
            evidence_refs: vec!["checkpoint:1".to_owned()],
            operator_ref: "operator:nucleusd".to_owned(),
            no_effects: no_effects(),
        },
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=selected-task-completion-route-apply"));
    assert!(rendered.contains("status=refused"));
    assert!(rendered.contains("command=complete"));
    assert!(rendered.contains("refusal=route_admission_refused"));
    assert!(rendered.contains("mode=read_only_preview"));
    assert!(rendered.contains("command_execution_available=false"));
    assert!(rendered.contains("provider_execution=false"));
    assert!(rendered.contains("scm_or_forge_mutation=false"));
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
