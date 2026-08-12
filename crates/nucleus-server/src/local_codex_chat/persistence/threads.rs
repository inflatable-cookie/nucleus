//! Split from the local_codex_chat persistence god file; behavior unchanged.

#[allow(unused_imports)]
use super::*;

use nucleus_local_store::LocalStoreBackend;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::super::subagent_directory::DIRECTORY_PREFIX;
use super::super::subagent_selection::SELECTION_PREFIX;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct StoredChatThreadMetadata {
    conversation_id: String,
    title: String,
}

pub fn list_threads<B>(
    state: &ServerStateService<B>,
) -> Result<Vec<LocalCodexChatThreadSummary>, String>
where
    B: LocalStoreBackend,
{
    let records = state.agent_sessions().list().map_err(storage_error)?;
    let sessions = records
        .iter()
        .filter(|record| record.id.0.starts_with(SESSION_PREFIX))
        .map(|record| decode::<StoredChatSession>(&record.payload.bytes))
        .collect::<Result<Vec<_>, _>>()?;
    let turns = records
        .iter()
        .filter(|record| record.id.0.starts_with(TURN_PREFIX))
        .map(|record| decode::<StoredChatTurn>(&record.payload.bytes))
        .collect::<Result<Vec<_>, _>>()?;
    let messages = records
        .iter()
        .filter(|record| record.id.0.starts_with(MESSAGE_PREFIX))
        .map(|record| decode::<StoredChatMessage>(&record.payload.bytes))
        .collect::<Result<Vec<_>, _>>()?;
    let thread_metadata = records
        .iter()
        .filter(|record| record.id.0.starts_with(THREAD_METADATA_PREFIX))
        .map(|record| decode::<StoredChatThreadMetadata>(&record.payload.bytes))
        .collect::<Result<Vec<_>, _>>()?;

    let mut summaries = sessions
        .into_iter()
        .map(|session| {
            let status = turns
                .iter()
                .filter(|turn| turn.conversation_id == session.conversation_id)
                .max_by_key(|turn| turn.ordinal)
                .map(|turn| turn.status.clone())
                .unwrap_or_else(|| "ready".to_owned());
            let title = thread_metadata
                .iter()
                .find(|metadata| metadata.conversation_id == session.conversation_id)
                .map(|metadata| metadata.title.clone())
                .or_else(|| {
                    messages
                        .iter()
                        .filter(|message| {
                            message.conversation_id == session.conversation_id
                                && message.role == ChatMessageRole::User
                        })
                        .min_by_key(|message| message.sequence)
                        .map(|message| compact_thread_title(&message.text))
                })
                .unwrap_or_else(|| "New conversation".to_owned());

            LocalCodexChatThreadSummary {
                conversation_id: session.conversation_id,
                project_id: session.project_id,
                session_id: session.session_id,
                thread_id: session.provider_thread_id,
                title,
                model: session.model,
                reasoning_effort: session.reasoning_effort,
                harness_mode: session.harness_mode,
                turn_count: session.turn_count,
                status,
            }
        })
        .collect::<Vec<_>>();
    summaries.sort_by(|left, right| {
        left.project_id
            .cmp(&right.project_id)
            .then_with(|| left.conversation_id.cmp(&right.conversation_id))
    });
    Ok(summaries)
}

pub fn read_native_proof_evidence<B>(
    state: &ServerStateService<B>,
) -> Result<NativeProofEvidenceSummary, String>
where
    B: LocalStoreBackend,
{
    let turns = state
        .agent_sessions()
        .list()
        .map_err(storage_error)?
        .into_iter()
        .filter(|record| record.id.0.starts_with(TURN_PREFIX))
        .map(|record| decode::<StoredChatTurn>(&record.payload.bytes))
        .collect::<Result<Vec<_>, _>>()?;
    let mut summary = NativeProofEvidenceSummary {
        schema_version: 1,
        expected_terminal_classes: ["completed", "cancelled", "timed_out", "failed"]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        total_turns: turns.len() as u64,
        active_turns: 0,
        completed_turns: 0,
        cancelled_turns: 0,
        timed_out_turns: 0,
        failed_turns: 0,
        unexpected_turns: 0,
    };
    for turn in turns {
        match turn.status.as_str() {
            "started" => summary.active_turns += 1,
            "completed" => summary.completed_turns += 1,
            "cancelled" => summary.cancelled_turns += 1,
            "timed_out" => summary.timed_out_turns += 1,
            "failed" => summary.failed_turns += 1,
            _ => summary.unexpected_turns += 1,
        }
    }
    Ok(summary)
}

pub fn rename_thread<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    conversation_id: &str,
    title: &str,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let session = read_session(state, conversation_id)?
        .filter(|session| session.project_id == project_id)
        .ok_or_else(|| format!("chat thread not found: {conversation_id}"))?;
    let title = title.trim();
    if title.is_empty() {
        return Err("chat thread title must not be empty".to_owned());
    }
    if title.chars().count() > 80 {
        return Err("chat thread title must not exceed 80 characters".to_owned());
    }

    let metadata = StoredChatThreadMetadata {
        conversation_id: session.conversation_id,
        title: title.to_owned(),
    };
    let revision_hash = blake3::hash(title.as_bytes()).to_hex();
    put_json(
        state,
        thread_metadata_record_id(conversation_id),
        &metadata,
        RevisionId(format!(
            "rev:{THREAD_METADATA_PREFIX}{conversation_id}:{revision_hash}"
        )),
        RevisionExpectation::Any,
    )
}

fn compact_thread_title(message: &str) -> String {
    const MAX_CHARS: usize = 80;
    let compact = message.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= MAX_CHARS {
        return compact;
    }
    let mut title = compact.chars().take(MAX_CHARS - 1).collect::<String>();
    title.push('…');
    title
}

/// Hard-deletes every durable record owned by one chat thread: session,
/// thread metadata, actor selection, turns, messages, activities, question
/// exchanges, plan decisions, and subagent directories. Returns the number of
/// records removed.
pub fn delete_thread<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    conversation_id: &str,
) -> Result<u64, String>
where
    B: LocalStoreBackend,
{
    read_session(state, conversation_id)?
        .filter(|session| session.project_id == project_id)
        .ok_or_else(|| format!("chat thread not found: {conversation_id}"))?;

    let mut victims = vec![
        super::session::session_record_id(conversation_id),
        thread_metadata_record_id(conversation_id),
        PersistenceRecordId(format!(
            "{SELECTION_PREFIX}{}",
            blake3::hash(conversation_id.as_bytes()).to_hex()
        )),
    ];
    for record in state.agent_sessions().list().map_err(storage_error)? {
        let id = &record.id.0;
        let conversation_scoped = id.starts_with(TURN_PREFIX)
            || id.starts_with(MESSAGE_PREFIX)
            || id.starts_with(ACTIVITY_PREFIX)
            || id.starts_with(QUESTION_PREFIX)
            || id.starts_with(PLAN_PREFIX)
            || id.starts_with(DIRECTORY_PREFIX);
        if !conversation_scoped {
            continue;
        }
        let payload = decode::<Value>(&record.payload.bytes)?;
        if payload.get("conversation_id").and_then(Value::as_str) != Some(conversation_id) {
            continue;
        }
        if id.starts_with(DIRECTORY_PREFIX)
            && payload.get("project_id").and_then(Value::as_str) != Some(project_id)
        {
            continue;
        }
        victims.push(record.id.clone());
    }

    let mut deleted = 0u64;
    for record_id in victims {
        if state
            .agent_sessions()
            .get(&record_id)
            .map_err(storage_error)?
            .is_none()
        {
            continue;
        }
        state
            .agent_sessions()
            .delete(&record_id, RevisionExpectation::Any)
            .map_err(storage_error)?;
        deleted += 1;
    }
    Ok(deleted)
}

fn thread_metadata_record_id(conversation_id: &str) -> PersistenceRecordId {
    PersistenceRecordId(format!("{THREAD_METADATA_PREFIX}{conversation_id}"))
}
