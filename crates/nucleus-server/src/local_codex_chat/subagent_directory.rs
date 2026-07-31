use std::collections::HashMap;

use nucleus_agent_protocol::AgentActivityEvent;
use nucleus_core::{PersistenceRecordId, RevisionId};
use nucleus_local_store::{LocalStoreBackend, RevisionExpectation};
use serde::{Deserialize, Serialize};
use swallowtail_runtime::{
    ActivityOperationId, SubagentDirectoryProjection, SubagentParent, SubagentSnapshot,
    SubagentStatus,
};

use super::persistence::{decode, put_json, storage_error, StoredChatSubagent};
use crate::ServerStateService;

const DIRECTORY_PREFIX: &str = "product-chat-subagent-directory:";
const MAXIMUM_SUBAGENTS_PER_OPERATION: usize = 256;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredChatSubagentDirectory {
    pub project_id: String,
    pub conversation_id: String,
    pub turn_id: String,
    pub turn_ordinal: u64,
    pub runtime_operation_id: String,
    pub first_sequence: u64,
    pub last_sequence: u64,
    pub subagents: Vec<StoredChatSubagent>,
}

struct HeldDirectory {
    first_sequence: u64,
    projection: SubagentDirectoryProjection,
}

#[derive(Default)]
pub(super) struct ChatSubagentDirectories {
    held: HashMap<ActivityOperationId, HeldDirectory>,
}

impl ChatSubagentDirectories {
    pub fn observe(
        &mut self,
        project_id: &str,
        conversation_id: &str,
        turn_id: &str,
        turn_ordinal: u64,
        event: &AgentActivityEvent,
    ) -> Result<Option<StoredChatSubagentDirectory>, String> {
        let operation_id = event.observation.operation_id().clone();
        let held = match self.held.entry(operation_id.clone()) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::hash_map::Entry::Vacant(entry) => entry.insert(HeldDirectory {
                first_sequence: event.sequence,
                projection: SubagentDirectoryProjection::new(
                    operation_id,
                    MAXIMUM_SUBAGENTS_PER_OPERATION,
                )
                .map_err(|error| error.to_string())?,
            }),
        };
        let delta = held
            .projection
            .observe_activity(&event.observation)
            .map_err(|error| error.to_string())?;
        if delta.is_unchanged() {
            return Ok(None);
        }

        Ok(Some(StoredChatSubagentDirectory {
            project_id: project_id.to_owned(),
            conversation_id: conversation_id.to_owned(),
            turn_id: turn_id.to_owned(),
            turn_ordinal,
            runtime_operation_id: operation_id_string(held.projection.operation_id()),
            first_sequence: held.first_sequence,
            last_sequence: event.sequence,
            subagents: held
                .projection
                .subagents()
                .map(project_subagent_snapshot)
                .collect(),
        }))
    }
}

pub(super) fn persist_subagent_directory<B>(
    state: &ServerStateService<B>,
    directory: &StoredChatSubagentDirectory,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let identity = blake3::hash(
        format!(
            "{}\0{}",
            directory.conversation_id, directory.runtime_operation_id
        )
        .as_bytes(),
    )
    .to_hex();
    let record_id = PersistenceRecordId(format!("{DIRECTORY_PREFIX}{identity}"));
    put_json(
        state,
        record_id.clone(),
        directory,
        RevisionId(format!("rev:{}:{}", record_id.0, directory.last_sequence)),
        RevisionExpectation::Any,
    )
}

pub(super) fn read_subagent_directories<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    conversation_id: &str,
) -> Result<Vec<StoredChatSubagentDirectory>, String>
where
    B: LocalStoreBackend,
{
    let mut directories = state
        .agent_sessions()
        .list()
        .map_err(storage_error)?
        .into_iter()
        .filter(|record| record.id.0.starts_with(DIRECTORY_PREFIX))
        .map(|record| decode::<StoredChatSubagentDirectory>(&record.payload.bytes))
        .collect::<Result<Vec<_>, _>>()?;
    directories.retain(|directory| {
        directory.project_id == project_id && directory.conversation_id == conversation_id
    });
    directories.sort_by_key(|directory| (directory.turn_ordinal, directory.first_sequence));
    Ok(directories)
}

pub(super) fn operation_id_string(operation_id: &ActivityOperationId) -> String {
    match operation_id {
        ActivityOperationId::Run(id) => format!("run:{}", id.as_str()),
        ActivityOperationId::Turn(id) => format!("turn:{}", id.as_str()),
    }
}

pub(super) fn project_subagent_snapshot(snapshot: &SubagentSnapshot) -> StoredChatSubagent {
    let (parent_kind, parent_id) = match snapshot.parent() {
        SubagentParent::Operation => ("operation".to_owned(), None),
        SubagentParent::Subagent(id) => ("subagent".to_owned(), Some(id.as_str().to_owned())),
        SubagentParent::Unknown => ("unknown".to_owned(), None),
    };
    StoredChatSubagent {
        subagent_id: snapshot.id().as_str().to_owned(),
        parent_kind,
        parent_id,
        status: match snapshot.status() {
            SubagentStatus::Unknown => "unknown",
            SubagentStatus::Pending => "pending",
            SubagentStatus::Running => "running",
            SubagentStatus::Waiting => "waiting",
            SubagentStatus::Completed => "completed",
            SubagentStatus::Failed => "failed",
            SubagentStatus::Interrupted => "interrupted",
            SubagentStatus::Shutdown => "shutdown",
        }
        .to_owned(),
        label: snapshot.label().map(|label| label.as_str().to_owned()),
        description: snapshot
            .description()
            .map(|description| description.as_str().to_owned()),
        model: snapshot.model().map(|model| model.as_str().to_owned()),
        reasoning: snapshot
            .reasoning()
            .map(|reasoning| reasoning.as_str().to_owned()),
        background: snapshot.background(),
        originating_activity_ref: snapshot
            .originating_activity()
            .map(|reference| reference.as_provider_value().to_owned()),
    }
}

#[cfg(test)]
#[path = "subagent_directory_tests.rs"]
mod tests;
