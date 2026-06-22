use std::path::PathBuf;

use super::super::*;
use crate::{
    GitBranchWorktreeMode, GitBranchWorktreeRunnerCommandAdapterBlocker,
    GitBranchWorktreeRunnerCommandAdapterRecord, GitBranchWorktreeRunnerCommandAdapterSet,
    GitBranchWorktreeRunnerCommandAdapterStatus, GitBranchWorktreeRunnerCommandKind,
    ServerStateService,
};
use nucleus_local_store::SqliteBackend;

pub(super) fn test_state(path: PathBuf) -> ServerStateService<SqliteBackend> {
    ServerStateService::new(SqliteBackend::new(path))
}

pub(super) fn input(
    commands: GitBranchWorktreeRunnerCommandAdapterSet,
    requested_status: GitBranchWorktreeRunnerOutcomeStatus,
    forbidden: bool,
) -> GitBranchWorktreeRunnerOutcomePersistenceInput {
    GitBranchWorktreeRunnerOutcomePersistenceInput {
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
        commit_requested: forbidden,
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
    commands: Vec<GitBranchWorktreeRunnerCommandAdapterRecord>,
) -> GitBranchWorktreeRunnerCommandAdapterSet {
    GitBranchWorktreeRunnerCommandAdapterSet {
        command_set_id: "command-set:1".to_owned(),
        skipped_authority_ids: Vec::new(),
        commands,
        executable_argv_created: true,
        shell_passthrough_used: false,
        shell_execution_performed: false,
        checkout_executed: false,
        branch_created: false,
        worktree_created: false,
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
    status: GitBranchWorktreeRunnerCommandAdapterStatus,
    mode: GitBranchWorktreeMode,
) -> GitBranchWorktreeRunnerCommandAdapterRecord {
    GitBranchWorktreeRunnerCommandAdapterRecord {
        command_id: format!("command:{id}"),
        authority_id: format!("authority:{id}"),
        handoff_id: format!("handoff:{id}"),
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
        worktree_mode: mode.clone(),
        command_kind: command_kind(&mode),
        executable: "git".to_owned(),
        argv: vec![
            "switch".to_owned(),
            "-c".to_owned(),
            format!("branch-ref:{id}"),
        ],
        repo_working_directory_ref: "repo-worktree-ref:main".to_owned(),
        branch_ref: Some(format!("branch-ref:{id}")),
        worktree_location_ref: (mode == GitBranchWorktreeMode::IsolatedWorktree)
            .then(|| format!("worktree-ref:{id}")),
        stdout_limit_bytes: 4096,
        stderr_limit_bytes: 4096,
        status: status.clone(),
        blockers: command_blockers(&status),
        executable_argv_created: status == GitBranchWorktreeRunnerCommandAdapterStatus::Ready,
        shell_passthrough_used: false,
        shell_execution_performed: false,
        checkout_requested: mode == GitBranchWorktreeMode::PrimaryTree
            && status == GitBranchWorktreeRunnerCommandAdapterStatus::Ready,
        branch_creation_requested: status == GitBranchWorktreeRunnerCommandAdapterStatus::Ready,
        worktree_creation_requested: mode == GitBranchWorktreeMode::IsolatedWorktree
            && status == GitBranchWorktreeRunnerCommandAdapterStatus::Ready,
        checkout_executed: false,
        branch_created: false,
        worktree_created: false,
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
    outcome_status: GitBranchWorktreeRunnerOutcomeStatus,
    mode: GitBranchWorktreeMode,
) -> GitBranchWorktreeRunnerOutcomePersistenceRecord {
    let command = command(id, ready(), mode);
    outcome_record(
        &input(command_set(vec![command.clone()]), outcome_status, false),
        command,
        format!("persisted:{id}"),
        false,
        Vec::new(),
    )
}

pub(super) fn ready() -> GitBranchWorktreeRunnerCommandAdapterStatus {
    GitBranchWorktreeRunnerCommandAdapterStatus::Ready
}

pub(super) fn blocked() -> GitBranchWorktreeRunnerCommandAdapterStatus {
    GitBranchWorktreeRunnerCommandAdapterStatus::Blocked
}

pub(super) fn repair_required() -> GitBranchWorktreeRunnerCommandAdapterStatus {
    GitBranchWorktreeRunnerCommandAdapterStatus::RepairRequired
}

pub(super) fn primary() -> GitBranchWorktreeMode {
    GitBranchWorktreeMode::PrimaryTree
}

pub(super) fn isolated() -> GitBranchWorktreeMode {
    GitBranchWorktreeMode::IsolatedWorktree
}

pub(super) fn completed() -> GitBranchWorktreeRunnerOutcomeStatus {
    GitBranchWorktreeRunnerOutcomeStatus::Completed
}

pub(super) fn failed() -> GitBranchWorktreeRunnerOutcomeStatus {
    GitBranchWorktreeRunnerOutcomeStatus::Failed
}

pub(super) fn failed_status() -> GitBranchWorktreeRunnerOutcomeStatus {
    GitBranchWorktreeRunnerOutcomeStatus::Failed
}

pub(super) fn blocked_status() -> GitBranchWorktreeRunnerOutcomeStatus {
    GitBranchWorktreeRunnerOutcomeStatus::Blocked
}

pub(super) fn repair_status() -> GitBranchWorktreeRunnerOutcomeStatus {
    GitBranchWorktreeRunnerOutcomeStatus::RepairRequired
}

pub(super) fn duplicate_status() -> GitBranchWorktreeRunnerOutcomeStatus {
    GitBranchWorktreeRunnerOutcomeStatus::DuplicateNoop
}

fn command_kind(mode: &GitBranchWorktreeMode) -> GitBranchWorktreeRunnerCommandKind {
    match mode {
        GitBranchWorktreeMode::PrimaryTree => {
            GitBranchWorktreeRunnerCommandKind::CheckoutTemporaryBranch
        }
        GitBranchWorktreeMode::IsolatedWorktree => {
            GitBranchWorktreeRunnerCommandKind::CreateIsolatedWorktree
        }
    }
}

fn command_blockers(
    status: &GitBranchWorktreeRunnerCommandAdapterStatus,
) -> Vec<GitBranchWorktreeRunnerCommandAdapterBlocker> {
    match status {
        GitBranchWorktreeRunnerCommandAdapterStatus::Ready => Vec::new(),
        GitBranchWorktreeRunnerCommandAdapterStatus::Blocked => {
            vec![GitBranchWorktreeRunnerCommandAdapterBlocker::CommitRequested]
        }
        GitBranchWorktreeRunnerCommandAdapterStatus::RepairRequired => {
            vec![GitBranchWorktreeRunnerCommandAdapterBlocker::MissingBranchRef]
        }
    }
}
