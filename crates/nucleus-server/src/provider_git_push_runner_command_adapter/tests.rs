use crate::provider_no_effects::{ForgeScmNoEffects};
use super::*;
use crate::{
    GitPushRemoteTarget, GitPushRunnerAuthorityRecord, GitPushRunnerAuthoritySet,
    GitPushRunnerAuthorityStatus,
};

#[test]
fn git_push_runner_command_adapter_builds_push_argv() {
    let set = git_push_runner_command_adapter(input(false));
    let command = &set.commands[0];

    assert_eq!(command.status, GitPushRunnerCommandAdapterStatus::Ready);
    assert_eq!(command.executable, "git");
    assert_eq!(command.argv, vec!["push", "origin", "HEAD:feature/task"]);
    assert!(command.executable_argv_created);
    assert!(command.push_requested);
    assert!(!command.shell_passthrough_used);
    assert!(!command.push_executed);
    assert!(!command.no_effects.pull_request_created);
    assert!(!command.no_effects.raw_output_retained);
}

#[test]
fn git_push_runner_command_adapter_blocks_shell_and_widening() {
    let set = git_push_runner_command_adapter(input(true));
    let command = &set.commands[0];

    assert_eq!(command.status, GitPushRunnerCommandAdapterStatus::Blocked);
    assert!(command
        .blockers
        .contains(&GitPushRunnerCommandAdapterBlocker::ShellPassthroughRequested));
    assert!(command
        .blockers
        .contains(&GitPushRunnerCommandAdapterBlocker::PullRequestRequested));
    assert!(command.argv.is_empty());
}

#[test]
fn git_push_runner_command_adapter_repairs_missing_inputs() {
    let mut input = input(false);
    input.executable.clear();
    input.repo_working_directory_ref.clear();
    input.authorities.authorities[0].remote_target = None;

    let set = git_push_runner_command_adapter(input);
    let command = &set.commands[0];

    assert_eq!(
        command.status,
        GitPushRunnerCommandAdapterStatus::RepairRequired
    );
    assert!(command
        .blockers
        .contains(&GitPushRunnerCommandAdapterBlocker::MissingExecutable));
    assert!(command
        .blockers
        .contains(&GitPushRunnerCommandAdapterBlocker::MissingRepoWorkingDirectoryRef));
    assert!(command
        .blockers
        .contains(&GitPushRunnerCommandAdapterBlocker::MissingRemoteTarget));
}

fn input(forbidden: bool) -> GitPushRunnerCommandAdapterInput {
    GitPushRunnerCommandAdapterInput {
        authorities: authority_set(),
        executable: "git".to_owned(),
        repo_working_directory_ref: "repo-worktree-ref:main".to_owned(),
        stdout_limit_bytes: 4096,
        stderr_limit_bytes: 4096,
        shell_passthrough_requested: forbidden,
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

fn authority_set() -> GitPushRunnerAuthoritySet {
    GitPushRunnerAuthoritySet {
        authority_set_id: "authority-set:1".to_owned(),
        authorities: vec![authority()],
        skipped_preflight_ids: Vec::new(),
        runner_invocation_permitted: true,
        shell_execution_performed: false,
        push_executed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

fn authority() -> GitPushRunnerAuthorityRecord {
    GitPushRunnerAuthorityRecord {
        authority_id: "authority:1".to_owned(),
        preflight_id: "preflight:1".to_owned(),
        descriptor_id: "descriptor:1".to_owned(),
        admission_id: "admission:1".to_owned(),
        commit_preflight_id: "commit-preflight:1".to_owned(),
        commit_descriptor_id: "commit-descriptor:1".to_owned(),
        commit_admission_id: "commit-admission:1".to_owned(),
        branch_worktree_evidence_id: "branch-worktree-evidence:1".to_owned(),
        request_id: "request:1".to_owned(),
        upstream_authority_id: "upstream-authority:1".to_owned(),
        git_plan_id: "git-plan:1".to_owned(),
        task_id: "task:1".to_owned(),
        repo_id: "repo:1".to_owned(),
        operator_ref: "operator:tom".to_owned(),
        operator_confirmation_ref: Some("confirmation:1".to_owned()),
        remote_target: Some(GitPushRemoteTarget {
            remote_name: "origin".to_owned(),
            branch_name: "feature/task".to_owned(),
        }),
        status: GitPushRunnerAuthorityStatus::ReadyForRunner,
        blockers: Vec::new(),
        runner_invocation_permitted: true,
        shell_execution_performed: false,
        push_executed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}
