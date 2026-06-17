use nucleus_native_harness::{
    NativePersonaId, NativeStewardCommandId, NativeStewardCommandKind, NativeStewardCommandRequest,
    NativeStewardCommandScope, NativeStewardCommandTarget,
};

use super::*;

fn steward_command(scope: NativeStewardCommandScope) -> NativeStewardCommandRequest {
    NativeStewardCommandRequest {
        id: NativeStewardCommandId("steward-command:request-handler".to_owned()),
        persona_id: NativePersonaId("persona:steward".to_owned()),
        kind: NativeStewardCommandKind::ReadOnlyInspection,
        scope,
        target: NativeStewardCommandTarget::Project {
            project_ref: "project:nucleus".to_owned(),
        },
        tool_action_id: None,
        evidence_refs: Vec::new(),
        summary: Some("request handler steward command".to_owned()),
    }
}

#[test]
fn request_handler_accepts_read_only_steward_command_without_execution() {
    let (_temp_dir, mut handler) = handler(None);
    let command_id = ServerCommandId("command:steward:readonly".to_owned());

    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:steward:readonly".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: command_id.clone(),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::Steward(steward_command(NativeStewardCommandScope::ReadOnly)),
        }),
    });

    assert_eq!(response.status, ServerControlResponseStatus::Accepted);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Command(ServerCommandReceipt {
            command_id: id,
            status: ServerCommandReceiptStatus::AcceptedForNativeStewardCommand,
        }) if id == command_id
    ));
}

#[test]
fn request_handler_rejects_unsupported_steward_command() {
    let (_temp_dir, mut handler) = handler(None);

    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:steward:unsupported".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId("command:steward:unsupported".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::Steward(steward_command(
                NativeStewardCommandScope::Unsupported,
            )),
        }),
    });

    assert_eq!(response.status, ServerControlResponseStatus::Rejected);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Command(ServerCommandReceipt {
            status: ServerCommandReceiptStatus::Rejected(ServerControlError::InvalidRequest { .. }),
            ..
        })
    ));
}
