use super::helpers::unique_sorted;
use super::store::OUTCOME_PREFIX;
use super::types::{
    GitCommitRunnerOutcomePersistenceBlocker, GitCommitRunnerOutcomePersistenceInput,
    GitCommitRunnerOutcomePersistenceRecord, GitCommitRunnerOutcomePersistenceStatus,
    GitCommitRunnerOutcomeStatus,
};
use crate::{GitCommitRunnerCommandAdapterRecord, GitCommitRunnerCommandAdapterStatus};

pub(super) fn outcome_record(
    input: &GitCommitRunnerOutcomePersistenceInput,
    command: GitCommitRunnerCommandAdapterRecord,
    persisted_outcome_id: String,
    duplicate_outcome_detected: bool,
    persistence_blockers: Vec<GitCommitRunnerOutcomePersistenceBlocker>,
) -> GitCommitRunnerOutcomePersistenceRecord {
    let persistence_status = if duplicate_outcome_detected {
        GitCommitRunnerOutcomePersistenceStatus::DuplicateNoop
    } else if persistence_blockers.is_empty() {
        GitCommitRunnerOutcomePersistenceStatus::Persisted
    } else {
        GitCommitRunnerOutcomePersistenceStatus::Blocked
    };
    let outcome_status = outcome_status(
        input.requested_status.clone(),
        &command.status,
        duplicate_outcome_detected,
    );

    GitCommitRunnerOutcomePersistenceRecord {
        persisted_outcome_id,
        command_id: command.command_id,
        authority_id: command.authority_id,
        preflight_id: command.preflight_id,
        descriptor_id: command.descriptor_id,
        admission_id: command.admission_id,
        request_id: command.request_id,
        upstream_authority_id: command.upstream_authority_id,
        git_plan_id: command.git_plan_id,
        task_id: command.task_id,
        repo_id: command.repo_id,
        operator_ref: command.operator_ref,
        operator_confirmation_ref: command.operator_confirmation_ref,
        worktree_mode: command.worktree_mode,
        command_kind: command.command_kind,
        commit_message_source: command.commit_message_source,
        commit_message_ref: command.commit_message_ref,
        command_status: command.status,
        command_blockers: command.blockers,
        outcome_status,
        persistence_status,
        persistence_blockers,
        duplicate_outcome_detected,
        inspected_path_count: input.inspected_path_count,
        affected_path_count: input.affected_path_count,
        evidence_refs: unique_sorted(input.evidence_refs.clone()),
        commit_creation_requested: command.commit_creation_requested,
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
    }
}

pub(super) fn persisted_outcome_id(command_id: &str) -> String {
    format!("{OUTCOME_PREFIX}{command_id}")
}

fn outcome_status(
    requested: GitCommitRunnerOutcomeStatus,
    command_status: &GitCommitRunnerCommandAdapterStatus,
    duplicate: bool,
) -> GitCommitRunnerOutcomeStatus {
    if duplicate {
        return GitCommitRunnerOutcomeStatus::DuplicateNoop;
    }

    match command_status {
        GitCommitRunnerCommandAdapterStatus::Ready => requested,
        GitCommitRunnerCommandAdapterStatus::Blocked => GitCommitRunnerOutcomeStatus::Blocked,
        GitCommitRunnerCommandAdapterStatus::RepairRequired => {
            GitCommitRunnerOutcomeStatus::RepairRequired
        }
    }
}
