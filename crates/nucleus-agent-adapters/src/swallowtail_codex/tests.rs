//! Swallowtail Codex adapter tests, split from the swallowtail_codex god
//! file; behavior unchanged.

use super::turn::{callback_response, completed_output};
use super::*;
use nucleus_agent_protocol::{AgentHarnessMode, AgentSessionStartRequest, AgentToolCall};
use serde_json::json;
use swallowtail_runtime::{
    CallbackId, CallbackPayload, CallbackRequest, CallbackResult, CleanupOutcome,
    TerminalOutcome, TerminalStatus,
};

#[test]
fn runtime_turn_ids_are_unique_across_retained_operations() {
    let first = runtime_turn_id("chat").expect("first runtime turn id");
    let second = runtime_turn_id("chat").expect("second runtime turn id");

    assert_ne!(first, second);
    for turn_id in [&first, &second] {
        let random_identity = turn_id
            .as_str()
            .strip_prefix("nucleus-chat-turn-")
            .expect("Nucleus chat prefix");
        uuid::Uuid::parse_str(random_identity).expect("UUID-backed runtime identity");
    }
}

#[test]
fn runtime_errors_keep_the_safe_diagnostic_code() {
    let failure = RuntimeFailure::new(swallowtail_core::SafeDiagnostic::new(
        "swallowtail.codex.app_server.malformed_notification",
        "Codex app-server returned a malformed notification",
    ));

    assert_eq!(
        runtime_error(failure),
        "[swallowtail.codex.app_server.malformed_notification] Codex app-server returned a malformed notification"
    );
}

#[test]
fn nucleus_tool_specs_map_to_bounded_swallowtail_declarations() {
    let tools = tool_declarations(vec![json!({
        "type": "function",
        "name": "task_ledger",
        "description": "Inspect tasks",
        "inputSchema": { "type": "object" }
    })])
    .expect("tool declaration");

    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].name(), "task_ledger");
    assert_eq!(
        tools[0].description().map(OperationContent::as_str),
        Some("Inspect tasks")
    );
}

#[test]
fn callback_bridge_preserves_provider_turn_and_callback_identity() {
    let request = CallbackRequest::tool_call(
        CallbackId::new("callback-1").expect("callback id"),
        RuntimeTurnId::new("runtime-turn-1").expect("turn id"),
        1,
        None,
        "task_ledger",
        CallbackPayload::new(br#"{"action":"inspect"}"#.to_vec(), 1024).expect("arguments"),
    )
    .expect("callback request");
    let mut observed = None;
    let mut handler = |call: AgentToolCall| {
        observed = Some(call);
        Ok("done".to_owned())
    };

    let response = callback_response(&request, "provider-turn-1", &mut handler);
    let call = observed.expect("tool call reached Nucleus");
    assert_eq!(call.tool, "task_ledger");
    assert_eq!(call.turn_id, "provider-turn-1");
    assert_eq!(call.call_id, "callback-1");
    assert!(matches!(response.result(), CallbackResult::Success(_)));
}

#[test]
fn completed_turn_requires_non_empty_output() {
    let outcome =
        TerminalOutcome::new(TerminalStatus::Completed, CleanupOutcome::NotApplicable);

    assert!(completed_output(&outcome, false).is_err());
    assert_eq!(completed_output(&outcome, true), Ok(None));

    let with_message = outcome
        .clone()
        .with_output(OperationContent::new("plan review follows").expect("output"));
    assert_eq!(
        completed_output(&with_message, true),
        Ok(Some("plan review follows".to_owned()))
    );
}

#[test]
fn stored_tool_enabled_provider_ids_are_rejected_before_process_work() {
    let failure = SwallowtailCodexSessionRuntime
        .start_session(AgentSessionStartRequest {
            working_directory: "/not/used".to_owned(),
            provider_instance_id: CODEX_PROVIDER_INSTANCE_ID.to_owned(),
            provider_instance_revision: "1".to_owned(),
            protocol_facade_id: "codex-app-server-v2".to_owned(),
            provider_id: None,
            model: "gpt-5.4-mini".to_owned(),
            reasoning_effort: "low".to_owned(),
            harness_mode: AgentHarnessMode::Normal,
            developer_instructions: "instructions".to_owned(),
            dynamic_tools: Vec::new(),
            resume_provider_thread_id: Some("thread:stored".to_owned()),
            idioms_enabled: true,
            turn_timeout: Duration::from_secs(180),
        })
        .err()
        .expect("unsafe resume is rejected");

    assert!(failure.contains("transcript context"));
}

#[test]
#[ignore = "requires a locally authenticated Codex installation"]
fn current_local_codex_model_catalog_clears_full_preflight() {
    let instance = SwallowtailCodexSessionRuntime
        .configured_provider_instance()
        .expect("Codex configured provider instance");

    assert_eq!(instance.instance_id().as_str(), CODEX_PROVIDER_INSTANCE_ID);
    assert!(instance.model_catalogue().is_some());
}

#[test]
#[ignore = "requires a locally authenticated Codex installation"]
fn current_local_codex_chat_session_opens_with_its_preflight_policy() {
    let working_directory = std::env::current_dir().expect("working directory");
    let session = SwallowtailCodexSessionRuntime
        .start_session(AgentSessionStartRequest {
            working_directory: working_directory.display().to_string(),
            provider_instance_id: CODEX_PROVIDER_INSTANCE_ID.to_owned(),
            provider_instance_revision: "1".to_owned(),
            protocol_facade_id: "codex-app-server-v2".to_owned(),
            provider_id: None,
            model: "gpt-5.4-mini".to_owned(),
            reasoning_effort: "low".to_owned(),
            harness_mode: AgentHarnessMode::Normal,
            developer_instructions: "Nucleus integration smoke.".to_owned(),
            dynamic_tools: vec![json!({
                "type": "function",
                "name": "task_ledger",
                "description": "Inspect tasks",
                "inputSchema": { "type": "object" }
            })],
            resume_provider_thread_id: None,
            idioms_enabled: true,
            turn_timeout: Duration::from_secs(180),
        })
        .expect("Codex chat session");

    drop(session);
}
