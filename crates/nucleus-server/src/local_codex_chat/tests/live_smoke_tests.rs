//! Live smoke tests against a locally authenticated Codex app-server:
//! catalogue, session threading, route changes, and restart durability.
//! Split from the tests god file; behavior unchanged.

use super::*;

use super::super::runtime::LocalCodexChatSession;
use super::super::task_authoring::TaskToolOutcome;
use super::super::routing::{
    CHAT_ADAPTER_ID, CHAT_MODEL, CHAT_PROVIDER_INSTANCE_ID, CHAT_REASONING_EFFORT,
    CHAT_TURN_TIMEOUT, SelectedAgentChatRoute,
};
use crate::{seed_local_project, seed_local_task, LocalProjectSeed, LocalTaskSeed};
use nucleus_agent_protocol::AgentTurnCancellation;

#[test]
#[ignore = "requires a locally authenticated Codex app-server"]
fn live_chat_model_catalog_exposes_reasoning_options() {
    let catalogue = LocalCodexChatService::provider_catalogue().expect("provider catalogue");
    let models = &catalogue.instances[0].models;

    assert!(!models.is_empty());
    assert!(models
        .iter()
        .all(|model| !model.model.is_empty() && !model.supported_reasoning_efforts.is_empty()));
}

#[test]
#[ignore = "requires a locally authenticated Codex app-server"]
fn live_chat_keeps_follow_up_turns_on_one_thread() {
    let cwd = std::env::current_dir().expect("current dir");
    let mut session = LocalCodexChatSession::start(
        "live-smoke",
        cwd.to_str().expect("UTF-8 current dir"),
        "resource:live-smoke",
        None,
        None,
        &SelectedAgentChatRoute {
            runtime_adapter_id: CHAT_ADAPTER_ID.to_owned(),
            provider_instance_id: CHAT_PROVIDER_INSTANCE_ID.to_owned(),
            provider_instance_revision: "1".to_owned(),
            protocol_facade_id: "codex-app-server-v2".to_owned(),
            provider_id: None,
            model: CHAT_MODEL.to_owned(),
            reasoning_effort: CHAT_REASONING_EFFORT.to_owned(),
            harness_mode: LocalCodexChatHarnessMode::Normal,
        },
        CHAT_TURN_TIMEOUT,
        true,
    )
    .expect("start chat session");
    let mut task_tool = |_: &str, _: &str, _: &str, _| {
        Err::<TaskToolOutcome, _>("task tool should not be called in this smoke".to_owned())
    };
    let mut ignore_activity = |_| Ok(());
    let mut reject_questions = |_| Err("question should not be asked in this smoke".to_owned());
    let first = session
        .send_turn(
            "Reply with exactly: first nucleus chat turn",
            CHAT_MODEL,
            CHAT_REASONING_EFFORT,
            AgentTurnCancellation::new(),
            &mut ignore_activity,
            &mut reject_questions,
            &mut task_tool,
        )
        .expect("first turn");
    let second = session
        .send_turn(
            "Reply with exactly: second nucleus chat turn",
            CHAT_MODEL,
            CHAT_REASONING_EFFORT,
            AgentTurnCancellation::new(),
            &mut ignore_activity,
            &mut reject_questions,
            &mut task_tool,
        )
        .expect("second turn");
    assert_eq!(first.thread_id, second.thread_id);
    assert_eq!(first.model, CHAT_MODEL);
    assert_eq!(
        first.reasoning_effort.as_deref(),
        Some(CHAT_REASONING_EFFORT)
    );
    assert!(first
        .assistant_message
        .as_deref()
        .expect("assistant message")
        .contains("first nucleus chat turn"));
    assert!(second
        .assistant_message
        .as_deref()
        .expect("assistant message")
        .contains("second nucleus chat turn"));
}

#[test]
#[ignore = "requires a locally authenticated Codex app-server"]
fn live_chat_route_change_opens_a_fresh_thread_with_transcript_context() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("seed project");
    let mut service = LocalCodexChatService::default();
    let mut first_request = request(
        "route-change-smoke",
        "Reply with exactly: route change first",
    );
    first_request.reasoning_effort = Some("low".to_owned());
    let first = service
        .send_message(&state, first_request)
        .expect("first route turn");

    let mut second_request = request(
        "route-change-smoke",
        "Reply with exactly: route change second",
    );
    second_request.reasoning_effort = Some("medium".to_owned());
    let second = service
        .send_message(&state, second_request)
        .expect("changed route turn");
    let history = service
        .history(
            &state,
            "project:nucleus-local",
            "project:nucleus-local:panel:route-change-smoke",
        )
        .expect("history");

    assert_ne!(first.thread_id, second.thread_id);
    assert_eq!(second.reasoning_effort.as_deref(), Some("medium"));
    assert_eq!(history.messages.len(), 4);
}

#[test]
#[ignore = "requires a locally authenticated Codex app-server"]
fn live_chat_receives_active_task_context_without_polluting_history() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("seed project");
    seed_local_task(&state, LocalTaskSeed::nucleus_local_bootstrap()).expect("seed task");
    let conversation_id = "project:nucleus-local:panel:active-task-smoke";
    let operator_message = "Reply with exactly the active task title. Do not call a tool.";
    let mut service = LocalCodexChatService::default();

    let reply = service
        .send_message(
            &state,
            LocalCodexChatRequest {
                conversation_id: conversation_id.to_owned(),
                project_id: "project:nucleus-local".to_owned(),
                resource_id: None,
                message: operator_message.to_owned(),
                active_task_id: Some("task:nucleus-local:bootstrap".to_owned()),
                active_goal_id: None,
                provider_instance_id: Some(CHAT_PROVIDER_INSTANCE_ID.to_owned()),
                provider_instance_revision: Some("1".to_owned()),
                protocol_facade_id: Some("codex-app-server-v2".to_owned()),
                provider_id: None,
                model: None,
                reasoning_effort: None,
                harness_mode: LocalCodexChatHarnessMode::Normal,
                idioms_enabled: true,
            },
        )
        .expect("active task turn");
    let history = service
        .history(&state, "project:nucleus-local", conversation_id)
        .expect("history");

    assert_eq!(
        reply.assistant_message.as_deref(),
        Some("Review Nucleus task workflow")
    );
    assert_eq!(history.messages[0].text, operator_message);
    assert!(!history.messages[0].text.contains("active task context"));
}

#[test]
#[ignore = "requires a locally authenticated Codex app-server"]
fn durable_chat_reopens_with_transcript_context_after_service_restart() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let path = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(path.clone()));
    seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("seed project");
    let request = |message: &str| LocalCodexChatRequest {
        conversation_id: "project:nucleus-local:panel:durable-smoke".to_owned(),
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
    };
    let first = LocalCodexChatService::default()
        .send_message(&state, request("Reply with exactly: durable first"))
        .expect("first turn");
    let reopened = ServerStateService::new(SqliteBackend::new(path));
    let mut resumed_service = LocalCodexChatService::default();
    let second = resumed_service
        .send_message(&reopened, request("Reply with exactly: durable second"))
        .expect("resumed turn");
    let history = resumed_service
        .history(
            &reopened,
            "project:nucleus-local",
            "project:nucleus-local:panel:durable-smoke",
        )
        .expect("history");
    assert_ne!(first.thread_id, second.thread_id);
    assert_eq!(history.messages.len(), 4);
}
