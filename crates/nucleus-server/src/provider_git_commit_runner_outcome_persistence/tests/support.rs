use std::path::PathBuf;

use super::super::*;
use crate::{
    GitBranchWorktreeMode, GitCommitMessageSource, GitCommitRunnerCommandAdapterBlocker,
    GitCommitRunnerCommandAdapterRecord, GitCommitRunnerCommandAdapterSet,
    GitCommitRunnerCommandAdapterStatus, GitCommitRunnerCommandKind, ServerStateService,
};
use nucleus_local_store::SqliteBackend;

pub(super) fn test_state(path: PathBuf) -> ServerStateService<SqliteBackend> {
    ServerStateService::new(SqliteBackend::new(path))
}

pub(super) fn input(
    commands: GitCommitRunnerCommandAdapterSet,
    requested_status: GitCommitRunnerOutcomeStatus,
    forbidden: bool,
) -> GitCommitRunnerOutcomePersistenceInput {
    GitCommitRunnerOutcomePersistenceInput {
        commands,
        requested_status,
        inspected_path_count: 3,
        affected_path_count: 2,
        evidence_refs: vec!["evidence:runner".to_owned()],
        existing_outcome_ids: Vec::new(),
        raw_stdout_present: forbidden,
        raw_stderr_present: forbidden,
        raw_commit_message_present: forbidden,
        provider_payload_present: forbidden,
        raw_output_retention_requested: forbidden,
        push_requested: forbidden,
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
    commands: Vec<GitCommitRunnerCommandAdapterRecord>,
) -> GitCommitRunnerCommandAdapterSet {
    GitCommitRunnerCommandAdapterSet {
        command_set_id: "command-set:1".to_owned(),
        skipped_authority_ids: Vec::new(),
        commands,
        executable_argv_created: true,
        shell_passthrough_used: false,
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

pub(super) fn command(
    id: &str,
    status: GitCommitRunnerCommandAdapterStatus,
    mode: GitBranchWorktreeMode,
) -> GitCommitRunnerCommandAdapterRecord {
    GitCommitRunnerCommandAdapterRecord {
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
        worktree_mode: mode,
        command_kind: GitCommitRunnerCommandKind::CreateCommit,
        executable: "git".to_owned(),
        argv: vec![
            "commit".to_owned(),
            "--file".to_owned(),
            format!("commit-message-ref:{id}"),
        ],
        repo_working_directory_ref: "repo-worktree-ref:main".to_owned(),
        commit_message_source: Some(GitCommitMessageSource::GeneratedFromDiff),
        commit_message_ref: Some(format!("commit-message-ref:{id}")),
        stdout_limit_bytes: 4096,
        stderr_limit_bytes: 4096,
        status: status.clone(),
        blockers: command_blockers(&status),
        executable_argv_created: status == GitCommitRunnerCommandAdapterStatus::Ready,
        shell_passthrough_used: false,
        shell_execution_performed: false,
        commit_creation_requested: status == GitCommitRunnerCommandAdapterStatus::Ready,
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

pub(super) fn persisted(
    id: &str,
    outcome_status: GitCommitRunnerOutcomeStatus,
    mode: GitBranchWorktreeMode,
) -> GitCommitRunnerOutcomePersistenceRecord {
    let command = command(id, ready(), mode);
    outcome_record(
        &input(command_set(vec![command.clone()]), outcome_status, false),
        command,
        format!("persisted:{id}"),
        false,
        Vec::new(),
    )
}

pub(super) fn ready() -> GitCommitRunnerCommandAdapterStatus {
    GitCommitRunnerCommandAdapterStatus::Ready
}

pub(super) fn blocked() -> GitCommitRunnerCommandAdapterStatus {
    GitCommitRunnerCommandAdapterStatus::Blocked
}

pub(super) fn repair_required() -> GitCommitRunnerCommandAdapterStatus {
    GitCommitRunnerCommandAdapterStatus::RepairRequired
}

pub(super) fn primary() -> GitBranchWorktreeMode {
    GitBranchWorktreeMode::PrimaryTree
}

pub(super) fn isolated() -> GitBranchWorktreeMode {
    GitBranchWorktreeMode::IsolatedWorktree
}

pub(super) fn completed() -> GitCommitRunnerOutcomeStatus {
    GitCommitRunnerOutcomeStatus::Completed
}

pub(super) fn failed() -> GitCommitRunnerOutcomeStatus {
    GitCommitRunnerOutcomeStatus::Failed
}

pub(super) fn failed_status() -> GitCommitRunnerOutcomeStatus {
    GitCommitRunnerOutcomeStatus::Failed
}

pub(super) fn blocked_status() -> GitCommitRunnerOutcomeStatus {
    GitCommitRunnerOutcomeStatus::Blocked
}

pub(super) fn repair_status() -> GitCommitRunnerOutcomeStatus {
    GitCommitRunnerOutcomeStatus::RepairRequired
}

pub(super) fn duplicate_status() -> GitCommitRunnerOutcomeStatus {
    GitCommitRunnerOutcomeStatus::DuplicateNoop
}

fn command_blockers(
    status: &GitCommitRunnerCommandAdapterStatus,
) -> Vec<GitCommitRunnerCommandAdapterBlocker> {
    match status {
        GitCommitRunnerCommandAdapterStatus::Ready => Vec::new(),
        GitCommitRunnerCommandAdapterStatus::Blocked => {
            vec![GitCommitRunnerCommandAdapterBlocker::PushRequested]
        }
        GitCommitRunnerCommandAdapterStatus::RepairRequired => {
            vec![GitCommitRunnerCommandAdapterBlocker::MissingCommitMessageRef]
        }
    }
}
