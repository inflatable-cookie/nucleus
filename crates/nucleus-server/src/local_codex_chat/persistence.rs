//! Durable store records for local Codex-backed product chat.
//!
//! Module index over the record domains: types, sessions, turns,
//! interactions (question exchanges and plan decisions), activities, and
//! threads. The store plumbing (`put_json`, `decode`, `storage_error`) and
//! record prefixes live here so every record domain shares one surface.

mod activity;
mod interaction;
mod session;
mod threads;
mod turn;
mod types;
#[cfg(test)]
mod tests_activity;
#[cfg(test)]
mod tests_interaction;
#[cfg(test)]
mod tests_threads;
#[cfg(test)]
mod tests_turns;

pub use activity::{persist_activity, project_activity};
pub(crate) use turn::{current_turn, project_has_active_turn, read_message};
pub use interaction::{
    now_unix_ms, persist_plan_pending, persist_question_answer, persist_question_pending,
    project_question, settle_pending_plan_for_conversation, settle_plan_decision,
    settle_pending_questions_for_turn,
};
pub use session::{persist_session, read_history, read_session, recover_interrupted_chat_state};
pub use threads::{delete_thread, list_threads, read_native_proof_evidence, rename_thread};
pub use turn::{
    canonical_turn_id, operator_message_id, persist_turn_completion, persist_turn_failure,
    persist_turn_start,
};
pub(super) use types::ChatTurnFailureStatus;
pub use types::{
    ChatMessageRole, LocalCodexChatHistory, LocalCodexChatHistoryTurn,
    LocalCodexChatThreadSummary, NativeProofEvidenceSummary, StoredChatActivity,
    StoredChatMessage, StoredChatPlanDecision, StoredChatQuestion, StoredChatQuestionAnswer,
    StoredChatQuestionExchange, StoredChatQuestionOption, StoredChatSession, StoredChatSubagent,
    StoredChatTaskListItem, StoredChatTurn,
};

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreRecord, LocalStoreRecordPayload, RevisionExpectation,
};
use serde::{Deserialize, Serialize};

use crate::ServerStateService;

const SESSION_PREFIX: &str = "product-chat-session:";
const TURN_PREFIX: &str = "product-chat-turn:";
const MESSAGE_PREFIX: &str = "product-chat-message:";
const ACTIVITY_PREFIX: &str = "product-chat-activity:";
const QUESTION_PREFIX: &str = "product-chat-question:";
const PLAN_PREFIX: &str = "product-chat-plan:";
const THREAD_METADATA_PREFIX: &str = "product-chat-thread-metadata:";

pub(super) fn put_json<B, T>(
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

pub(super) fn decode<T>(bytes: &[u8]) -> Result<T, String>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_slice(bytes).map_err(|error| error.to_string())
}

pub(super) fn storage_error(error: impl std::fmt::Debug) -> String {
    format!("chat persistence failed: {error:?}")
}
