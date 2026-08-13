//! Shared fixtures for local_codex_chat tests, split from the tests god
//! file; behavior unchanged.

use super::persistence::{persist_turn_completion, persist_turn_start, read_history, StoredChatSession};
use super::routing::{
    CHAT_ADAPTER_ID, CHAT_MODEL, CHAT_PROVIDER_INSTANCE_ID, CHAT_REASONING_EFFORT,
};
use super::*;
use crate::{
    LocalControlRequestHandler, ServerControlRequest, ServerControlResponseStatus,
};
use crate::commands::{ProjectCommand, ProjectCreateCommand};
use nucleus_core::{PersistenceRecordId, RevisionId};
use nucleus_local_store::{LocalStoreRecordPayload, RevisionExpectation, SqliteBackend};
use nucleus_projects::{
    decode_project_storage_record, encode_project_storage_payload,
    ProjectResourceStorageLocationStatus,
};

mod context_tests;
mod live_smoke_tests;
mod live_tool_tests;
mod plan_tests;
mod routing_tests;

fn request(conversation: &str, message: &str) -> LocalCodexChatRequest {
    LocalCodexChatRequest {
        conversation_id: format!("project:nucleus-local:panel:{conversation}"),
        project_id: "project:nucleus-local".to_owned(),
        resource_id: None,
        message: message.to_owned(),
        active_task_id: None,
        active_goal_id: None,
        provider_instance_id: Some(CHAT_PROVIDER_INSTANCE_ID.to_owned()),
        provider_instance_revision: Some("1".to_owned()),
        protocol_facade_id: Some("codex-app-server-v2".to_owned()),
        provider_id: None,
        model: None,
        reasoning_effort: None,
        harness_mode: LocalCodexChatHarnessMode::Normal,
        idioms_enabled: true,
    }
}

fn test_catalogue() -> AgentChatProviderCatalogue {
    AgentChatProviderCatalogue {
        instances: vec![AgentChatProviderInstance {
            provider_instance_id: CHAT_PROVIDER_INSTANCE_ID.to_owned(),
            instance_revision: "1".to_owned(),
            runtime_adapter_id: CHAT_ADAPTER_ID.to_owned(),
            driver_id: "swallowtail.codex.app-server".to_owned(),
            integration_family: "codex".to_owned(),
            transport_family: "stdio-json-rpc".to_owned(),
            protocol_facade_id: "codex-app-server-v2".to_owned(),
            display_name: "Local Codex".to_owned(),
            harness_name: "Codex app-server".to_owned(),
            ownership: "host_owned_persistent".to_owned(),
            selection_readiness: "ready".to_owned(),
            credential_posture: AgentChatCredentialPosture {
                profile_id: "codex-login".to_owned(),
                mechanism: "interactive_oauth".to_owned(),
                credential_state: "ready".to_owned(),
                entitlement_metering: "subscription_allowance".to_owned(),
                entitlement_state: "available".to_owned(),
                endpoint_authorization: "allowed".to_owned(),
                runtime_readiness: "ready".to_owned(),
                support_authority: "provider_supported".to_owned(),
                evidence_provenance: "observed".to_owned(),
            },
            credential: None,
            model_catalogue_state: "available".to_owned(),
            model_catalogue_diagnostic: None,
            models: vec![LocalCodexChatModelOption {
                provider_id: None,
                model: CHAT_MODEL.to_owned(),
                display_name: "GPT-5.4 Mini".to_owned(),
                description: String::new(),
                default_reasoning_effort: CHAT_REASONING_EFFORT.to_owned(),
                supported_reasoning_efforts: vec![
                    LocalCodexChatReasoningOption {
                        reasoning_effort: "low".to_owned(),
                        description: String::new(),
                    },
                    LocalCodexChatReasoningOption {
                        reasoning_effort: "medium".to_owned(),
                        description: String::new(),
                    },
                ],
            }],
            tool_capable: true,
            tool_capable_reason: None,
        }],
    }
}

fn accepted(
    handler: &mut LocalControlRequestHandler<SqliteBackend>,
    request: ServerControlRequest,
) -> Result<(), String> {
    let response = handler.handle(request);
    if response.status == ServerControlResponseStatus::Accepted {
        Ok(())
    } else {
        Err(format!("task command rejected: {:?}", response.body))
    }
}

fn persist_legacy_session(
    state: &ServerStateService<SqliteBackend>,
    conversation: &str,
    toolset_version: u32,
) {
    let conversation_id = format!("project:nucleus-local:panel:{conversation}");
    let turn_id = format!("turn:{conversation}");
    persist_turn_start(
        state,
        StoredChatSession {
            conversation_id,
            project_id: "project:nucleus-local".to_owned(),
            resource_id: None,
            session_id: format!("session:{conversation}"),
            provider_thread_id: format!("thread:{conversation}"),
            model: CHAT_MODEL.to_owned(),
            reasoning_effort: Some(CHAT_REASONING_EFFORT.to_owned()),
            harness_mode: LocalCodexChatHarnessMode::Normal,
            adapter_id: CHAT_ADAPTER_ID.to_owned(),
            provider_instance_id: CHAT_PROVIDER_INSTANCE_ID.to_owned(),
            provider_instance_revision: "1".to_owned(),
            protocol_facade_id: "codex-app-server-v2".to_owned(),
            provider_id: None,
            turn_count: 1,
            task_toolset_version: toolset_version,
        },
        &turn_id,
        "What can this app do?",
        None,
    )
    .expect("persist legacy chat start");
    persist_turn_completion(
        state,
        &turn_id,
        &format!("provider-turn:{conversation}"),
        Some("It can manage projects and conversations."),
        &[],
        &[],
    )
    .expect("persist legacy chat completion");
}

/// Create a transient quick-chat project in a fresh sqlite file and return
/// the state service plus the created project id. Transient chats are
/// resource-free: they resolve to the host home read-only context (card 090
/// sentinel behavior), so the accept follow-up exercises that path live.
fn transient_chat_project(
    path: &std::path::Path,
    suffix: &str,
) -> (ServerStateService<SqliteBackend>, String) {
    let backend = SqliteBackend::new(path.to_path_buf());
    let state = ServerStateService::new(backend.clone());
    let mut handler = LocalControlRequestHandler::new(backend, None);
    accepted(
        &mut handler,
        ServerControlRequest {
            id: crate::ServerControlRequestId(format!("request:create-{suffix}")),
            client_id: crate::ClientId("client:test".to_owned()),
            kind: crate::control_api::ServerControlRequestKind::Command(crate::ServerCommand {
                id: crate::ServerCommandId(format!("command:create-{suffix}")),
                client_id: crate::ClientId("client:test".to_owned()),
                kind: crate::ServerCommandKind::Project(ProjectCommand::Create(
                    ProjectCreateCommand {
                        display_name: String::new(),
                        transient: true,
                        actor_ref: "operator:test".to_owned(),
                        authority_host_ref: "host:embedded-desktop".to_owned(),
                        idempotency_key: format!("create-{suffix}"),
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
    drop(handler);
    (state, project_id)
}

/// Send one Plan-mode chat turn and expect success.
fn plan_send(
    service: &mut LocalCodexChatService,
    state: &ServerStateService<SqliteBackend>,
    project_id: &str,
    conversation_id: &str,
    message: &str,
) -> LocalCodexChatReply {
    service
        .send_message(
            state,
            LocalCodexChatRequest {
                conversation_id: conversation_id.to_owned(),
                project_id: project_id.to_owned(),
                resource_id: None,
                message: message.to_owned(),
                active_task_id: None,
                active_goal_id: None,
                provider_instance_id: Some(CHAT_PROVIDER_INSTANCE_ID.to_owned()),
                provider_instance_revision: Some("1".to_owned()),
                protocol_facade_id: Some("codex-app-server-v2".to_owned()),
                provider_id: None,
                model: None,
                reasoning_effort: None,
                harness_mode: LocalCodexChatHarnessMode::Plan,
                idioms_enabled: true,
            },
        )
        .expect("plan mode turn")
}

/// The pending plan a Plan-mode turn produced, retrying once with a more
/// explicit prompt if the provider emitted no typed plan on the first turn.
/// Panics with the turn evidence when no plan appears after the retry (card
/// stop condition: provider does not emit a typed plan).
fn pending_plan_or_retry(
    service: &mut LocalCodexChatService,
    state: &ServerStateService<SqliteBackend>,
    project_id: &str,
    conversation_id: &str,
    first_reply: &LocalCodexChatReply,
) -> StoredChatPlanDecision {
    let history = read_history(state, project_id, conversation_id)
        .expect("history");
    if let Some(decision) = history
        .plan_decisions
        .into_iter()
        .find(|decision| decision.status == "pending")
    {
        return decision;
    }
    let retry = plan_send(
        service,
        state,
        project_id,
        conversation_id,
        "You are in plan mode. Produce a detailed plan for making a cup of tea \
         and present your final plan as the proposed plan the operator \
         reviews. Do not execute anything.",
    );
    let history = read_history(state, project_id, conversation_id)
        .expect("history after retry");
    let decisions = history.plan_decisions.clone();
    decisions
        .iter()
        .find(|decision| decision.status == "pending")
        .cloned()
        .unwrap_or_else(|| {
            panic!(
                "provider emitted no typed plan after one retry. first turn reply: {first_reply:?}; retry reply: {retry:?}; plan decisions: {decisions:?}"
            )
        })
}

fn redirect_project_root(state: &ServerStateService<SqliteBackend>, root: &std::path::Path) {
    let id = PersistenceRecordId("project:nucleus-local".to_owned());
    let mut record = state
        .projects()
        .get(&id)
        .expect("project lookup")
        .expect("project");
    let previous = record.revision_id.clone();
    let mut project = decode_project_storage_record(&record.payload.bytes).expect("decode");
    let resource = project.resources.first_mut().expect("seed resource");
    resource.current_locator = Some(root.to_string_lossy().into_owned());
    resource.location_status = ProjectResourceStorageLocationStatus::Present;
    record.revision_id = RevisionId("rev:project:workflow-live-smoke".to_owned());
    record.payload = LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes: encode_project_storage_payload(&project).expect("encode"),
    };
    state
        .projects()
        .put(record, RevisionExpectation::Exact(previous))
        .expect("redirect project");
}
