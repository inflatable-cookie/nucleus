//! Persistence for sanitized Git branch/worktree runner outcome records.

use crate::provider_no_effects::{ForgeScmNoEffects};
use nucleus_local_store::{LocalStoreBackend, LocalStoreResult};

mod diagnostics;
mod helpers;
mod record_builder;
mod store;
mod types;

pub use diagnostics::git_branch_worktree_runner_outcome_diagnostics_from_persisted_records;
pub use types::{
    GitBranchWorktreeRunnerOutcomeDiagnosticsRecord,
    GitBranchWorktreeRunnerOutcomePersistenceBlocker,
    GitBranchWorktreeRunnerOutcomePersistenceInput,
    GitBranchWorktreeRunnerOutcomePersistenceRecord, GitBranchWorktreeRunnerOutcomePersistenceSet,
    GitBranchWorktreeRunnerOutcomePersistenceStatus, GitBranchWorktreeRunnerOutcomeStatus,
};

use crate::ServerStateService;
use record_builder::{outcome_record, persisted_outcome_id};
use store::{decode_outcome_record, write_outcome_record, OUTCOME_PREFIX};
use types::GitBranchWorktreeRunnerOutcomePersistenceBlocker as Blocker;

pub fn persist_git_branch_worktree_runner_outcomes<B>(
    state: &ServerStateService<B>,
    input: GitBranchWorktreeRunnerOutcomePersistenceInput,
) -> LocalStoreResult<GitBranchWorktreeRunnerOutcomePersistenceSet>
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
        record.persistence_status == GitBranchWorktreeRunnerOutcomePersistenceStatus::Persisted
            && !record.duplicate_outcome_detected
    }) {
        write_outcome_record(state, record)?;
    }

    Ok(GitBranchWorktreeRunnerOutcomePersistenceSet {
        outcome_set_id: format!(
            "git-branch-worktree-runner-outcomes:{}",
            input.commands.command_set_id
        ),
        records,
        shell_execution_performed: false,
        checkout_executed: false,
        branch_created: false,
        worktree_created: false,
        commit_created: false,
        push_executed: false,
        no_effects: ForgeScmNoEffects::none(),
    })
}

pub fn read_git_branch_worktree_runner_outcomes<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<GitBranchWorktreeRunnerOutcomePersistenceRecord>>
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

fn blockers(input: &GitBranchWorktreeRunnerOutcomePersistenceInput) -> Vec<Blocker> {
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
    if input.provider_payload_present {
        blockers.push(Blocker::ProviderPayloadPresent);
    }
    if input.raw_output_retention_requested {
        blockers.push(Blocker::RawOutputRetentionRequested);
    }
    if input.commit_requested {
        blockers.push(Blocker::CommitRequested);
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
