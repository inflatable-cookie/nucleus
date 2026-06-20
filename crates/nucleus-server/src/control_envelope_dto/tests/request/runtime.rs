use super::*;

#[test]
fn request_envelope_rejects_unsupported_version() {
    let dto = ControlRequestEnvelopeDto {
        protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
        protocol_version: 2,
        request_id: "request:dto:bad-version".to_owned(),
        client_id: "client:desktop".to_owned(),
        body: ControlRequestBodyDto::Query {
            query: ControlQueryDto::RuntimeMetadata {
                query_id: "query:dto".to_owned(),
                action: "list_artifact_metadata".to_owned(),
            },
        },
    };

    let error = ServerControlRequest::try_from(dto).expect_err("bad version");

    assert_eq!(
        error.failure,
        ControlApiCodecFailure::UnsupportedProtocolVersion
    );
}

#[test]
fn request_envelope_dto_serializes_runtime_readiness_query() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:runtime-readiness".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:runtime-readiness".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::RuntimeMetadata(
                crate::RuntimeMetadataQuery::GetLocalRuntimeReadiness,
            ),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let restored = ServerControlRequest::try_from(decoded).expect("restored request");

    assert!(matches!(
        restored.kind,
        ServerControlRequestKind::Query(ServerQuery {
            kind: ServerQueryKind::RuntimeMetadata(
                crate::RuntimeMetadataQuery::GetLocalRuntimeReadiness
            ),
            ..
        })
    ));
}

#[test]
fn request_envelope_dto_serializes_task_work_progress_query() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:task-work-progress".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:task-work-progress".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::RuntimeMetadata(
                crate::RuntimeMetadataQuery::ListTaskWorkProgress,
            ),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let restored = ServerControlRequest::try_from(decoded).expect("restored request");

    assert!(json.contains("list_task_work_progress"));
    assert!(matches!(
        restored.kind,
        ServerControlRequestKind::Query(ServerQuery {
            kind: ServerQueryKind::RuntimeMetadata(
                crate::RuntimeMetadataQuery::ListTaskWorkProgress
            ),
            ..
        })
    ));
}
