use super::*;
use crate::{
    GitBranchWorktreeMode, GitBranchWorktreeRunnerAction, GitBranchWorktreeRunnerAuthorityRecord,
    GitBranchWorktreeRunnerAuthoritySet, GitBranchWorktreeRunnerAuthorityStatus,
};

#[test]
fn git_branch_worktree_runner_command_adapter_builds_isolated_worktree_argv() {
    let record = git_branch_worktree_runner_command_adapter(input(
        GitBranchWorktreeMode::IsolatedWorktree,
        false,
    ));
    let command = &record.commands[0];

    assert_eq!(
        command.status,
        GitBranchWorktreeRunnerCommandAdapterStatus::Ready
    );
    assert_eq!(command.executable, "git");
    assert_eq!(
        command.argv,
        vec![
            "worktree",
            "add",
            "worktree-ref:task",
            "-b",
            "branch-ref:task"
        ]
    );
    assert!(command.executable_argv_created);
    assert!(!command.shell_passthrough_used);
    assert!(!command.shell_execution_performed);
    assert!(!command.checkout_requested);
    assert!(command.branch_creation_requested);
    assert!(command.worktree_creation_requested);
    assert!(!command.commit_created);
    assert!(!command.push_executed);
    assert!(!command.raw_output_retained);
}

#[test]
fn git_branch_worktree_runner_command_adapter_builds_primary_tree_argv() {
    let record = git_branch_worktree_runner_command_adapter(input(
        GitBranchWorktreeMode::PrimaryTree,
        false,
    ));
    let command = &record.commands[0];

    assert_eq!(
        command.status,
        GitBranchWorktreeRunnerCommandAdapterStatus::Ready
    );
    assert_eq!(command.argv, vec!["switch", "-c", "branch-ref:task"]);
    assert!(command.checkout_requested);
    assert!(command.branch_creation_requested);
    assert!(!command.worktree_creation_requested);
}

#[test]
fn git_branch_worktree_runner_command_adapter_blocks_shell_and_widening() {
    let record = git_branch_worktree_runner_command_adapter(input(
        GitBranchWorktreeMode::IsolatedWorktree,
        true,
    ));
    let command = &record.commands[0];

    assert_eq!(
        command.status,
        GitBranchWorktreeRunnerCommandAdapterStatus::Blocked
    );
    assert!(command
        .blockers
        .contains(&GitBranchWorktreeRunnerCommandAdapterBlocker::ShellPassthroughRequested));
    assert!(command
        .blockers
        .contains(&GitBranchWorktreeRunnerCommandAdapterBlocker::RawOutputRetentionRequested));
    assert!(command
        .blockers
        .contains(&GitBranchWorktreeRunnerCommandAdapterBlocker::CommitRequested));
    assert!(command.argv.is_empty());
    assert!(!command.executable_argv_created);
}

#[test]
fn git_branch_worktree_runner_command_adapter_repairs_missing_authority_inputs() {
    let mut input = input(GitBranchWorktreeMode::IsolatedWorktree, false);
    input.executable.clear();
    input.repo_working_directory_ref.clear();
    input.authorities.authorities[0].branch_ref = None;
    input.authorities.authorities[0].worktree_location_ref = None;

    let record = git_branch_worktree_runner_command_adapter(input);
    let command = &record.commands[0];

    assert_eq!(
        command.status,
        GitBranchWorktreeRunnerCommandAdapterStatus::RepairRequired
    );
    assert!(command
        .blockers
        .contains(&GitBranchWorktreeRunnerCommandAdapterBlocker::MissingExecutable));
    assert!(command
        .blockers
        .contains(&GitBranchWorktreeRunnerCommandAdapterBlocker::MissingRepoWorkingDirectoryRef));
    assert!(command
        .blockers
        .contains(&GitBranchWorktreeRunnerCommandAdapterBlocker::MissingBranchRef));
    assert!(command.blockers.contains(
        &GitBranchWorktreeRunnerCommandAdapterBlocker::MissingIsolatedWorktreeLocationRef
    ));
}

fn input(
    mode: GitBranchWorktreeMode,
    forbidden: bool,
) -> GitBranchWorktreeRunnerCommandAdapterInput {
    GitBranchWorktreeRunnerCommandAdapterInput {
        authorities: authority_set(mode),
        executable: "git".to_owned(),
        repo_working_directory_ref: "repo-worktree-ref:main".to_owned(),
        stdout_limit_bytes: 4096,
        stderr_limit_bytes: 4096,
        shell_passthrough_requested: forbidden,
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

fn authority_set(mode: GitBranchWorktreeMode) -> GitBranchWorktreeRunnerAuthoritySet {
    GitBranchWorktreeRunnerAuthoritySet {
        authority_set_id: "authority-set:1".to_owned(),
        authorities: vec![authority(mode)],
        skipped_handoff_ids: Vec::new(),
        runner_invocation_permitted: true,
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

fn authority(mode: GitBranchWorktreeMode) -> GitBranchWorktreeRunnerAuthorityRecord {
    GitBranchWorktreeRunnerAuthorityRecord {
        authority_id: "runner-authority:1".to_owned(),
        handoff_id: "handoff:1".to_owned(),
        preflight_id: "preflight:1".to_owned(),
        descriptor_id: "descriptor:1".to_owned(),
        admission_id: "admission:1".to_owned(),
        dry_run_evidence_id: "evidence:1".to_owned(),
        dry_run_outcome_id: "outcome:1".to_owned(),
        dry_run_handoff_id: "dry-run-handoff:1".to_owned(),
        request_id: "request:1".to_owned(),
        upstream_authority_id: "authority:1".to_owned(),
        git_plan_id: "git-plan:1".to_owned(),
        task_id: "task:1".to_owned(),
        repo_id: "repo:1".to_owned(),
        operator_ref: "operator:tom".to_owned(),
        operator_confirmation_ref: Some("operator-confirmation:1".to_owned()),
        worktree_mode: mode.clone(),
        runner_action: match mode {
            GitBranchWorktreeMode::PrimaryTree => {
                GitBranchWorktreeRunnerAction::CheckoutTemporaryBranch
            }
            GitBranchWorktreeMode::IsolatedWorktree => {
                GitBranchWorktreeRunnerAction::CreateIsolatedWorktree
            }
        },
        branch_ref: Some("branch-ref:task".to_owned()),
        worktree_location_ref: (mode == GitBranchWorktreeMode::IsolatedWorktree)
            .then(|| "worktree-ref:task".to_owned()),
        status: GitBranchWorktreeRunnerAuthorityStatus::ReadyForRunner,
        blockers: Vec::new(),
        runner_invocation_permitted: true,
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
