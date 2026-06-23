use nucleus_local_store::SqliteBackend;
use nucleus_server::{
    replay_approved_provider_live_read_smoke_evidence,
    ProviderLiveReadApprovedSmokeEvidencePersistenceStatus,
};

use crate::cli::ProviderLiveReadSmokeEvidenceCommand;

pub(crate) fn print_provider_live_read_smoke_evidence(
    state: &nucleus_server::ServerStateService<SqliteBackend>,
    command: ProviderLiveReadSmokeEvidenceCommand,
) -> Result<(), String> {
    match command {
        ProviderLiveReadSmokeEvidenceCommand::ReplayApproved => {
            let set = replay_approved_provider_live_read_smoke_evidence(state)
                .map_err(|error| format!("failed to replay approved smoke evidence: {error:?}"))?;
            println!("domain=provider-live-read-smoke-evidence");
            println!("action=replay-approved");
            println!("records={}", set.records.len());
            println!(
                "persisted={}",
                set.records
                    .iter()
                    .filter(|record| {
                        record.persistence_status
                            == ProviderLiveReadApprovedSmokeEvidencePersistenceStatus::Persisted
                    })
                    .count()
            );
            println!(
                "duplicate_noop={}",
                set.records
                    .iter()
                    .filter(|record| {
                        record.persistence_status
                            == ProviderLiveReadApprovedSmokeEvidencePersistenceStatus::DuplicateNoop
                    })
                    .count()
            );
            println!("provider_write_executed=false");
            println!("raw_provider_payload_retained=false");
            Ok(())
        }
    }
}
