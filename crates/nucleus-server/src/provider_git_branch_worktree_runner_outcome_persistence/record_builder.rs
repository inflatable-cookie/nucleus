use crate::provider_no_effects::{ForgeScmNoEffects};
use super::helpers::unique_sorted;
use super::store::OUTCOME_PREFIX;
use super::types::{
    GitBranchWorktreeRunnerOutcomePersistenceBlocker,
    GitBranchWorktreeRunnerOutcomePersistenceInput,
    GitBranchWorktreeRunnerOutcomePersistenceRecord,
    GitBranchWorktreeRunnerOutcomePersistenceStatus, GitBranchWorktreeRunnerOutcomeStatus,
};
use crate::{
    GitBranchWorktreeRunnerCommandAdapterRecord, GitBranchWorktreeRunnerCommandAdapterStatus,
};

pub(super) fn outcome_record(
    input: &GitBranchWorktreeRunnerOutcomePersistenceInput,
    command: GitBranchWorktreeRunnerCommandAdapterRecord,
    persisted_outcome_id: String,
    duplicate_outcome_detected: bool,
    persistence_blockers: Vec<GitBranchWorktreeRunnerOutcomePersistenceBlocker>,
) -> GitBranchWorktreeRunnerOutcomePersistenceRecord {
    let persistence_status = if duplicate_outcome_detected {
        GitBranchWorktreeRunnerOutcomePersistenceStatus::DuplicateNoop
    } else if persistence_blockers.is_empty() {
        GitBranchWorktreeRunnerOutcomePersistenceStatus::Persisted
    } else {
        GitBranchWorktreeRunnerOutcomePersistenceStatus::Blocked
    };
    let outcome_status = outcome_status(
        input.requested_status.clone(),
        &command.status,
        duplicate_outcome_detected,
    );

    GitBranchWorktreeRunnerOutcomePersistenceRecord {
        persisted_outcome_id,
        command_id: command.command_id,
        authority_id: command.authority_id,
        handoff_id: command.handoff_id,
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
        branch_ref: command.branch_ref,
        worktree_location_ref: command.worktree_location_ref,
        command_status: command.status,
        command_blockers: command.blockers,
        outcome_status,
        persistence_status,
        persistence_blockers,
        duplicate_outcome_detected,
        inspected_path_count: input.inspected_path_count,
        affected_path_count: input.affected_path_count,
        evidence_refs: unique_sorted(input.evidence_refs.clone()),
        checkout_requested: command.checkout_requested,
        branch_creation_requested: command.branch_creation_requested,
        worktree_creation_requested: command.worktree_creation_requested,
        shell_execution_performed: false,
        checkout_executed: false,
        branch_created: false,
        worktree_created: false,
        commit_created: false,
        push_executed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

pub(super) fn persisted_outcome_id(command_id: &str) -> String {
    format!("{OUTCOME_PREFIX}{command_id}")
}

fn outcome_status(
    requested: GitBranchWorktreeRunnerOutcomeStatus,
    command_status: &GitBranchWorktreeRunnerCommandAdapterStatus,
    duplicate: bool,
) -> GitBranchWorktreeRunnerOutcomeStatus {
    if duplicate {
        return GitBranchWorktreeRunnerOutcomeStatus::DuplicateNoop;
    }

    match command_status {
        GitBranchWorktreeRunnerCommandAdapterStatus::Ready => requested,
        GitBranchWorktreeRunnerCommandAdapterStatus::Blocked => {
            GitBranchWorktreeRunnerOutcomeStatus::Blocked
        }
        GitBranchWorktreeRunnerCommandAdapterStatus::RepairRequired => {
            GitBranchWorktreeRunnerOutcomeStatus::RepairRequired
        }
    }
}
