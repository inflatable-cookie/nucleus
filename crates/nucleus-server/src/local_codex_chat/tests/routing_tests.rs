//! Request serialization, route selection, and working-context resolution,
//! split from the tests god file; behavior unchanged.

use super::*;

use super::super::routing::{
    resolve_chat_working_context, selected_route, CHAT_ADAPTER_ID, CHAT_MODEL,
    CHAT_PROVIDER_INSTANCE_ID, SelectedAgentChatRoute,
};

#[test]
fn chat_request_serializes_for_tauri_boundary() {
    let request = LocalCodexChatRequest {
        conversation_id: "panel:agent-chat".to_owned(),
        project_id: "project:nucleus".to_owned(),
        resource_id: None,
        message: "hello".to_owned(),
        active_task_id: Some("task:nucleus:one".to_owned()),
        active_goal_id: None,
        provider_instance_id: Some(CHAT_PROVIDER_INSTANCE_ID.to_owned()),
        provider_instance_revision: Some("1".to_owned()),
        protocol_facade_id: Some("codex-app-server-v2".to_owned()),
        provider_id: None,
        model: Some("gpt-5.4-mini".to_owned()),
        reasoning_effort: Some("low".to_owned()),
        harness_mode: LocalCodexChatHarnessMode::Normal,
        idioms_enabled: true,
    };
    let value = serde_json::to_value(request).expect("serialize request");
    assert_eq!(value["conversation_id"], "panel:agent-chat");
    assert_eq!(value["message"], "hello");
    assert_eq!(value["active_task_id"], "task:nucleus:one");
    assert_eq!(value["active_goal_id"], serde_json::Value::Null);
    assert_eq!(value["model"], "gpt-5.4-mini");
    assert_eq!(value["reasoning_effort"], "low");
    assert_eq!(value["harness_mode"], "normal");
}

#[test]
fn chat_route_selection_uses_requested_values_and_rejects_invalid_slugs() {
    let mut request = request("route-selection", "hello");
    request.model = Some("  gpt-5.4-mini  ".to_owned());
    request.reasoning_effort = Some("medium".to_owned());

    assert_eq!(
        selected_route(&request, None, &test_catalogue()).expect("route"),
        SelectedAgentChatRoute {
            runtime_adapter_id: CHAT_ADAPTER_ID.to_owned(),
            provider_instance_id: CHAT_PROVIDER_INSTANCE_ID.to_owned(),
            provider_instance_revision: "1".to_owned(),
            protocol_facade_id: "codex-app-server-v2".to_owned(),
            provider_id: None,
            model: "gpt-5.4-mini".to_owned(),
            reasoning_effort: "medium".to_owned(),
            harness_mode: LocalCodexChatHarnessMode::Normal,
        }
    );

    request.harness_mode = LocalCodexChatHarnessMode::Plan;
    assert_eq!(
        selected_route(&request, None, &test_catalogue())
            .expect("plan route")
            .harness_mode,
        LocalCodexChatHarnessMode::Plan
    );

    request.model = Some("gpt 5.4".to_owned());
    assert_eq!(
        selected_route(&request, None, &test_catalogue()).expect_err("invalid route"),
        "chat model contains unsupported characters"
    );

    request.model = Some(CHAT_MODEL.to_owned());
    request.provider_instance_revision = Some("stale".to_owned());
    assert_eq!(
        selected_route(&request, None, &test_catalogue()).expect_err("stale instance"),
        "selected provider instance revision is stale"
    );

    request.provider_instance_revision = Some("1".to_owned());
    let mut unavailable = test_catalogue();
    unavailable.instances[0].selection_readiness = "not_ready".to_owned();
    assert!(selected_route(&request, None, &unavailable)
        .expect_err("unavailable provider")
        .contains("not ready"));
}

#[test]
fn resource_free_chat_uses_host_home_without_inventing_a_resource() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
    let mut handler = LocalControlRequestHandler::new(backend, None);
    accepted(
        &mut handler,
        ServerControlRequest {
            id: crate::ServerControlRequestId("request:resource-free-chat".to_owned()),
            client_id: crate::ClientId("client:test".to_owned()),
            kind: crate::control_api::ServerControlRequestKind::Command(crate::ServerCommand {
                id: crate::ServerCommandId("command:resource-free-chat".to_owned()),
                client_id: crate::ClientId("client:test".to_owned()),
                kind: crate::ServerCommandKind::Project(crate::commands::ProjectCommand::Create(
                    crate::commands::ProjectCreateCommand {
                        display_name: String::new(),
                        transient: true,
                        actor_ref: "operator:test".to_owned(),
                        authority_host_ref: "host:embedded-desktop".to_owned(),
                        idempotency_key: "resource-free-chat".to_owned(),
                    },
                )),
            }),
        },
    )
    .expect("create transient project");
    let project_id = handler
        .state()
        .projects()
        .list()
        .expect("projects")
        .into_iter()
        .find(|record| record.kind == nucleus_core::PersistenceRecordKind::Project)
        .expect("transient project")
        .id
        .0;

    let (target, root, target_resource_id) =
        resolve_chat_working_context(handler.state(), &project_id, None).expect("chat context");

    assert!(target.is_none());
    assert_eq!(target_resource_id, "resource:none");
    assert_eq!(
        root,
        std::env::var_os("HOME")
            .expect("host home")
            .to_string_lossy()
    );

    // A stored session round-trips the sentinel as its resource id; resolving
    // it again must behave as resource-free, not look up a literal resource.
    let (target_again, _, _) =
        resolve_chat_working_context(handler.state(), &project_id, Some("resource:none"))
            .expect("sentinel resolves as resource-free");
    assert!(target_again.is_none());
}
