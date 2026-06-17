use super::*;

#[test]
fn handler_returns_deferred_authority_map_without_fabricating_assignments() {
    let (_temp_dir, mut handler) = handler(None);
    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:authority-map".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:authority-map".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::ProjectAuthorityMap(ProjectAuthorityMapQuery {
                project_id: nucleus_projects::ProjectId("project:nucleus".to_owned()),
                expected_domains: vec![
                    ProjectAuthorityDomain::Project,
                    ProjectAuthorityDomain::Task,
                    ProjectAuthorityDomain::Execution,
                ],
            }),
        }),
    });

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::ProjectAuthorityMap(record))
            if record.project_id == nucleus_projects::ProjectId("project:nucleus".to_owned())
                && record.domains.is_empty()
                && !record.issues.is_empty()
    ));
}
