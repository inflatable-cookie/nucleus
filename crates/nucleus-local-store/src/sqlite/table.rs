//! SQLite table mapping, row decoding, and error translation.
//!
//! Split from the sqlite god file; behavior unchanged.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, RevisionId};

use super::kinds::kind_from_text;
use crate::errors::{LocalStoreError, LocalStoreResult};
use crate::repositories::{LocalStoreRecord, LocalStoreRecordPayload};

pub(super) const ALL_TABLES: &[&str] = &[
    "projects",
    "tasks",
    "task_history",
    "shared_memory",
    "planning",
    "deep_research",
    "workspace_layouts",
    "adapter_instances",
    "agent_sessions",
    "model_routes",
    "event_journal",
    "command_evidence",
    "artifact_metadata",
    "runtime_effects",
    "orchestration_runs",
];

pub(super) fn table_for_domain(domain: &PersistenceDomain) -> LocalStoreResult<&'static str> {
    match domain {
        PersistenceDomain::Projects => Ok("projects"),
        PersistenceDomain::Tasks => Ok("tasks"),
        PersistenceDomain::TaskHistory => Ok("task_history"),
        PersistenceDomain::SharedMemory => Ok("shared_memory"),
        PersistenceDomain::Planning => Ok("planning"),
        PersistenceDomain::DeepResearch => Ok("deep_research"),
        PersistenceDomain::Workspaces => Ok("workspace_layouts"),
        PersistenceDomain::AdapterRegistry => Ok("adapter_instances"),
        PersistenceDomain::AgentSessions => Ok("agent_sessions"),
        PersistenceDomain::ModelRoutes => Ok("model_routes"),
        PersistenceDomain::EventJournal => Ok("event_journal"),
        PersistenceDomain::CommandEvidence => Ok("command_evidence"),
        PersistenceDomain::ArtifactMetadata => Ok("artifact_metadata"),
        PersistenceDomain::RuntimeEffects => Ok("runtime_effects"),
        PersistenceDomain::OrchestrationRuns => Ok("orchestration_runs"),
        other => Err(LocalStoreError::UnsupportedDomain {
            domain: other.clone(),
        }),
    }
}

pub(super) fn row_to_record(
    row: &rusqlite::Row<'_>,
    domain: &PersistenceDomain,
) -> rusqlite::Result<crate::errors::LocalStoreResult<LocalStoreRecord>> {
    let id: String = row.get(0)?;
    let kind: String = row.get(1)?;
    let revision_id: String = row.get(2)?;
    let media_type: Option<String> = row.get(3)?;
    let bytes: Vec<u8> = row.get(4)?;
    Ok(kind_from_text(&kind).map(|kind| LocalStoreRecord {
        id: PersistenceRecordId(id),
        domain: domain.clone(),
        kind,
        revision_id: RevisionId(revision_id),
        payload: LocalStoreRecordPayload { media_type, bytes },
    }))
}

pub(super) fn sqlite_error(error: rusqlite::Error) -> LocalStoreError {
    if let rusqlite::Error::SqliteFailure(failure, _) = &error {
        if matches!(
            failure.code,
            rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
        ) {
            return LocalStoreError::BackendBusy {
                reason: error.to_string(),
            };
        }
    }
    LocalStoreError::BackendRejected {
        reason: error.to_string(),
    }
}
