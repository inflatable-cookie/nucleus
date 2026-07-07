use nucleus_server::{
    ControlSelectedTaskReviewOutcomeRouteDto, ControlSelectedTaskReviewOutcomeRouteNoEffectsDto,
    ControlSelectedTaskReviewOutcomeRouteSourceCountsDto,
};

use super::*;

#[test]
fn selected_task_review_outcome_route_response_lines_are_read_only_and_sanitized() {
    let lines = typed_response::selected_task_review_outcome_route_response_lines(
        "selected-task-review-outcome-route",
        ControlSelectedTaskReviewOutcomeRouteDto {
            route_id: "selected-task-review-outcome-route:task:nucleus-local:bootstrap".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            task_id: "task:nucleus-local:bootstrap".to_owned(),
            status: "ready".to_owned(),
            primary_route: "ready_for_completion_admission".to_owned(),
            candidates: vec!["ready_for_completion_admission".to_owned()],
            decision_ref: Some(
                "selected-task-review-decision:task:nucleus-local:bootstrap:accept".to_owned(),
            ),
            decision_outcome: Some("accepted".to_owned()),
            work_item_refs: vec!["work:1".to_owned()],
            evidence_refs: vec!["checkpoint:1".to_owned()],
            downstream_command_hints: vec!["complete_selected_task".to_owned()],
            blockers: vec!["downstream_command_not_defined".to_owned()],
            source_counts: ControlSelectedTaskReviewOutcomeRouteSourceCountsDto {
                decision_records: 1,
                work_item_refs: 1,
                evidence_refs: 1,
                review_gap_count: 0,
                scm_handoff_refs: 0,
                downstream_command_hints: 1,
                blockers: 1,
            },
            no_effects: ControlSelectedTaskReviewOutcomeRouteNoEffectsDto {
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
            },
        },
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=selected-task-review-outcome-route"));
    assert!(rendered.contains("status=ready"));
    assert!(rendered.contains("primary_route=ready_for_completion_admission"));
    assert!(rendered.contains("decision_outcome=accepted"));
    assert!(rendered.contains("task_lifecycle_mutation=false"));
    assert!(rendered.contains("provider_execution=false"));
    assert!(rendered.contains("scm_or_forge_mutation=false"));
    assert!(rendered.contains("client_can_mutate=false"));
    assert!(rendered.contains("payloads_exposed=false"));
    assert!(!rendered.contains("raw_payload"));
    assert!(!rendered.contains("private:context"));
}
