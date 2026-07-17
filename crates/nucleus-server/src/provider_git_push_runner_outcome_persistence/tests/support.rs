use crate::provider_no_effects::{ForgeScmNoEffects};
use std::path::PathBuf;

use super::super::*;
use crate::{
    GitPushRemoteTarget, GitPushRunnerCommandAdapterBlocker, GitPushRunnerCommandAdapterRecord,
    GitPushRunnerCommandAdapterSet, GitPushRunnerCommandAdapterStatus, GitPushRunnerCommandKind,
    ServerStateService,
};
use nucleus_local_store::SqliteBackend;

pub(super) fn test_state(path: PathBuf) -> ServerStateService<SqliteBackend> {
    ServerStateService::new(SqliteBackend::new(path))
}

pub(super) fn input(
    commands: GitPushRunnerCommandAdapterSet,
    requested_status: GitPushRunnerOutcomeStatus,
    forbidden: bool,
) -> GitPushRunnerOutcomePersistenceInput {
    GitPushRunnerOutcomePersistenceInput {
        commands,
        requested_status,
        inspected_path_count: 3,
        affected_path_count: 2,
        evidence_refs: vec!["evidence:runner".to_owned()],
        existing_outcome_ids: Vec::new(),
        raw_stdout_present: forbidden,
        raw_stderr_present: forbidden,
        provider_payload_present: forbidden,
        raw_output_retention_requested: forbidden,
        pull_request_requested: forbidden,
        forge_effect_requested: forbidden,
        provider_effect_requested: forbidden,
        callback_effect_requested: forbidden,
        interruption_effect_requested: forbidden,
        recovery_effect_requested: forbidden,
        task_mutation_requested: forbidden,
    }
}

pub(super) fn command_set(
    commands: Vec<GitPushRunnerCommandAdapterRecord>,
) -> GitPushRunnerCommandAdapterSet {
    GitPushRunnerCommandAdapterSet {
        command_set_id: "command-set:1".to_owned(),
        skipped_authority_ids: Vec::new(),
        commands,
        executable_argv_created: true,
        shell_passthrough_used: false,
        shell_execution_performed: false,
        push_executed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

pub(super) fn command(
    id: &str,
    status: GitPushRunnerCommandAdapterStatus,
) -> GitPushRunnerCommandAdapterRecord {
    GitPushRunnerCommandAdapterRecord {
        command_id: format!("command:{id}"),
        authority_id: format!("authority:{id}"),
        preflight_id: format!("preflight:{id}"),
        descriptor_id: format!("descriptor:{id}"),
        admission_id: format!("admission:{id}"),
        request_id: format!("request:{id}"),
        upstream_authority_id: format!("upstream-authority:{id}"),
        git_plan_id: format!("git-plan:{id}"),
        task_id: "task:1".to_owned(),
        repo_id: "repo:1".to_owned(),
        operator_ref: "operator:tom".to_owned(),
        operator_confirmation_ref: Some(format!("confirmation:{id}")),
        command_kind: GitPushRunnerCommandKind::PushBranch,
        executable: "git".to_owned(),
        argv: vec![
            "push".to_owned(),
            "origin".to_owned(),
            "HEAD:feature/task".to_owned(),
        ],
        repo_working_directory_ref: "repo-worktree-ref:main".to_owned(),
        remote_target: Some(remote()),
        stdout_limit_bytes: 4096,
        stderr_limit_bytes: 4096,
        status: status.clone(),
        blockers: command_blockers(&status),
        executable_argv_created: status == GitPushRunnerCommandAdapterStatus::Ready,
        shell_passthrough_used: false,
        shell_execution_performed: false,
        push_requested: status == GitPushRunnerCommandAdapterStatus::Ready,
        push_executed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

pub(super) fn persisted(
    id: &str,
    outcome_status: GitPushRunnerOutcomeStatus,
) -> GitPushRunnerOutcomePersistenceRecord {
    let command = command(id, ready());
    outcome_record(
        &input(command_set(vec![command.clone()]), outcome_status, false),
        command,
        format!("persisted:{id}"),
        false,
        Vec::new(),
    )
}

pub(super) fn ready() -> GitPushRunnerCommandAdapterStatus {
    GitPushRunnerCommandAdapterStatus::Ready
}

pub(super) fn blocked() -> GitPushRunnerCommandAdapterStatus {
    GitPushRunnerCommandAdapterStatus::Blocked
}

pub(super) fn repair_required() -> GitPushRunnerCommandAdapterStatus {
    GitPushRunnerCommandAdapterStatus::RepairRequired
}

pub(super) fn completed() -> GitPushRunnerOutcomeStatus {
    GitPushRunnerOutcomeStatus::Completed
}

pub(super) fn failed() -> GitPushRunnerOutcomeStatus {
    GitPushRunnerOutcomeStatus::Failed
}

pub(super) fn failed_status() -> GitPushRunnerOutcomeStatus {
    GitPushRunnerOutcomeStatus::Failed
}

pub(super) fn blocked_status() -> GitPushRunnerOutcomeStatus {
    GitPushRunnerOutcomeStatus::Blocked
}

pub(super) fn repair_status() -> GitPushRunnerOutcomeStatus {
    GitPushRunnerOutcomeStatus::RepairRequired
}

pub(super) fn duplicate_status() -> GitPushRunnerOutcomeStatus {
    GitPushRunnerOutcomeStatus::DuplicateNoop
}

fn remote() -> GitPushRemoteTarget {
    GitPushRemoteTarget {
        remote_name: "origin".to_owned(),
        branch_name: "feature/task".to_owned(),
    }
}

fn command_blockers(
    status: &GitPushRunnerCommandAdapterStatus,
) -> Vec<GitPushRunnerCommandAdapterBlocker> {
    match status {
        GitPushRunnerCommandAdapterStatus::Ready => Vec::new(),
        GitPushRunnerCommandAdapterStatus::Blocked => {
            vec![GitPushRunnerCommandAdapterBlocker::PullRequestRequested]
        }
        GitPushRunnerCommandAdapterStatus::RepairRequired => {
            vec![GitPushRunnerCommandAdapterBlocker::MissingRemoteTarget]
        }
    }
}
