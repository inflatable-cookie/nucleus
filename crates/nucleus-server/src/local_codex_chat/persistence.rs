use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreRecord, LocalStoreRecordPayload, RevisionExpectation,
};
use serde::{Deserialize, Serialize};

use super::{TaskAuthoringReceipt, TaskWorkflowReceipt};
use crate::ServerStateService;

const SESSION_PREFIX: &str = "product-chat-session:";
const TURN_PREFIX: &str = "product-chat-turn:";
const MESSAGE_PREFIX: &str = "product-chat-message:";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredChatSession {
    pub conversation_id: String,
    pub project_id: String,
    pub session_id: String,
    pub provider_thread_id: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub adapter_id: String,
    #[serde(default)]
    pub provider_instance_id: String,
    pub turn_count: u64,
    #[serde(default)]
    pub task_toolset_version: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredChatTurn {
    pub conversation_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub ordinal: u64,
    pub status: String,
    #[serde(default)]
    pub provider_turn_id: Option<String>,
    #[serde(default)]
    pub failure_reason: Option<String>,
    #[serde(default)]
    pub selected_goal_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredChatMessage {
    pub message_id: String,
    pub conversation_id: String,
    pub turn_id: String,
    pub role: ChatMessageRole,
    pub text: String,
    pub sequence: u64,
    #[serde(default)]
    pub task_receipts: Vec<TaskAuthoringReceipt>,
    #[serde(default)]
    pub workflow_receipts: Vec<TaskWorkflowReceipt>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatMessageRole {
    User,
    Assistant,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LocalCodexChatHistory {
    pub conversation_id: String,
    pub project_id: String,
    pub session_id: Option<String>,
    pub thread_id: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub messages: Vec<StoredChatMessage>,
}

pub fn read_session<B>(
    state: &ServerStateService<B>,
    conversation_id: &str,
) -> Result<Option<StoredChatSession>, String>
where
    B: LocalStoreBackend,
{
    state
        .agent_sessions()
        .get(&session_record_id(conversation_id))
        .map_err(storage_error)?
        .map(|record| decode(&record.payload.bytes))
        .transpose()
}

pub fn read_history<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    conversation_id: &str,
) -> Result<LocalCodexChatHistory, String>
where
    B: LocalStoreBackend,
{
    let session =
        read_session(state, conversation_id)?.filter(|session| session.project_id == project_id);
    let mut messages = state
        .agent_sessions()
        .list()
        .map_err(storage_error)?
        .into_iter()
        .filter(|record| record.id.0.starts_with(MESSAGE_PREFIX))
        .map(|record| decode::<StoredChatMessage>(&record.payload.bytes))
        .collect::<Result<Vec<_>, _>>()?;
    messages.retain(|message| message.conversation_id == conversation_id);
    messages.sort_by_key(|message| message.sequence);

    Ok(LocalCodexChatHistory {
        conversation_id: conversation_id.to_owned(),
        project_id: project_id.to_owned(),
        session_id: session.as_ref().map(|session| session.session_id.clone()),
        thread_id: session
            .as_ref()
            .map(|session| session.provider_thread_id.clone()),
        model: session.as_ref().map(|session| session.model.clone()),
        reasoning_effort: session
            .as_ref()
            .and_then(|session| session.reasoning_effort.clone()),
        messages,
    })
}

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
    put_json(
        state,
        session_record_id(&session.conversation_id),
        &session,
        RevisionId(format!(
            "rev:{}:{}",
            session_record_id(&session.conversation_id).0,
            session.turn_count
        )),
        RevisionExpectation::Any,
    )?;
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
    assistant_message: &str,
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
    reason: &str,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let (mut turn, revision) = read_turn(state, turn_id)?;
    if turn.status != "started" {
        return Err(format!("chat turn is not awaiting failure: {turn_id}"));
    }
    turn.status = "failed".to_owned();
    turn.failure_reason = Some(reason.chars().take(500).collect());
    put_json(
        state,
        PersistenceRecordId(format!("{TURN_PREFIX}{turn_id}")),
        &turn,
        RevisionId(format!("rev:{TURN_PREFIX}{turn_id}:failed")),
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

fn put_json<B, T>(
    state: &ServerStateService<B>,
    id: PersistenceRecordId,
    value: &T,
    revision_id: RevisionId,
    expectation: RevisionExpectation,
) -> Result<(), String>
where
    B: LocalStoreBackend,
    T: Serialize,
{
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    state
        .agent_sessions()
        .put(
            LocalStoreRecord {
                revision_id,
                id,
                domain: PersistenceDomain::AgentSessions,
                kind: PersistenceRecordKind::AgentSession,
                payload: LocalStoreRecordPayload {
                    media_type: Some("application/json".to_owned()),
                    bytes,
                },
            },
            expectation,
        )
        .map(|_| ())
        .map_err(storage_error)
}

fn session_record_id(conversation_id: &str) -> PersistenceRecordId {
    PersistenceRecordId(format!("{SESSION_PREFIX}{conversation_id}"))
}

fn decode<T>(bytes: &[u8]) -> Result<T, String>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_slice(bytes).map_err(|error| error.to_string())
}

fn storage_error(error: impl std::fmt::Debug) -> String {
    format!("chat persistence failed: {error:?}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_local_store::SqliteBackend;

    #[test]
    fn completed_chat_turn_survives_reopen_in_display_order() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let path = temp_dir.path().join("nucleus.sqlite");
        let state = ServerStateService::new(SqliteBackend::new(path.clone()));
        let session = StoredChatSession {
            conversation_id: "project:1:panel:chat".to_owned(),
            project_id: "project:1".to_owned(),
            session_id: "session:1".to_owned(),
            provider_thread_id: "thread:1".to_owned(),
            model: "gpt-5.4-mini".to_owned(),
            reasoning_effort: Some("low".to_owned()),
            adapter_id: "codex-app-server".to_owned(),
            provider_instance_id: "codex:local-default".to_owned(),
            turn_count: 1,
            task_toolset_version: 1,
        };

        persist_turn_start(&state, session, "turn:1", "Hello", None).expect("start");
        persist_turn_completion(
            &state,
            "turn:1",
            "provider-turn:1",
            "Hi there",
            &[],
            &[TaskWorkflowReceipt {
                status: super::super::TaskWorkflowReceiptStatus::ReviewReady,
                scope_kind: "task".to_owned(),
                project_id: "project:1".to_owned(),
                goal_id: None,
                task_id: Some("task:1".to_owned()),
                title: "Task 1".to_owned(),
                current_task_id: Some("task:1".to_owned()),
                current_position: 1,
                total_tasks: 1,
                summary: "Ready for review".to_owned(),
                mandate_id: "mandate:1".to_owned(),
                plan_id: Some("plan:1".to_owned()),
                work_item_refs: vec!["work:1".to_owned()],
                runtime_receipt_refs: vec!["receipt:1".to_owned()],
            }],
        )
        .expect("complete");
        let reopened = ServerStateService::new(SqliteBackend::new(path));
        let history =
            read_history(&reopened, "project:1", "project:1:panel:chat").expect("read history");

        assert_eq!(history.messages.len(), 2);
        assert_eq!(history.messages[0].role, ChatMessageRole::User);
        assert_eq!(history.messages[1].text, "Hi there");
        assert_eq!(history.messages[1].workflow_receipts.len(), 1);
        assert_eq!(
            history.messages[1].workflow_receipts[0].task_id.as_deref(),
            Some("task:1")
        );
        assert_eq!(history.thread_id.as_deref(), Some("thread:1"));
    }

    #[test]
    fn failed_turn_retains_one_operator_message_without_assistant_copy() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
        let session = StoredChatSession {
            conversation_id: "conversation:1".to_owned(),
            project_id: "project:1".to_owned(),
            session_id: "session:1".to_owned(),
            provider_thread_id: "thread:1".to_owned(),
            model: "model".to_owned(),
            reasoning_effort: None,
            adapter_id: "codex-app-server".to_owned(),
            provider_instance_id: "codex:local-default".to_owned(),
            turn_count: 1,
            task_toolset_version: 4,
        };
        persist_turn_start(&state, session, "turn:1", "Run the goal", None).expect("start");
        persist_turn_failure(&state, "turn:1", "provider unavailable").expect("fail");

        let history = read_history(&state, "project:1", "conversation:1").expect("history");
        assert_eq!(history.messages.len(), 1);
        assert_eq!(history.messages[0].role, ChatMessageRole::User);
        assert_eq!(
            current_turn(&state, "conversation:1").expect("turn").status,
            "failed"
        );
    }

    #[test]
    fn legacy_chat_session_without_toolset_version_requires_migration() {
        let session: StoredChatSession = serde_json::from_value(serde_json::json!({
            "conversation_id": "conversation:legacy",
            "project_id": "project:1",
            "session_id": "session:1",
            "provider_thread_id": "thread:legacy",
            "model": "gpt-5.4-mini",
            "reasoning_effort": "low",
            "turn_count": 2
        }))
        .expect("legacy session");

        assert_eq!(session.task_toolset_version, 0);
    }
}
