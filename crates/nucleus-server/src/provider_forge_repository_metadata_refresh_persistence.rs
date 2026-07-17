//! Persistence and control for stopped provider repository metadata refreshes.

use crate::provider_no_effects::ProviderRuntimeNoEffects;
use nucleus_local_store::{LocalStoreBackend, LocalStoreResult};

mod diagnostics;
mod record_builder;
mod store;
mod types;

pub use diagnostics::{
    forge_repository_metadata_refresh_control_dto_from_diagnostics,
    forge_repository_metadata_refresh_diagnostics_from_persisted_records,
};
pub use types::{
    ForgeRepositoryMetadataRefreshPersistenceBlocker,
    ForgeRepositoryMetadataRefreshPersistenceControlDto,
    ForgeRepositoryMetadataRefreshPersistenceDiagnostics,
    ForgeRepositoryMetadataRefreshPersistenceInput,
    ForgeRepositoryMetadataRefreshPersistenceRecord, ForgeRepositoryMetadataRefreshPersistenceSet,
    ForgeRepositoryMetadataRefreshPersistenceStatus,
};

use crate::ServerStateService;
use record_builder::{persisted_refresh_id, persistence_record};
use store::{decode_refresh_record, write_refresh_record, REFRESH_PREFIX};
use types::ForgeRepositoryMetadataRefreshPersistenceBlocker as Blocker;

pub fn persist_forge_repository_metadata_refreshes<B>(
    state: &ServerStateService<B>,
    input: ForgeRepositoryMetadataRefreshPersistenceInput,
) -> LocalStoreResult<ForgeRepositoryMetadataRefreshPersistenceSet>
where
    B: LocalStoreBackend,
{
    let records = input
        .refresh_set
        .records
        .clone()
        .into_iter()
        .map(|refresh| {
            let persisted_refresh_id = persisted_refresh_id(&refresh.refresh_id);
            let duplicate = input
                .existing_persisted_refresh_ids
                .contains(&persisted_refresh_id);
            let blockers = if duplicate {
                Vec::new()
            } else {
                blockers(&input)
            };
            persistence_record(&input, refresh, persisted_refresh_id, duplicate, blockers)
        })
        .collect::<Vec<_>>();

    for record in records.iter().filter(|record| {
        record.persistence_status == ForgeRepositoryMetadataRefreshPersistenceStatus::Persisted
            && !record.duplicate_refresh_detected
    }) {
        write_refresh_record(state, record)?;
    }

    Ok(ForgeRepositoryMetadataRefreshPersistenceSet {
        persistence_set_id: format!(
            "forge-repository-metadata-refresh-persistence:{}",
            input.refresh_set.refresh_set_id
        ),
        records,
        no_effects: ProviderRuntimeNoEffects::none(),
    })
}

pub fn read_forge_repository_metadata_refreshes<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<ForgeRepositoryMetadataRefreshPersistenceRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(REFRESH_PREFIX))
        .map(|record| decode_refresh_record(&record.payload.bytes))
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| left.persisted_refresh_id.cmp(&right.persisted_refresh_id));
    Ok(records)
}

fn blockers(input: &ForgeRepositoryMetadataRefreshPersistenceInput) -> Vec<Blocker> {
    let mut blockers = Vec::new();
    if input.evidence_refs.is_empty() {
        blockers.push(Blocker::MissingEvidenceRef);
    }
    if input.credential_material_present {
        blockers.push(Blocker::CredentialMaterialPresent);
    }
    if input.provider_payload_present {
        blockers.push(Blocker::ProviderPayloadPresent);
    }
    if input.raw_provider_payload_retention_requested {
        blockers.push(Blocker::RawProviderPayloadRetentionRequested);
    }
    if input.real_credential_resolution_requested {
        blockers.push(Blocker::RealCredentialResolutionRequested);
    }
    if input.provider_network_call_requested {
        blockers.push(Blocker::ProviderNetworkCallRequested);
    }
    if input.callback_execution_requested {
        blockers.push(Blocker::CallbackExecutionRequested);
    }
    if input.interruption_execution_requested {
        blockers.push(Blocker::InterruptionExecutionRequested);
    }
    if input.recovery_execution_requested {
        blockers.push(Blocker::RecoveryExecutionRequested);
    }
    if input.task_mutation_requested {
        blockers.push(Blocker::TaskMutationRequested);
    }
    blockers
}

#[cfg(test)]
mod tests;
