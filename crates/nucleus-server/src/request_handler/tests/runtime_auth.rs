use super::*;

#[test]
fn handler_rejects_runtime_session_start_until_scheduler_refs_exist() {
    let (_temp_dir, mut handler) = handler(None);
    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:start-session".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId("command:start-session".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::AgentSession(AgentSessionCommand::StartSession {
                adapter_id: "adapter:codex".to_owned(),
                project_id: nucleus_projects::ProjectId("project:1".to_owned()),
            }),
        }),
    });

    assert_eq!(response.status, ServerControlResponseStatus::Rejected);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Command(ServerCommandReceipt {
            status: ServerCommandReceiptStatus::Rejected(
                ServerControlError::RuntimeUnavailable { .. }
            ),
            ..
        })
    ));
    assert!(handler.scheduler().queued_items().is_empty());
}

#[test]
fn skeleton_denies_requests_when_auth_readiness_is_denied() {
    let auth_readiness = ClientAuthReadiness {
        client: ClientIdentity {
            id: ClientId("client:mobile".to_owned()),
            kind: ClientKind::Mobile,
            display_name: "mobile".to_owned(),
        },
        observed_posture: ClientAuthPosture::UnpairedLocal,
        status: ClientAuthReadinessStatus::Denied,
        blockers: vec![ClientAuthReadinessBlocker::UnsupportedClientKind {
            kind: ClientKind::Mobile,
        }],
    };
    let (_temp_dir, mut handler) = handler(Some(auth_readiness));
    let response = handler.handle(query_request());

    assert_eq!(response.status, ServerControlResponseStatus::Rejected);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Error(ServerControlError::Unauthorized { .. })
    ));
}

#[test]
fn handler_executes_adapter_session_and_runtime_metadata_queries() {
    let (_temp_dir, mut handler) = handler(None);
    let adapter_record = fixture_record(
        PersistenceDomain::AdapterRegistry,
        PersistenceRecordKind::AdapterInstance,
        "adapter:codex",
        "rev:1",
    );
    let evidence_record = fixture_record(
        PersistenceDomain::CommandEvidence,
        PersistenceRecordKind::CommandEvidence,
        "evidence:1",
        "rev:1",
    );
    handler
        .state()
        .adapter_registry()
        .put(adapter_record.clone(), RevisionExpectation::MustNotExist)
        .expect("seed adapter");
    handler
        .state()
        .command_evidence()
        .put(evidence_record.clone(), RevisionExpectation::MustNotExist)
        .expect("seed evidence");

    let adapter_response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:adapters".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:adapters".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::AdapterSession(AdapterSessionQuery::ListAdapters),
        }),
    });
    let evidence_response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:evidence".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:evidence".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::RuntimeMetadata(RuntimeMetadataQuery::ListCommandEvidence),
        }),
    });

    assert!(matches!(
        adapter_response.body,
        ServerControlResponseBody::Query(ServerQueryResult::AdapterSessions(
            ServerStateRecordSet { records, .. }
        )) if records == vec![adapter_record]
    ));
    assert!(matches!(
        evidence_response.body,
        ServerControlResponseBody::Query(ServerQueryResult::RuntimeMetadata(
            ServerStateRecordSet { records, .. }
        )) if records == vec![evidence_record]
    ));
}

#[test]
fn handler_reports_unsupported_indexed_filters_without_transport_errors() {
    let (_temp_dir, mut handler) = handler(None);
    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:project-index".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:sessions-for-project".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::AdapterSession(AdapterSessionQuery::ListSessionsForProject(
                nucleus_projects::ProjectId("project:1".to_owned()),
            )),
        }),
    });

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Unsupported { .. })
    ));
}
