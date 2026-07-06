use super::*;

#[test]
fn handler_routes_product_workflow_summary_without_mutation() {
    let (_temp_dir, mut handler) = handler(None);
    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:product-workflow".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:product-workflow".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::ProductWorkflowSummary(
                crate::control_api::ProductWorkflowSummaryQuery {
                    project_id: ProjectId("project:nucleus-local".to_owned()),
                },
            ),
        }),
    });

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::ProductWorkflowSummary(summary))
            if summary.project_id.0 == "project:nucleus-local"
                && summary.gaps.len() == 7
                && !summary.no_effects.task_mutation_performed
                && !summary.no_effects.provider_execution_performed
                && !summary.no_effects.scm_or_forge_mutation_performed
                && !summary.no_effects.ui_effect_performed
    ));
}
