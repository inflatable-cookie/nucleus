//! Split from the local_codex_chat persistence god file; behavior unchanged.

#[allow(unused_imports)]
use super::*;

use nucleus_local_store::LocalStoreBackend;

use super::super::{TaskAuthoringReceipt, TaskWorkflowReceipt};

pub fn canonical_turn_id(conversation_id: &str, ordinal: u64) -> String {
    format!("turn:chat:{conversation_id}:{ordinal}")
}

pub fn operator_message_id(turn_id: &str) -> String {
    format!("message:{turn_id}:user")
}

pub fn persist_turn_start<B>(
    state: &ServerStateService<B>,
    session: StoredChatSession,
    turn_id: &str,
    user_message: &str,
    selected_goal_id: Option<String>,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let ordinal = session.turn_count;
    persist_session(state, &session)?;
    put_json(
        state,
        PersistenceRecordId(format!("{TURN_PREFIX}{turn_id}")),
        &StoredChatTurn {
            conversation_id: session.conversation_id.clone(),
            session_id: session.session_id,
            turn_id: turn_id.to_owned(),
            ordinal,
            status: "started".to_owned(),
            provider_turn_id: None,
            failure_reason: None,
            selected_goal_id,
        },
        RevisionId(format!("rev:{TURN_PREFIX}{turn_id}")),
        RevisionExpectation::MustNotExist,
    )?;
    let first_sequence = (ordinal.saturating_sub(1)) * 2;
    persist_message(
        state,
        StoredChatMessage {
            message_id: operator_message_id(turn_id),
            conversation_id: session.conversation_id.clone(),
            turn_id: turn_id.to_owned(),
            role: ChatMessageRole::User,
            text: user_message.to_owned(),
            sequence: first_sequence,
            task_receipts: Vec::new(),
            workflow_receipts: Vec::new(),
        },
    )
}

pub fn persist_turn_completion<B>(
    state: &ServerStateService<B>,
    turn_id: &str,
    provider_turn_id: &str,
    assistant_message: Option<&str>,
    task_receipts: &[TaskAuthoringReceipt],
    workflow_receipts: &[TaskWorkflowReceipt],
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let (mut turn, revision) = read_turn(state, turn_id)?;
    if turn.status != "started" {
        return Err(format!("chat turn is not awaiting completion: {turn_id}"));
    }
    turn.status = "completed".to_owned();
    turn.provider_turn_id = Some(provider_turn_id.to_owned());
    put_json(
        state,
        PersistenceRecordId(format!("{TURN_PREFIX}{turn_id}")),
        &turn,
        RevisionId(format!("rev:{TURN_PREFIX}{turn_id}:completed")),
        RevisionExpectation::Exact(revision),
    )?;
    let Some(assistant_message) = assistant_message else {
        // A plan-terminal turn completes without a final assistant message;
        // the pending plan record is its outcome artifact.
        return Ok(());
    };
    let first_sequence = (turn.ordinal.saturating_sub(1)) * 2;
    persist_message(
        state,
        StoredChatMessage {
            message_id: format!("message:{turn_id}:assistant"),
            conversation_id: turn.conversation_id,
            turn_id: turn_id.to_owned(),
            role: ChatMessageRole::Assistant,
            text: assistant_message.to_owned(),
            sequence: first_sequence + 1,
            task_receipts: task_receipts.to_vec(),
            workflow_receipts: workflow_receipts.to_vec(),
        },
    )
}

pub fn persist_turn_failure<B>(
    state: &ServerStateService<B>,
    turn_id: &str,
    status: ChatTurnFailureStatus,
    reason: &str,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let (mut turn, revision) = read_turn(state, turn_id)?;
    if turn.status != "started" {
        return Err(format!("chat turn is not awaiting failure: {turn_id}"));
    }
    turn.status = status.as_str().to_owned();
    turn.failure_reason = Some(reason.chars().take(500).collect());
    put_json(
        state,
        PersistenceRecordId(format!("{TURN_PREFIX}{turn_id}")),
        &turn,
        RevisionId(format!("rev:{TURN_PREFIX}{turn_id}:{}", status.as_str())),
        RevisionExpectation::Exact(revision),
    )
}

pub(crate) fn read_message<B>(
    state: &ServerStateService<B>,
    message_id: &str,
) -> Result<StoredChatMessage, String>
where
    B: LocalStoreBackend,
{
    let record = state
        .agent_sessions()
        .get(&PersistenceRecordId(format!(
            "{MESSAGE_PREFIX}{message_id}"
        )))
        .map_err(storage_error)?
        .ok_or_else(|| format!("chat message not found: {message_id}"))?;
    decode(&record.payload.bytes)
}

pub(crate) fn current_turn<B>(
    state: &ServerStateService<B>,
    conversation_id: &str,
) -> Result<StoredChatTurn, String>
where
    B: LocalStoreBackend,
{
    state
        .agent_sessions()
        .list()
        .map_err(storage_error)?
        .into_iter()
        .filter(|record| record.id.0.starts_with(TURN_PREFIX))
        .map(|record| decode::<StoredChatTurn>(&record.payload.bytes))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|turn| turn.conversation_id == conversation_id)
        .max_by_key(|turn| turn.ordinal)
        .ok_or_else(|| format!("conversation has no persisted turn: {conversation_id}"))
}

pub(crate) fn project_has_active_turn<B>(
    state: &ServerStateService<B>,
    project_id: &str,
) -> Result<bool, String>
where
    B: LocalStoreBackend,
{
    let conversation_ids = state
        .agent_sessions()
        .list()
        .map_err(storage_error)?
        .into_iter()
        .filter(|record| record.id.0.starts_with(SESSION_PREFIX))
        .map(|record| decode::<StoredChatSession>(&record.payload.bytes))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|session| session.project_id == project_id)
        .map(|session| session.conversation_id)
        .collect::<std::collections::HashSet<_>>();
    if conversation_ids.is_empty() {
        return Ok(false);
    }

    state
        .agent_sessions()
        .list()
        .map_err(storage_error)?
        .into_iter()
        .filter(|record| record.id.0.starts_with(TURN_PREFIX))
        .map(|record| decode::<StoredChatTurn>(&record.payload.bytes))
        .collect::<Result<Vec<_>, _>>()
        .map(|turns| {
            turns.into_iter().any(|turn| {
                turn.status == "started" && conversation_ids.contains(&turn.conversation_id)
            })
        })
}

fn read_turn<B>(
    state: &ServerStateService<B>,
    turn_id: &str,
) -> Result<(StoredChatTurn, RevisionId), String>
where
    B: LocalStoreBackend,
{
    let record = state
        .agent_sessions()
        .get(&PersistenceRecordId(format!("{TURN_PREFIX}{turn_id}")))
        .map_err(storage_error)?
        .ok_or_else(|| format!("chat turn not found: {turn_id}"))?;
    Ok((decode(&record.payload.bytes)?, record.revision_id))
}

fn persist_message<B>(
    state: &ServerStateService<B>,
    message: StoredChatMessage,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    put_json(
        state,
        PersistenceRecordId(format!("{MESSAGE_PREFIX}{}", message.message_id)),
        &message,
        RevisionId(format!("rev:{MESSAGE_PREFIX}{}", message.message_id)),
        RevisionExpectation::MustNotExist,
    )
}
