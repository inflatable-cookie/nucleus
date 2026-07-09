use crate::{
    ControlResponseBodyDto, ControlResponseEnvelopeDto, SelectedTaskProductAggregate,
    SelectedTaskProductAggregateInput, ServerControlResponse, ServerControlResponseBody,
    ServerControlResponseStatus, ServerQueryResult,
};
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

#[test]
fn response_envelope_dto_serializes_selected_task_product_aggregate_without_effects() {
    let response = ServerControlResponse {
        request_id: crate::ids::ServerControlRequestId(
            "request:selected-task-product-aggregate".to_owned(),
        ),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::SelectedTaskProductAggregate(
            missing_sources_aggregate(),
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let ControlResponseBodyDto::SelectedTaskProductAggregate { aggregate } = &dto.body else {
        panic!("expected selected task product aggregate body");
    };
    let json = serde_json::to_string(&dto).expect("serialize dto");

    assert_eq!(aggregate.project_id, "project:1");
    assert_eq!(aggregate.task_id, "task:1");
    assert_eq!(aggregate.workflow.phase, "source_gap");
    assert_eq!(aggregate.source_health.missing_count, 10);
    assert_eq!(aggregate.gaps.len(), 10);
    assert!(!aggregate.no_effects.task_mutation_performed);
    assert!(!aggregate.no_effects.provider_execution_performed);
    assert!(!aggregate.no_effects.scm_or_forge_mutation_performed);
    assert!(json.contains("\"type\":\"selected_task_product_aggregate\""));
    assert!(json.contains("\"source\":\"drilldown\""));
    assert!(!json.contains("raw_payload"));
}

fn missing_sources_aggregate() -> SelectedTaskProductAggregate {
    crate::selected_task_product_aggregate(SelectedTaskProductAggregateInput {
        project_id: ProjectId("project:1".to_owned()),
        task_id: TaskId("task:1".to_owned()),
        expected_revision: None,
        drilldown: None,
        action_readiness: None,
        operator_gate: None,
        command_admissions: Vec::new(),
        review_next: None,
        review_outcome_route: None,
        route_admission: None,
        completion_apply: None,
        rework_preparation: None,
        scm_handoff: None,
    })
}
