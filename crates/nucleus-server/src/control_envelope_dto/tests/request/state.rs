use super::*;

#[test]
fn request_envelope_dto_serializes_supported_state_query() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:1".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:1".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Project(StateRecordQuery {
                domain: ServerStateDomain::Projects,
                scope: StateRecordQueryScope::List,
            }),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let restored = ServerControlRequest::try_from(decoded).expect("restored request");

    assert_eq!(dto.protocol_family, CONTROL_API_PROTOCOL_FAMILY);
    assert_eq!(dto.protocol_version, CONTROL_API_PROTOCOL_VERSION_V1);
    assert_eq!(restored.id, request.id);
    assert!(matches!(
        restored.kind,
        ServerControlRequestKind::Query(ServerQuery {
            kind: ServerQueryKind::Project(StateRecordQuery {
                scope: StateRecordQueryScope::List,
                ..
            }),
            ..
        })
    ));
}
