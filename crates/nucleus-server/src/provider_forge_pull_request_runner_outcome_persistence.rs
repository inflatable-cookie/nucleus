//! Persistence for sanitized stopped forge pull-request runner outcomes.

use crate::provider_no_effects::{ForgeScmNoEffects};
use nucleus_local_store::{LocalStoreBackend, LocalStoreResult};

mod diagnostics;
mod helpers;
mod record_builder;
mod store;
mod types;

pub use diagnostics::forge_pull_request_runner_outcome_diagnostics_from_persisted_records;
pub use types::{
    ForgePullRequestRunnerOutcomeDiagnosticsRecord,
    ForgePullRequestRunnerOutcomePersistenceBlocker, ForgePullRequestRunnerOutcomePersistenceInput,
    ForgePullRequestRunnerOutcomePersistenceRecord, ForgePullRequestRunnerOutcomePersistenceSet,
    ForgePullRequestRunnerOutcomePersistenceStatus, ForgePullRequestRunnerOutcomeStatus,
};

use crate::ServerStateService;
use record_builder::{outcome_record, persisted_outcome_id};
use store::{decode_outcome_record, write_outcome_record, OUTCOME_PREFIX};
use types::ForgePullRequestRunnerOutcomePersistenceBlocker as Blocker;

pub fn persist_forge_pull_request_runner_outcomes<B>(
    state: &ServerStateService<B>,
    input: ForgePullRequestRunnerOutcomePersistenceInput,
) -> LocalStoreResult<ForgePullRequestRunnerOutcomePersistenceSet>
where
    B: LocalStoreBackend,
{
    let records = input
        .requests
        .requests
        .clone()
        .into_iter()
        .map(|request| {
            let persisted_outcome_id = persisted_outcome_id(&request.request_adapter_id);
            let duplicate = input.existing_outcome_ids.contains(&persisted_outcome_id);
            let blockers = if duplicate {
                Vec::new()
            } else {
                blockers(&input)
            };
            outcome_record(&input, request, persisted_outcome_id, duplicate, blockers)
        })
        .collect::<Vec<_>>();

    for record in records.iter().filter(|record| {
        record.persistence_status == ForgePullRequestRunnerOutcomePersistenceStatus::Persisted
            && !record.duplicate_outcome_detected
    }) {
        write_outcome_record(state, record)?;
    }

    Ok(ForgePullRequestRunnerOutcomePersistenceSet {
        outcome_set_id: format!(
            "forge-pull-request-runner-outcomes:{}",
            input.requests.request_set_id
        ),
        records,
        shell_execution_performed: false,
        no_effects: ForgeScmNoEffects::none(),
    })
}

pub fn read_forge_pull_request_runner_outcomes<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<ForgePullRequestRunnerOutcomePersistenceRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(OUTCOME_PREFIX))
        .map(|record| decode_outcome_record(&record.payload.bytes))
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| left.persisted_outcome_id.cmp(&right.persisted_outcome_id));
    Ok(records)
}

fn blockers(input: &ForgePullRequestRunnerOutcomePersistenceInput) -> Vec<Blocker> {
    let mut blockers = Vec::new();
    if input.evidence_refs.is_empty() {
        blockers.push(Blocker::MissingEvidenceRef);
    }
    if input.raw_stdout_present {
        blockers.push(Blocker::RawStdoutPresent);
    }
    if input.raw_stderr_present {
        blockers.push(Blocker::RawStderrPresent);
    }
    if input.raw_title_present {
        blockers.push(Blocker::RawTitlePresent);
    }
    if input.raw_body_present {
        blockers.push(Blocker::RawBodyPresent);
    }
    if input.provider_payload_present {
        blockers.push(Blocker::ProviderPayloadPresent);
    }
    if input.raw_output_retention_requested {
        blockers.push(Blocker::RawOutputRetentionRequested);
    }
    if input.pull_request_creation_requested {
        blockers.push(Blocker::PullRequestCreationRequested);
    }
    if input.forge_effect_requested {
        blockers.push(Blocker::ForgeEffectRequested);
    }
    if input.provider_effect_requested {
        blockers.push(Blocker::ProviderEffectRequested);
    }
    if input.callback_effect_requested {
        blockers.push(Blocker::CallbackEffectRequested);
    }
    if input.interruption_effect_requested {
        blockers.push(Blocker::InterruptionEffectRequested);
    }
    if input.recovery_effect_requested {
        blockers.push(Blocker::RecoveryEffectRequested);
    }
    if input.task_mutation_requested {
        blockers.push(Blocker::TaskMutationRequested);
    }
    blockers
}

#[cfg(test)]
mod tests;
