//! Persistence for completion SCM capture-preparation records.

use nucleus_local_store::{LocalStoreBackend, LocalStoreResult};

mod diagnostics;
mod helpers;
mod record_builder;
mod store;
mod types;

pub use diagnostics::completion_scm_capture_preparation_diagnostics_from_persisted_records;
pub use types::{
    CompletionScmCapturePreparationPersistenceBlocker,
    CompletionScmCapturePreparationPersistenceInput,
    CompletionScmCapturePreparationPersistenceRecord,
    CompletionScmCapturePreparationPersistenceStatus,
};

use crate::ServerStateService;
use record_builder::{persisted_preparation_id, persistence_record};
use store::{decode_preparation_record, write_preparation_record, PREPARATION_PREFIX};

pub fn persist_completion_scm_capture_preparation<B>(
    state: &ServerStateService<B>,
    input: CompletionScmCapturePreparationPersistenceInput,
) -> LocalStoreResult<CompletionScmCapturePreparationPersistenceRecord>
where
    B: LocalStoreBackend,
{
    let persisted_preparation_id = persisted_preparation_id(&input.plan_item.plan_item_id);
    if input
        .existing_preparation_ids
        .contains(&persisted_preparation_id)
    {
        return Ok(persistence_record(
            input,
            persisted_preparation_id,
            CompletionScmCapturePreparationPersistenceStatus::DuplicateNoop,
            Vec::new(),
            true,
        ));
    }

    let blockers = blockers(&input);
    let status = if blockers.is_empty() {
        CompletionScmCapturePreparationPersistenceStatus::Persisted
    } else {
        CompletionScmCapturePreparationPersistenceStatus::Blocked
    };
    let record = persistence_record(input, persisted_preparation_id, status, blockers, false);

    if record.status == CompletionScmCapturePreparationPersistenceStatus::Persisted {
        write_preparation_record(state, &record)?;
    }

    Ok(record)
}

pub fn read_completion_scm_capture_preparations<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<CompletionScmCapturePreparationPersistenceRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(PREPARATION_PREFIX))
        .map(|record| decode_preparation_record(&record.payload.bytes))
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| {
        left.persisted_preparation_id
            .cmp(&right.persisted_preparation_id)
    });
    Ok(records)
}

fn blockers(
    input: &CompletionScmCapturePreparationPersistenceInput,
) -> Vec<CompletionScmCapturePreparationPersistenceBlocker> {
    let mut blockers = Vec::new();
    if input.evidence_refs.is_empty() {
        blockers.push(CompletionScmCapturePreparationPersistenceBlocker::MissingEvidenceRef);
    }
    if input.raw_material_present {
        blockers.push(CompletionScmCapturePreparationPersistenceBlocker::RawMaterialPresent);
    }
    if input.scm_capture_requested {
        blockers.push(CompletionScmCapturePreparationPersistenceBlocker::ScmCaptureRequested);
    }
    if input.scm_publish_requested {
        blockers.push(CompletionScmCapturePreparationPersistenceBlocker::ScmPublishRequested);
    }
    if input.forge_change_request_requested {
        blockers
            .push(CompletionScmCapturePreparationPersistenceBlocker::ForgeChangeRequestRequested);
    }
    if input.forge_merge_requested {
        blockers.push(CompletionScmCapturePreparationPersistenceBlocker::ForgeMergeRequested);
    }
    if input.provider_write_requested {
        blockers.push(CompletionScmCapturePreparationPersistenceBlocker::ProviderWriteRequested);
    }
    if input.callback_response_requested {
        blockers.push(CompletionScmCapturePreparationPersistenceBlocker::CallbackResponseRequested);
    }
    if input.interruption_requested {
        blockers.push(CompletionScmCapturePreparationPersistenceBlocker::InterruptionRequested);
    }
    if input.recovery_requested {
        blockers.push(CompletionScmCapturePreparationPersistenceBlocker::RecoveryRequested);
    }
    blockers
}

#[cfg(test)]
mod tests;
