use nucleus_core::{PersistenceRecordId, RevisionId};
use nucleus_local_store::{LocalStoreBackend, RevisionExpectation};
use serde::{Deserialize, Serialize};

use super::persistence::{decode, put_json, storage_error};
use super::subagent_directory::read_subagent_directories;
use crate::ServerStateService;

const SELECTION_PREFIX: &str = "product-chat-actor-selection:";

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalCodexChatActorSelectionKind {
    #[default]
    All,
    Primary,
    Subagent,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredChatActorSelection {
    pub project_id: String,
    pub conversation_id: String,
    pub kind: LocalCodexChatActorSelectionKind,
    pub runtime_operation_id: Option<String>,
    pub actor_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LocalCodexChatActorSelectionRequest {
    pub project_id: String,
    pub conversation_id: String,
    pub kind: LocalCodexChatActorSelectionKind,
    pub runtime_operation_id: Option<String>,
    pub actor_id: Option<String>,
}

pub fn select_chat_actor<B>(
    state: &ServerStateService<B>,
    request: LocalCodexChatActorSelectionRequest,
) -> Result<StoredChatActorSelection, String>
where
    B: LocalStoreBackend,
{
    let session = super::persistence::read_session(state, &request.conversation_id)?
        .ok_or_else(|| "Agent Chat conversation does not exist".to_owned())?;
    if session.project_id != request.project_id {
        return Err("Agent Chat conversation belongs to another project".to_owned());
    }

    match request.kind {
        LocalCodexChatActorSelectionKind::All | LocalCodexChatActorSelectionKind::Primary => {
            if request.runtime_operation_id.is_some() || request.actor_id.is_some() {
                return Err("main Agent Chat selection cannot name a child".to_owned());
            }
        }
        LocalCodexChatActorSelectionKind::Subagent => validate_child_selection(state, &request)?,
    }

    let selection = StoredChatActorSelection {
        project_id: request.project_id,
        conversation_id: request.conversation_id,
        kind: request.kind,
        runtime_operation_id: request.runtime_operation_id,
        actor_id: request.actor_id,
    };
    let identity = blake3::hash(selection.conversation_id.as_bytes()).to_hex();
    let record_id = PersistenceRecordId(format!("{SELECTION_PREFIX}{identity}"));
    put_json(
        state,
        record_id.clone(),
        &selection,
        RevisionId(format!("rev:{}:selected", record_id.0)),
        RevisionExpectation::Any,
    )?;
    Ok(selection)
}

fn validate_child_selection<B>(
    state: &ServerStateService<B>,
    request: &LocalCodexChatActorSelectionRequest,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let operation_id = request
        .runtime_operation_id
        .as_deref()
        .ok_or_else(|| "child selection requires a runtime operation".to_owned())?;
    let actor_id = request
        .actor_id
        .as_deref()
        .ok_or_else(|| "child selection requires an actor id".to_owned())?;
    let directories =
        read_subagent_directories(state, &request.project_id, &request.conversation_id)?;
    if directories.iter().any(|directory| {
        directory.runtime_operation_id == operation_id
            && directory
                .subagents
                .iter()
                .any(|subagent| subagent.subagent_id == actor_id)
    }) {
        Ok(())
    } else {
        Err("selected child is not present in the durable directory".to_owned())
    }
}

pub(super) fn read_chat_actor_selection<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    conversation_id: &str,
) -> Result<StoredChatActorSelection, String>
where
    B: LocalStoreBackend,
{
    let identity = blake3::hash(conversation_id.as_bytes()).to_hex();
    let record_id = PersistenceRecordId(format!("{SELECTION_PREFIX}{identity}"));
    let stored = state
        .agent_sessions()
        .get(&record_id)
        .map_err(storage_error)?
        .map(|record| decode::<StoredChatActorSelection>(&record.payload.bytes))
        .transpose()?;
    Ok(stored
        .filter(|selection| {
            selection.project_id == project_id && selection.conversation_id == conversation_id
        })
        .unwrap_or_else(|| StoredChatActorSelection {
            project_id: project_id.to_owned(),
            conversation_id: conversation_id.to_owned(),
            kind: LocalCodexChatActorSelectionKind::All,
            runtime_operation_id: None,
            actor_id: None,
        }))
}
