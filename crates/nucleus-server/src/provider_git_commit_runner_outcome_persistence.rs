//! Persistence for sanitized Git commit runner outcome records.

use nucleus_local_store::{LocalStoreBackend, LocalStoreResult};

mod diagnostics;
mod helpers;
mod record_builder;
mod store;
mod types;

pub use diagnostics::git_commit_runner_outcome_diagnostics_from_persisted_records;
pub use types::{
    GitCommitRunnerOutcomeDiagnosticsRecord, GitCommitRunnerOutcomePersistenceBlocker,
    GitCommitRunnerOutcomePersistenceInput, GitCommitRunnerOutcomePersistenceRecord,
    GitCommitRunnerOutcomePersistenceSet, GitCommitRunnerOutcomePersistenceStatus,
    GitCommitRunnerOutcomeStatus,
};

use crate::ServerStateService;
use record_builder::{outcome_record, persisted_outcome_id};
use store::{decode_outcome_record, write_outcome_record, OUTCOME_PREFIX};
use types::GitCommitRunnerOutcomePersistenceBlocker as Blocker;

pub fn persist_git_commit_runner_outcomes<B>(
    state: &ServerStateService<B>,
    input: GitCommitRunnerOutcomePersistenceInput,
) -> LocalStoreResult<GitCommitRunnerOutcomePersistenceSet>
where
    B: LocalStoreBackend,
{
    let records = input
        .commands
        .commands
        .clone()
        .into_iter()
        .map(|command| {
            let persisted_outcome_id = persisted_outcome_id(&command.command_id);
            let duplicate = input.existing_outcome_ids.contains(&persisted_outcome_id);
            let blockers = if duplicate {
                Vec::new()
            } else {
                blockers(&input)
            };
            outcome_record(&input, command, persisted_outcome_id, duplicate, blockers)
        })
        .collect::<Vec<_>>();

    for record in records.iter().filter(|record| {
        record.persistence_status == GitCommitRunnerOutcomePersistenceStatus::Persisted
            && !record.duplicate_outcome_detected
    }) {
        write_outcome_record(state, record)?;
    }

    Ok(GitCommitRunnerOutcomePersistenceSet {
        outcome_set_id: format!(
            "git-commit-runner-outcomes:{}",
            input.commands.command_set_id
        ),
        records,
        shell_execution_performed: false,
        commit_created: false,
        push_executed: false,
        pull_request_created: false,
        forge_effect_executed: false,
        provider_effect_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_output_retained: false,
    })
}

pub fn read_git_commit_runner_outcomes<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<GitCommitRunnerOutcomePersistenceRecord>>
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

fn blockers(input: &GitCommitRunnerOutcomePersistenceInput) -> Vec<Blocker> {
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
    if input.raw_commit_message_present {
        blockers.push(Blocker::RawCommitMessagePresent);
    }
    if input.provider_payload_present {
        blockers.push(Blocker::ProviderPayloadPresent);
    }
    if input.raw_output_retention_requested {
        blockers.push(Blocker::RawOutputRetentionRequested);
    }
    if input.push_requested {
        blockers.push(Blocker::PushRequested);
    }
    if input.pull_request_requested {
        blockers.push(Blocker::PullRequestRequested);
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
