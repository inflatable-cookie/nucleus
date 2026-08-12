//! Agent chat Tauri commands: message send, cancellation, question answers,
//! plan decisions, actor selection, history, threads, and provider catalogue.
//!
//! Split from the lib.rs god file; behavior unchanged.

use std::sync::Arc;

use tauri::Emitter;

use nucleus_server::{
    answer_local_codex_chat_question, request_local_codex_credential_action, select_chat_actor,
    AgentChatProviderCatalogue, ControlRequestEnvelopeDto, ControlResponseBodyDto,
    LocalCodexChatActorSelectionRequest, LocalCodexChatHistory,
    LocalCodexChatPlanDecisionReply, LocalCodexChatPlanDecisionRequest,
    LocalCodexChatQuestionAnswerRequest, LocalCodexChatReply, LocalCodexChatRequest,
    LocalCodexChatService, LocalCodexChatThreadSummary, LocalCodexCredentialActionReceipt,
    LocalCodexCredentialActionRequest, StoredChatActorSelection, StoredChatQuestionExchange,
};

use crate::DesktopState;

#[tauri::command]
pub(crate) async fn send_agent_chat_message(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
    request: LocalCodexChatRequest,
) -> Result<LocalCodexChatReply, String> {
    let active_turn = state
        .chat_cancellation
        .begin(&request.project_id, &request.conversation_id)?;
    let cancellation = active_turn.cancellation();
    let chat = Arc::clone(&state.chat);
    let chat_questions = state.chat_questions.clone();
    let adapter = Arc::clone(&state.adapter);
    let server_state = state.server_state.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let _active_turn = active_turn;
        let mut chat = chat
            .lock()
            .map_err(|_| "agent chat runtime lock is poisoned".to_owned())?;
        chat.send_message_with_task_authoring_and_cancellation(
            &server_state,
            request,
            cancellation,
            &chat_questions,
            &mut |control_request| {
                let envelope = ControlRequestEnvelopeDto::try_from(&control_request)
                    .map_err(|error| error.reason)?;
                let response = adapter
                    .lock()
                    .map_err(|_| "desktop command adapter lock is poisoned".to_owned())?
                    .submit_control_envelope(envelope)
                    .map_err(|error| error.reason)?;
                match response.body {
                    ControlResponseBodyDto::CommandReceipt { status, .. }
                        if status == "accepted_for_state_mutation" =>
                    {
                        Ok(())
                    }
                    ControlResponseBodyDto::CommandReceipt { status, .. } => {
                        Err(format!("task ledger command was not accepted: {status}"))
                    }
                    ControlResponseBodyDto::Error { reason, .. } => Err(reason),
                    _ => Err("task ledger command returned an unexpected response".to_owned()),
                }
            },
            &mut |activity, directory| {
                window
                    .emit("agent-chat:activity", activity)
                    .map_err(|error| format!("agent chat activity delivery failed: {error}"))?;
                if let Some(directory) = directory {
                    window
                        .emit("agent-chat:subagents", directory)
                        .map_err(|error| format!("agent chat child delivery failed: {error}"))?;
                }
                Ok(())
            },
            &mut |question| {
                window
                    .emit("agent-chat:question", question)
                    .map_err(|error| format!("agent chat question delivery failed: {error}"))
            },
        )
    })
    .await
    .map_err(|error| format!("agent chat worker failed: {error}"))?
}

#[tauri::command]
pub(crate) fn cancel_agent_chat_turn(
    state: tauri::State<'_, DesktopState>,
    project_id: String,
    conversation_id: String,
) -> Result<bool, String> {
    let cancelled = state
        .chat_cancellation
        .request(&project_id, &conversation_id)?;
    if cancelled {
        state.chat_questions.abandon_conversation(
            &project_id,
            &conversation_id,
            "Agent Chat turn was cancelled",
        );
    }
    Ok(cancelled)
}

#[tauri::command]
pub(crate) fn answer_agent_chat_question(
    state: tauri::State<'_, DesktopState>,
    request: LocalCodexChatQuestionAnswerRequest,
) -> Result<StoredChatQuestionExchange, String> {
    answer_local_codex_chat_question(&state.server_state, &state.chat_questions, request)
}

#[tauri::command]
pub(crate) async fn decide_agent_chat_plan(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
    request: LocalCodexChatPlanDecisionRequest,
) -> Result<LocalCodexChatPlanDecisionReply, String> {
    let active_turn = state
        .chat_cancellation
        .begin(&request.project_id, &request.conversation_id)?;
    let cancellation = active_turn.cancellation();
    let chat = Arc::clone(&state.chat);
    let chat_questions = state.chat_questions.clone();
    let adapter = Arc::clone(&state.adapter);
    let server_state = state.server_state.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let _active_turn = active_turn;
        let mut chat = chat
            .lock()
            .map_err(|_| "agent chat runtime lock is poisoned".to_owned())?;
        chat.decide_plan_with_task_authoring_and_cancellation(
            &server_state,
            request,
            cancellation,
            &chat_questions,
            &mut |control_request| {
                let envelope = ControlRequestEnvelopeDto::try_from(&control_request)
                    .map_err(|error| error.reason)?;
                let response = adapter
                    .lock()
                    .map_err(|_| "desktop command adapter lock is poisoned".to_owned())?
                    .submit_control_envelope(envelope)
                    .map_err(|error| error.reason)?;
                match response.body {
                    ControlResponseBodyDto::CommandReceipt { status, .. }
                        if status == "accepted_for_state_mutation" =>
                    {
                        Ok(())
                    }
                    ControlResponseBodyDto::CommandReceipt { status, .. } => {
                        Err(format!("task ledger command was not accepted: {status}"))
                    }
                    ControlResponseBodyDto::Error { reason, .. } => Err(reason),
                    _ => Err("task ledger command returned an unexpected response".to_owned()),
                }
            },
            &mut |activity, directory| {
                window
                    .emit("agent-chat:activity", activity)
                    .map_err(|error| format!("agent chat activity delivery failed: {error}"))?;
                if let Some(directory) = directory {
                    window
                        .emit("agent-chat:subagents", directory)
                        .map_err(|error| format!("agent chat child delivery failed: {error}"))?;
                }
                Ok(())
            },
            &mut |question| {
                window
                    .emit("agent-chat:question", question)
                    .map_err(|error| format!("agent chat question delivery failed: {error}"))
            },
        )
    })
    .await
    .map_err(|error| format!("agent chat worker failed: {error}"))?
}

#[tauri::command]
pub(crate) fn select_agent_chat_actor(
    state: tauri::State<'_, DesktopState>,
    request: LocalCodexChatActorSelectionRequest,
) -> Result<StoredChatActorSelection, String> {
    select_chat_actor(&state.server_state, request)
}

#[tauri::command]
pub(crate) async fn load_agent_chat_history(
    state: tauri::State<'_, DesktopState>,
    project_id: String,
    conversation_id: String,
) -> Result<LocalCodexChatHistory, String> {
    let chat = Arc::clone(&state.chat);
    let server_state = state.server_state.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let chat = chat
            .lock()
            .map_err(|_| "agent chat runtime lock is poisoned".to_owned())?;
        chat.history(&server_state, &project_id, &conversation_id)
    })
    .await
    .map_err(|error| format!("agent chat history worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn list_agent_chat_threads(
    state: tauri::State<'_, DesktopState>,
) -> Result<Vec<LocalCodexChatThreadSummary>, String> {
    let chat = Arc::clone(&state.chat);
    let server_state = state.server_state.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let chat = chat
            .lock()
            .map_err(|_| "agent chat runtime lock is poisoned".to_owned())?;
        chat.threads(&server_state)
    })
    .await
    .map_err(|error| format!("agent chat thread worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn rename_agent_chat_thread(
    state: tauri::State<'_, DesktopState>,
    project_id: String,
    conversation_id: String,
    title: String,
) -> Result<(), String> {
    let chat = Arc::clone(&state.chat);
    let server_state = state.server_state.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let chat = chat
            .lock()
            .map_err(|_| "agent chat runtime lock is poisoned".to_owned())?;
        chat.rename_thread(&server_state, &project_id, &conversation_id, &title)
    })
    .await
    .map_err(|error| format!("agent chat thread rename worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn delete_agent_chat_thread(
    state: tauri::State<'_, DesktopState>,
    project_id: String,
    conversation_id: String,
) -> Result<u64, String> {
    let chat = Arc::clone(&state.chat);
    let server_state = state.server_state.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let mut chat = chat
            .lock()
            .map_err(|_| "agent chat runtime lock is poisoned".to_owned())?;
        chat.delete_thread(&server_state, &project_id, &conversation_id)
    })
    .await
    .map_err(|error| format!("agent chat thread delete worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn agent_chat_provider_catalogue() -> Result<AgentChatProviderCatalogue, String> {
    tauri::async_runtime::spawn_blocking(LocalCodexChatService::provider_catalogue)
        .await
        .map_err(|error| format!("agent chat provider catalogue worker failed: {error}"))?
}

#[tauri::command]
pub(crate) fn agent_chat_credential_action(
    request: LocalCodexCredentialActionRequest,
) -> LocalCodexCredentialActionReceipt {
    request_local_codex_credential_action(request)
}
