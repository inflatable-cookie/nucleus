//! Explicit replay for approved provider live-read smoke evidence.

use nucleus_local_store::{LocalStoreBackend, LocalStoreResult};

use crate::{
    persist_provider_live_read_approved_smoke_evidence_records,
    provider_live_read_smoke_evidence_query::approved_provider_live_read_smoke_evidence_fixture,
    read_provider_live_read_approved_smoke_evidence_records,
    ProviderLiveReadApprovedSmokeEvidencePersistenceInput,
    ProviderLiveReadApprovedSmokeEvidencePersistenceSet, ServerStateService,
};

pub fn replay_approved_provider_live_read_smoke_evidence<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<ProviderLiveReadApprovedSmokeEvidencePersistenceSet>
where
    B: LocalStoreBackend,
{
    let existing_persisted_evidence_ids =
        read_provider_live_read_approved_smoke_evidence_records(state)?
            .into_iter()
            .map(|record| record.persisted_evidence_id)
            .collect::<Vec<_>>();

    persist_provider_live_read_approved_smoke_evidence_records(
        state,
        ProviderLiveReadApprovedSmokeEvidencePersistenceInput {
            evidence_records: vec![approved_provider_live_read_smoke_evidence_fixture()],
            persistence_evidence_refs: vec![
                "evidence:provider-live-read-approved-smoke-evidence-replay".to_owned(),
            ],
            existing_persisted_evidence_ids,
            provider_write_executed: false,
            callback_effect_executed: false,
            interruption_effect_executed: false,
            recovery_effect_executed: false,
            task_mutation_executed: false,
            raw_provider_payload_retained: false,
        },
    )
}

#[cfg(test)]
mod tests {
    use nucleus_local_store::SqliteBackend;

    use super::*;
    use crate::{
        query_provider_live_read_smoke_evidence_diagnostics,
        ProviderLiveReadApprovedSmokeEvidencePersistenceStatus,
    };

    #[test]
    fn replay_persists_approved_smoke_evidence_once() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));

        let set = replay_approved_provider_live_read_smoke_evidence(&state).expect("replay");
        let diagnostics =
            query_provider_live_read_smoke_evidence_diagnostics(&state).expect("query");

        assert_eq!(set.records.len(), 1);
        assert_eq!(
            set.records[0].persistence_status,
            ProviderLiveReadApprovedSmokeEvidencePersistenceStatus::Persisted
        );
        assert_eq!(diagnostics.evidence_count, 1);
        assert_eq!(diagnostics.promoted_count, 1);
        assert!(!diagnostics.provider_write_executed);
        assert!(!diagnostics.raw_provider_payload_retained);
    }

    #[test]
    fn replay_duplicate_is_noop() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));

        replay_approved_provider_live_read_smoke_evidence(&state).expect("first replay");
        let duplicate =
            replay_approved_provider_live_read_smoke_evidence(&state).expect("duplicate replay");
        let diagnostics =
            query_provider_live_read_smoke_evidence_diagnostics(&state).expect("query");

        assert_eq!(
            duplicate.records[0].persistence_status,
            ProviderLiveReadApprovedSmokeEvidencePersistenceStatus::DuplicateNoop
        );
        assert!(duplicate.records[0].duplicate_evidence_detected);
        assert_eq!(diagnostics.evidence_count, 1);
    }
}
