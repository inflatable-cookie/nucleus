//! Persistence for SCM capture dry-run execution receipts.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreRecord, LocalStoreResult, RevisionExpectation,
};

use crate::ServerStateService;

mod diagnostics;
mod helpers;
mod types;

pub use diagnostics::scm_capture_dry_run_execution_diagnostics_from_persisted_records;
use helpers::{
    blockers, is_scm_capture_dry_run_execution_record, json_error, json_payload,
    persisted_execution_receipt_id, persistence_record,
};
pub use types::{
    ScmCaptureDryRunExecutionDiagnosticsRecord, ScmCaptureDryRunExecutionPersistenceBlocker,
    ScmCaptureDryRunExecutionPersistenceInput, ScmCaptureDryRunExecutionPersistenceRecord,
    ScmCaptureDryRunExecutionPersistenceStatus,
};

pub fn persist_scm_capture_dry_run_execution_receipt<B>(
    state: &ServerStateService<B>,
    input: ScmCaptureDryRunExecutionPersistenceInput,
) -> LocalStoreResult<ScmCaptureDryRunExecutionPersistenceRecord>
where
    B: LocalStoreBackend,
{
    let persisted_execution_receipt_id = persisted_execution_receipt_id(&input.receipt.receipt_id);
    if input
        .existing_execution_receipt_ids
        .contains(&persisted_execution_receipt_id)
    {
        return Ok(persistence_record(
            input,
            persisted_execution_receipt_id,
            ScmCaptureDryRunExecutionPersistenceStatus::DuplicateNoop,
            Vec::new(),
            true,
        ));
    }

    let blockers = blockers(&input);
    let status = if blockers.is_empty() {
        ScmCaptureDryRunExecutionPersistenceStatus::Persisted
    } else {
        ScmCaptureDryRunExecutionPersistenceStatus::Blocked
    };
    let record = persistence_record(
        input,
        persisted_execution_receipt_id,
        status,
        blockers,
        false,
    );

    if record.persistence_status == ScmCaptureDryRunExecutionPersistenceStatus::Persisted {
        state.artifact_metadata().put(
            LocalStoreRecord {
                id: PersistenceRecordId(record.persisted_execution_receipt_id.clone()),
                domain: PersistenceDomain::ArtifactMetadata,
                kind: PersistenceRecordKind::ArtifactMetadata,
                revision_id: RevisionId(format!("rev:{}", record.persisted_execution_receipt_id)),
                payload: json_payload(serde_json::to_vec(&record).map_err(json_error)?),
            },
            RevisionExpectation::MustNotExist,
        )?;
    }

    Ok(record)
}

pub fn read_scm_capture_dry_run_execution_receipts<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<ScmCaptureDryRunExecutionPersistenceRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(is_scm_capture_dry_run_execution_record)
        .map(|record| {
            serde_json::from_slice::<ScmCaptureDryRunExecutionPersistenceRecord>(
                &record.payload.bytes,
            )
            .map_err(json_error)
        })
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| {
        left.persisted_execution_receipt_id
            .cmp(&right.persisted_execution_receipt_id)
    });
    Ok(records)
}

#[cfg(test)]
#[path = "provider_scm_capture_dry_run_execution_persistence/tests.rs"]
mod tests;
