use std::sync::{Arc, Mutex};

use longhorn_bridge::{
    AuthorityEpoch, BridgeCommandEnvelope, BridgeHelloRequest, BridgeQueryEnvelope,
    BridgeQueryOutcome, BridgeRequestContext,
};
use longhorn_core::{BridgeId, BridgeRequestId};
use nucleus_server::{
    ControlQueryDto, ControlQueryScopeDto, ControlRequestBodyDto, ControlStateDomainDto,
    LocalControlRequestHandler, CONTROL_API_PROTOCOL_FAMILY, CONTROL_API_PROTOCOL_VERSION_V1,
};
use serde_json::json;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tempfile::TempDir;

use super::*;

#[test]
fn direct_and_serialized_local_paths_preserve_the_nucleus_control_envelope() {
    let direct = fixture_assembly();
    let direct_receipt = direct.hello("main", hello()).unwrap();
    let direct_request =
        query_request(direct_receipt.session_id().clone(), "request:bridge-parity");
    let direct_reply = direct
        .query("main", QUERY_ROUTE, direct_request.clone())
        .unwrap();

    let serialized = serde_json::to_vec(&direct_request).unwrap();
    let loopback_request = serde_json::from_slice(&serialized).unwrap();
    let loopback = fixture_assembly();
    loopback.hello("main", hello()).unwrap();
    let loopback_reply = loopback
        .query("main", QUERY_ROUTE, loopback_request)
        .unwrap();

    assert_eq!(direct_reply, loopback_reply);
    let BridgeQueryOutcome::Success(response) = direct_reply.outcome() else {
        panic!("runtime metadata query should succeed")
    };
    let response: ControlResponseEnvelopeDto = serde_json::from_value(response.clone()).unwrap();
    assert_eq!(response.request_id, "request:bridge-parity");
    assert_eq!(response.status, ControlResponseStatusDto::Complete);
}

#[test]
fn registered_tauri_commands_preserve_direct_local_bridge_semantics() {
    let direct = fixture_assembly();
    let direct_receipt = direct.hello("main", hello()).unwrap();
    let direct_reply = direct
        .query(
            "main",
            QUERY_ROUTE,
            query_request(direct_receipt.session_id().clone(), "request:tauri-parity"),
        )
        .unwrap();

    let app = tauri::test::mock_builder()
        .manage(TauriBridgeState::new(Arc::new(fixture_assembly())))
        .invoke_handler(tauri::generate_handler![
            longhorn_tauri_bridge::longhorn_bridge_hello,
            longhorn_tauri_bridge::longhorn_bridge_query
        ])
        .build(crate::desktop_context())
        .unwrap();
    let webview = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
        .build()
        .unwrap();

    let receipt = tauri::test::get_ipc_response(
        &webview,
        tauri::webview::InvokeRequest {
            cmd: "longhorn_bridge_hello".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(json!({ "request": hello() })),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .unwrap()
    .deserialize::<BridgeNegotiationReceipt>()
    .unwrap();
    let reply = tauri::test::get_ipc_response(
        &webview,
        tauri::webview::InvokeRequest {
            cmd: "longhorn_bridge_query".into(),
            callback: tauri::ipc::CallbackFn(2),
            error: tauri::ipc::CallbackFn(3),
            url: "tauri://localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(json!({
                "route": QUERY_ROUTE,
                "request": query_request(receipt.session_id().clone(), "request:tauri-parity")
            })),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .unwrap()
    .deserialize::<BridgeQueryReply<serde_json::Value, serde_json::Value>>()
    .unwrap();

    assert_eq!(receipt, direct_receipt);
    assert_eq!(reply, direct_reply);
    assert!(app.try_state::<TauriBridgeState>().is_some());
}

#[test]
fn capability_does_not_grant_write_and_stale_sessions_fail_closed() {
    let assembly = fixture_assembly();
    let first = assembly.hello("main", hello()).unwrap();
    let second = assembly.hello("main", hello()).unwrap();
    assert_ne!(first.session_id(), second.session_id());

    let stale = query_request(first.session_id().clone(), "request:stale-session");
    assert_eq!(
        assembly.query("main", QUERY_ROUTE, stale).unwrap_err().code,
        BridgeHostErrorCode::InvalidSession,
    );

    let query_payload = control_query("request:wrong-route");
    let command = BridgeCommandEnvelope::new(
        context(second.session_id().clone(), "request:wrong-route"),
        AuthorityEpoch::new(1).unwrap(),
        None,
        None,
        query_payload,
    );
    let command: BridgeCommandEnvelope<serde_json::Value> =
        serde_json::from_value(serde_json::to_value(command).unwrap()).unwrap();
    assert_eq!(
        assembly
            .command("main", COMMAND_ROUTE, command)
            .unwrap_err()
            .code,
        BridgeHostErrorCode::PayloadCodec,
    );
}

#[test]
fn bridge_level_retry_and_revision_evidence_are_rejected_before_dispatch() {
    let assembly = fixture_assembly();
    let receipt = assembly.hello("main", hello()).unwrap();
    let payload = ControlRequestEnvelopeDto {
        protocol_family: CONTROL_API_PROTOCOL_FAMILY.into(),
        protocol_version: CONTROL_API_PROTOCOL_VERSION_V1,
        request_id: "request:unmapped-replay".into(),
        client_id: "desktop-client".into(),
        body: ControlRequestBodyDto::Command {
            command: nucleus_server::ControlCommandDto::ProjectCreate {
                command_id: "command:unmapped-replay".into(),
                display_name: "Unreachable".into(),
                transient: None,
                actor_ref: "operator:test".into(),
                authority_host_ref: "host:local".into(),
                idempotency_key: "idempotency:domain-owned".into(),
            },
        },
    };
    let command = BridgeCommandEnvelope::new(
        context(receipt.session_id().clone(), "request:unmapped-replay"),
        AuthorityEpoch::new(1).unwrap(),
        None,
        Some(longhorn_core::BridgeIdempotencyKey::new("idempotency:bridge-owned").unwrap()),
        payload,
    );
    let command: BridgeCommandEnvelope<serde_json::Value> =
        serde_json::from_value(serde_json::to_value(command).unwrap()).unwrap();
    assert_eq!(
        assembly
            .command("main", COMMAND_ROUTE, command)
            .unwrap_err()
            .code,
        BridgeHostErrorCode::InvalidAuthority,
    );
}

fn fixture_assembly() -> BridgeHandlerAssembly<NucleusBridgeAuthority> {
    let temporary = TempDir::new().unwrap();
    let path = temporary.keep().join("nucleus.sqlite");
    let handler = LocalControlRequestHandler::new(SqliteBackend::new(path), None);
    let adapter = Arc::new(Mutex::new(TauriIpcControlCommandAdapter::fixture_backed(
        handler,
    )));
    build_assembly(adapter).unwrap()
}

fn hello() -> BridgeHelloRequest {
    BridgeHelloRequest::new(
        BridgeId::new("bridge:nucleus-test").unwrap(),
        vec![domain_id()],
    )
    .unwrap()
}

fn query_request(
    session_id: BridgeSessionId,
    request_id: &str,
) -> BridgeQueryEnvelope<serde_json::Value> {
    BridgeQueryEnvelope::new(
        context(session_id, request_id),
        serde_json::to_value(control_query(request_id)).unwrap(),
    )
}

fn context(session_id: BridgeSessionId, request_id: &str) -> BridgeRequestContext {
    BridgeRequestContext::new(
        BridgeRequestId::new(request_id).unwrap(),
        session_id,
        domain_id(),
    )
}

fn control_query(request_id: &str) -> ControlRequestEnvelopeDto {
    ControlRequestEnvelopeDto {
        protocol_family: CONTROL_API_PROTOCOL_FAMILY.into(),
        protocol_version: CONTROL_API_PROTOCOL_VERSION_V1,
        request_id: request_id.into(),
        client_id: "desktop-client".into(),
        body: ControlRequestBodyDto::Query {
            query: ControlQueryDto::State {
                query_id: format!("query:{request_id}"),
                domain: ControlStateDomainDto::Projects,
                scope: ControlQueryScopeDto::List,
            },
        },
    }
}
