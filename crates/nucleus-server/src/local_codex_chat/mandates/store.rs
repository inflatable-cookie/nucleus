//! Workflow mandate persistence: read/find, writes, and shared helpers.
//!
//! Split from the mandates god file; behavior unchanged.

use std::time::{SystemTime, UNIX_EPOCH};

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreRecord, LocalStoreRecordPayload, RevisionExpectation,
};

use super::types::WorkflowMandate;
use crate::ServerStateService;

const MANDATE_PREFIX: &str = "conversation-goal-mandate:";

pub fn read_workflow_mandate<B>(
    state: &ServerStateService<B>,
    mandate_id: &str,
) -> Result<WorkflowMandate, String>
where
    B: LocalStoreBackend,
{
    find_workflow_mandate(state, mandate_id)?
        .ok_or_else(|| format!("workflow mandate not found: {mandate_id}"))
}

pub(crate) fn find_workflow_mandate<B>(
    state: &ServerStateService<B>,
    mandate_id: &str,
) -> Result<Option<WorkflowMandate>, String>
where
    B: LocalStoreBackend,
{
    state
        .agent_sessions()
        .get(&record_id(mandate_id))
        .map_err(storage_error)?
        .map(|record| {
            serde_json::from_slice(&record.payload.bytes).map_err(|error| error.to_string())
        })
        .transpose()
}

pub(super) fn put_mandate<B>(
    state: &ServerStateService<B>,
    mandate: &WorkflowMandate,
    expectation: RevisionExpectation,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let bytes = serde_json::to_vec(mandate).map_err(|error| error.to_string())?;
    state
        .agent_sessions()
        .put(
            LocalStoreRecord {
                revision_id: RevisionId(mandate.revision_id.clone()),
                id: record_id(&mandate.mandate_id),
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

pub(super) fn require_nonempty(label: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{label} must not be empty"))
    } else {
        Ok(())
    }
}

pub(super) fn now_epoch_seconds() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| "system clock is before the Unix epoch".to_owned())
}

fn record_id(mandate_id: &str) -> PersistenceRecordId {
    PersistenceRecordId(format!("{MANDATE_PREFIX}{mandate_id}"))
}

fn storage_error(error: impl std::fmt::Debug) -> String {
    format!("goal mandate persistence failed: {error:?}")
}
