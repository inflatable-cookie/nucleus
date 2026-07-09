use nucleus_projects::ProjectId;
use nucleus_server::{
    selected_task_product_aggregate, ControlResponseBodyDto, ControlResponseEnvelopeDto,
    SelectedTaskProductAggregateInput, ServerControlResponse, ServerControlResponseBody,
    ServerControlResponseStatus, ServerQueryResult,
};
use nucleus_tasks::TaskId;

use super::*;

#[test]
fn selected_task_product_aggregate_response_lines_are_product_shaped_and_read_only() {
    let response = ServerControlResponse {
        request_id: nucleus_server::ServerControlRequestId(
            "request:selected-task-product-aggregate".to_owned(),
        ),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::SelectedTaskProductAggregate(
            selected_task_product_aggregate(SelectedTaskProductAggregateInput {
                project_id: ProjectId("project:nucleus-local".to_owned()),
                task_id: TaskId("task:nucleus-local:bootstrap".to_owned()),
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
            }),
        )),
    };
    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let ControlResponseBodyDto::SelectedTaskProductAggregate { aggregate } = dto.body else {
        panic!("expected selected task product aggregate response");
    };

    let lines = typed_response::selected_task_product_aggregate_response_lines(
        "selected-task-product-aggregate",
        aggregate,
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=selected-task-product-aggregate"));
    assert!(rendered.contains("next phase=source_gap"));
    assert!(rendered.contains("source_health sources=10 missing=10 partial=0 gaps=10"));
    assert!(rendered.contains("mode=read_only_product_aggregate"));
    assert!(rendered.contains("client_can_mutate=false"));
    assert!(rendered.contains("provider_execution_available=false"));
    assert!(rendered.contains("proof_payload_dump=false"));
    assert!(rendered.contains("payloads_exposed=false"));
    assert!(!rendered.contains("raw_payload"));
    assert!(!rendered.contains("private:context"));
}
