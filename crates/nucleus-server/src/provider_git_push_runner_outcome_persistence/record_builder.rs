use super::helpers::unique_sorted;
use super::store::OUTCOME_PREFIX;
use super::types::{
    GitPushRunnerOutcomePersistenceBlocker, GitPushRunnerOutcomePersistenceInput,
    GitPushRunnerOutcomePersistenceRecord, GitPushRunnerOutcomePersistenceStatus,
    GitPushRunnerOutcomeStatus,
};
use crate::provider_no_effects::ForgeScmNoEffects;
use crate::{GitPushRunnerCommandAdapterRecord, GitPushRunnerCommandAdapterStatus};

pub(super) fn outcome_record(
    input: &GitPushRunnerOutcomePersistenceInput,
    command: GitPushRunnerCommandAdapterRecord,
    persisted_outcome_id: String,
    duplicate_outcome_detected: bool,
    persistence_blockers: Vec<GitPushRunnerOutcomePersistenceBlocker>,
) -> GitPushRunnerOutcomePersistenceRecord {
    let persistence_status = if duplicate_outcome_detected {
        GitPushRunnerOutcomePersistenceStatus::DuplicateNoop
    } else if persistence_blockers.is_empty() {
        GitPushRunnerOutcomePersistenceStatus::Persisted
    } else {
        GitPushRunnerOutcomePersistenceStatus::Blocked
    };
    let outcome_status = outcome_status(
        input.requested_status.clone(),
        &command.status,
        duplicate_outcome_detected,
    );

    GitPushRunnerOutcomePersistenceRecord {
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
        command_kind: command.command_kind,
        remote_target: command.remote_target,
        command_status: command.status,
        command_blockers: command.blockers,
        outcome_status,
        persistence_status,
        persistence_blockers,
        duplicate_outcome_detected,
        inspected_path_count: input.inspected_path_count,
        affected_path_count: input.affected_path_count,
        evidence_refs: unique_sorted(input.evidence_refs.clone()),
        push_requested: command.push_requested,
        shell_execution_performed: false,
        push_executed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

pub(super) fn persisted_outcome_id(command_id: &str) -> String {
    format!("{OUTCOME_PREFIX}{command_id}")
}

fn outcome_status(
    requested: GitPushRunnerOutcomeStatus,
    command_status: &GitPushRunnerCommandAdapterStatus,
    duplicate: bool,
) -> GitPushRunnerOutcomeStatus {
    if duplicate {
        return GitPushRunnerOutcomeStatus::DuplicateNoop;
    }

    match command_status {
        GitPushRunnerCommandAdapterStatus::Ready => requested,
        GitPushRunnerCommandAdapterStatus::Blocked => GitPushRunnerOutcomeStatus::Blocked,
        GitPushRunnerCommandAdapterStatus::RepairRequired => {
            GitPushRunnerOutcomeStatus::RepairRequired
        }
    }
}
