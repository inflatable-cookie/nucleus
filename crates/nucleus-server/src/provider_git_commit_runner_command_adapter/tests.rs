use super::*;
use crate::{
    GitBranchWorktreeMode, GitCommitMessageSource, GitCommitRunnerAuthorityRecord,
    GitCommitRunnerAuthoritySet, GitCommitRunnerAuthorityStatus,
};

#[test]
fn git_commit_runner_command_adapter_builds_commit_argv() {
    let set = git_commit_runner_command_adapter(input(false));
    let command = &set.commands[0];

    assert_eq!(command.status, GitCommitRunnerCommandAdapterStatus::Ready);
    assert_eq!(command.executable, "git");
    assert_eq!(
        command.argv,
        vec!["commit", "--file", "commit-message-ref:1"]
    );
    assert!(command.executable_argv_created);
    assert!(command.commit_creation_requested);
    assert!(!command.shell_passthrough_used);
    assert!(!command.commit_created);
    assert!(!command.push_executed);
    assert!(!command.raw_output_retained);
}

#[test]
fn git_commit_runner_command_adapter_blocks_shell_and_widening() {
    let set = git_commit_runner_command_adapter(input(true));
    let command = &set.commands[0];

    assert_eq!(command.status, GitCommitRunnerCommandAdapterStatus::Blocked);
    assert!(command
        .blockers
        .contains(&GitCommitRunnerCommandAdapterBlocker::ShellPassthroughRequested));
    assert!(command
        .blockers
        .contains(&GitCommitRunnerCommandAdapterBlocker::RawOutputRetentionRequested));
    assert!(command
        .blockers
        .contains(&GitCommitRunnerCommandAdapterBlocker::PushRequested));
    assert!(command.argv.is_empty());
}

#[test]
fn git_commit_runner_command_adapter_repairs_missing_inputs() {
    let mut input = input(false);
    input.executable.clear();
    input.repo_working_directory_ref.clear();
    input.authorities.authorities[0].commit_message_ref = None;

    let set = git_commit_runner_command_adapter(input);
    let command = &set.commands[0];

    assert_eq!(
        command.status,
        GitCommitRunnerCommandAdapterStatus::RepairRequired
    );
    assert!(command
        .blockers
        .contains(&GitCommitRunnerCommandAdapterBlocker::MissingExecutable));
    assert!(command
        .blockers
        .contains(&GitCommitRunnerCommandAdapterBlocker::MissingRepoWorkingDirectoryRef));
    assert!(command
        .blockers
        .contains(&GitCommitRunnerCommandAdapterBlocker::MissingCommitMessageRef));
}

fn input(forbidden: bool) -> GitCommitRunnerCommandAdapterInput {
    GitCommitRunnerCommandAdapterInput {
        authorities: authority_set(),
        executable: "git".to_owned(),
        repo_working_directory_ref: "repo-worktree-ref:main".to_owned(),
        stdout_limit_bytes: 4096,
        stderr_limit_bytes: 4096,
        shell_passthrough_requested: forbidden,
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

fn authority_set() -> GitCommitRunnerAuthoritySet {
    GitCommitRunnerAuthoritySet {
        authority_set_id: "authority-set:1".to_owned(),
        authorities: vec![authority()],
        skipped_preflight_ids: Vec::new(),
        runner_invocation_permitted: true,
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

fn authority() -> GitCommitRunnerAuthorityRecord {
    GitCommitRunnerAuthorityRecord {
        authority_id: "authority:1".to_owned(),
        preflight_id: "preflight:1".to_owned(),
        descriptor_id: "descriptor:1".to_owned(),
        admission_id: "admission:1".to_owned(),
        branch_worktree_evidence_id: "branch-worktree-evidence:1".to_owned(),
        branch_worktree_outcome_id: "branch-worktree-outcome:1".to_owned(),
        branch_worktree_handoff_id: "branch-worktree-handoff:1".to_owned(),
        branch_worktree_preflight_id: "branch-worktree-preflight:1".to_owned(),
        branch_worktree_descriptor_id: "branch-worktree-descriptor:1".to_owned(),
        branch_worktree_admission_id: "branch-worktree-admission:1".to_owned(),
        dry_run_evidence_id: "dry-run-evidence:1".to_owned(),
        dry_run_outcome_id: "dry-run-outcome:1".to_owned(),
        dry_run_handoff_id: "dry-run-handoff:1".to_owned(),
        request_id: "request:1".to_owned(),
        upstream_authority_id: "upstream-authority:1".to_owned(),
        git_plan_id: "git-plan:1".to_owned(),
        task_id: "task:1".to_owned(),
        repo_id: "repo:1".to_owned(),
        operator_ref: "operator:tom".to_owned(),
        operator_confirmation_ref: Some("confirmation:1".to_owned()),
        worktree_mode: GitBranchWorktreeMode::PrimaryTree,
        commit_message_source: Some(GitCommitMessageSource::GeneratedFromDiff),
        commit_message_ref: Some("commit-message-ref:1".to_owned()),
        status: GitCommitRunnerAuthorityStatus::ReadyForRunner,
        blockers: Vec::new(),
        runner_invocation_permitted: true,
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
