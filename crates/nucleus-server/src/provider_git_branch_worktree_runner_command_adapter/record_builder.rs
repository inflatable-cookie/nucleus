use crate::provider_no_effects::ForgeScmNoEffects;
use crate::{
    GitBranchWorktreeMode, GitBranchWorktreeRunnerAuthorityRecord,
    GitBranchWorktreeRunnerAuthorityStatus,
};

use super::types::{
    GitBranchWorktreeRunnerCommandAdapterBlocker, GitBranchWorktreeRunnerCommandAdapterInput,
    GitBranchWorktreeRunnerCommandAdapterRecord, GitBranchWorktreeRunnerCommandAdapterStatus,
    GitBranchWorktreeRunnerCommandKind,
};

pub(super) fn command_record(
    input: &GitBranchWorktreeRunnerCommandAdapterInput,
    authority: GitBranchWorktreeRunnerAuthorityRecord,
) -> GitBranchWorktreeRunnerCommandAdapterRecord {
    let blockers = blockers(input, &authority);
    let status = status(&blockers);
    let command_kind = command_kind(&authority.worktree_mode);
    let argv = if blockers.is_empty() {
        argv(&authority.worktree_mode, &authority)
    } else {
        Vec::new()
    };
    let executable_argv_created = status == GitBranchWorktreeRunnerCommandAdapterStatus::Ready;
    let checkout_requested =
        executable_argv_created && authority.worktree_mode == GitBranchWorktreeMode::PrimaryTree;
    let worktree_creation_requested = executable_argv_created
        && authority.worktree_mode == GitBranchWorktreeMode::IsolatedWorktree;

    GitBranchWorktreeRunnerCommandAdapterRecord {
        command_id: format!(
            "git-branch-worktree-runner-command:{}",
            authority.authority_id
        ),
        authority_id: authority.authority_id,
        handoff_id: authority.handoff_id,
        preflight_id: authority.preflight_id,
        descriptor_id: authority.descriptor_id,
        admission_id: authority.admission_id,
        request_id: authority.request_id,
        upstream_authority_id: authority.upstream_authority_id,
        git_plan_id: authority.git_plan_id,
        task_id: authority.task_id,
        repo_id: authority.repo_id,
        operator_ref: authority.operator_ref,
        operator_confirmation_ref: authority.operator_confirmation_ref,
        worktree_mode: authority.worktree_mode,
        command_kind,
        executable: input.executable.clone(),
        argv,
        repo_working_directory_ref: input.repo_working_directory_ref.clone(),
        branch_ref: authority.branch_ref,
        worktree_location_ref: authority.worktree_location_ref,
        stdout_limit_bytes: input.stdout_limit_bytes,
        stderr_limit_bytes: input.stderr_limit_bytes,
        status,
        blockers,
        executable_argv_created,
        shell_passthrough_used: false,
        shell_execution_performed: false,
        checkout_requested,
        branch_creation_requested: executable_argv_created,
        worktree_creation_requested,
        checkout_executed: false,
        branch_created: false,
        worktree_created: false,
        commit_created: false,
        push_executed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

fn blockers(
    input: &GitBranchWorktreeRunnerCommandAdapterInput,
    authority: &GitBranchWorktreeRunnerAuthorityRecord,
) -> Vec<GitBranchWorktreeRunnerCommandAdapterBlocker> {
    let mut blockers = Vec::new();
    if authority.status != GitBranchWorktreeRunnerAuthorityStatus::ReadyForRunner {
        blockers.push(GitBranchWorktreeRunnerCommandAdapterBlocker::AuthorityNotReady);
    }
    if input.executable.trim().is_empty() {
        blockers.push(GitBranchWorktreeRunnerCommandAdapterBlocker::MissingExecutable);
    }
    if input.repo_working_directory_ref.trim().is_empty() {
        blockers.push(GitBranchWorktreeRunnerCommandAdapterBlocker::MissingRepoWorkingDirectoryRef);
    }
    if authority
        .branch_ref
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(GitBranchWorktreeRunnerCommandAdapterBlocker::MissingBranchRef);
    }
    if authority.worktree_mode == GitBranchWorktreeMode::IsolatedWorktree
        && authority
            .worktree_location_ref
            .as_deref()
            .unwrap_or_default()
            .is_empty()
    {
        blockers
            .push(GitBranchWorktreeRunnerCommandAdapterBlocker::MissingIsolatedWorktreeLocationRef);
    }
    forbidden_blockers(input, &mut blockers);
    blockers
}

fn forbidden_blockers(
    input: &GitBranchWorktreeRunnerCommandAdapterInput,
    blockers: &mut Vec<GitBranchWorktreeRunnerCommandAdapterBlocker>,
) {
    if input.shell_passthrough_requested {
        blockers.push(GitBranchWorktreeRunnerCommandAdapterBlocker::ShellPassthroughRequested);
    }
    if input.raw_output_retention_requested {
        blockers.push(GitBranchWorktreeRunnerCommandAdapterBlocker::RawOutputRetentionRequested);
    }
    if input.commit_requested {
        blockers.push(GitBranchWorktreeRunnerCommandAdapterBlocker::CommitRequested);
    }
    if input.push_requested {
        blockers.push(GitBranchWorktreeRunnerCommandAdapterBlocker::PushRequested);
    }
    if input.pull_request_requested {
        blockers.push(GitBranchWorktreeRunnerCommandAdapterBlocker::PullRequestRequested);
    }
    if input.forge_effect_requested {
        blockers.push(GitBranchWorktreeRunnerCommandAdapterBlocker::ForgeEffectRequested);
    }
    if input.provider_effect_requested {
        blockers.push(GitBranchWorktreeRunnerCommandAdapterBlocker::ProviderEffectRequested);
    }
    if input.callback_effect_requested {
        blockers.push(GitBranchWorktreeRunnerCommandAdapterBlocker::CallbackEffectRequested);
    }
    if input.interruption_effect_requested {
        blockers.push(GitBranchWorktreeRunnerCommandAdapterBlocker::InterruptionEffectRequested);
    }
    if input.recovery_effect_requested {
        blockers.push(GitBranchWorktreeRunnerCommandAdapterBlocker::RecoveryEffectRequested);
    }
    if input.task_mutation_requested {
        blockers.push(GitBranchWorktreeRunnerCommandAdapterBlocker::TaskMutationRequested);
    }
}

fn status(
    blockers: &[GitBranchWorktreeRunnerCommandAdapterBlocker],
) -> GitBranchWorktreeRunnerCommandAdapterStatus {
    if blockers.is_empty() {
        GitBranchWorktreeRunnerCommandAdapterStatus::Ready
    } else if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            GitBranchWorktreeRunnerCommandAdapterBlocker::AuthorityNotReady
                | GitBranchWorktreeRunnerCommandAdapterBlocker::MissingExecutable
                | GitBranchWorktreeRunnerCommandAdapterBlocker::MissingRepoWorkingDirectoryRef
                | GitBranchWorktreeRunnerCommandAdapterBlocker::MissingBranchRef
                | GitBranchWorktreeRunnerCommandAdapterBlocker::MissingIsolatedWorktreeLocationRef
        )
    }) {
        GitBranchWorktreeRunnerCommandAdapterStatus::RepairRequired
    } else {
        GitBranchWorktreeRunnerCommandAdapterStatus::Blocked
    }
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

fn argv(
    mode: &GitBranchWorktreeMode,
    authority: &GitBranchWorktreeRunnerAuthorityRecord,
) -> Vec<String> {
    let branch_ref = authority.branch_ref.clone().unwrap_or_default();
    match mode {
        GitBranchWorktreeMode::PrimaryTree => {
            vec!["switch".to_owned(), "-c".to_owned(), branch_ref]
        }
        GitBranchWorktreeMode::IsolatedWorktree => vec![
            "worktree".to_owned(),
            "add".to_owned(),
            authority.worktree_location_ref.clone().unwrap_or_default(),
            "-b".to_owned(),
            branch_ref,
        ],
    }
}
