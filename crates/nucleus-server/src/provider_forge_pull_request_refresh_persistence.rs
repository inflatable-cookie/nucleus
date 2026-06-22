//! Persistence and control for stopped provider pull-request refreshes.

use nucleus_local_store::{LocalStoreBackend, LocalStoreResult};

mod blockers;
mod diagnostics;
mod record_builder;
mod store;
mod types;

pub use diagnostics::{
    forge_pull_request_refresh_control_dto_from_diagnostics,
    forge_pull_request_refresh_diagnostics_from_persisted_records,
};
pub use types::{
    ForgePullRequestRefreshPersistenceBlocker, ForgePullRequestRefreshPersistenceControlDto,
    ForgePullRequestRefreshPersistenceDiagnostics, ForgePullRequestRefreshPersistenceInput,
    ForgePullRequestRefreshPersistenceRecord, ForgePullRequestRefreshPersistenceSet,
    ForgePullRequestRefreshPersistenceStatus,
};

use blockers::persistence_blockers;
use record_builder::{persisted_refresh_id, persistence_record};
use store::{decode_refresh_record, write_refresh_record, REFRESH_PREFIX};

use crate::ServerStateService;

pub fn persist_forge_pull_request_refreshes<B>(
    state: &ServerStateService<B>,
    input: ForgePullRequestRefreshPersistenceInput,
) -> LocalStoreResult<ForgePullRequestRefreshPersistenceSet>
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
                persistence_blockers(&input)
            };
            persistence_record(&input, refresh, persisted_refresh_id, duplicate, blockers)
        })
        .collect::<Vec<_>>();

    for record in records.iter().filter(|record| {
        record.persistence_status == ForgePullRequestRefreshPersistenceStatus::Persisted
            && !record.duplicate_refresh_detected
    }) {
        write_refresh_record(state, record)?;
    }

    Ok(ForgePullRequestRefreshPersistenceSet {
        persistence_set_id: format!(
            "forge-pull-request-refresh-persistence:{}",
            input.refresh_set.refresh_set_id
        ),
        records,
        credential_resolution_performed: false,
        provider_network_call_performed: false,
        provider_effect_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    })
}

pub fn read_forge_pull_request_refreshes<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<ForgePullRequestRefreshPersistenceRecord>>
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

#[cfg(test)]
mod tests;
