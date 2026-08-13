use crate::provider_no_effects::ForgeScmNoEffects;
use crate::{
    GitBranchWorktreeMode, GitBranchWorktreeRunnerAuthorityRecord,
    GitBranchWorktreeRunnerAuthorityStatus,
};

use super::types::{
    GitBranchWorktreeRunnerCommandAdapterBlocker, GitBranchWorktreeRunnerCommandAdapterInput,
    GitBranchWorktreeRunnerCommandAdapterRecord, GitBranchWorktreeRunnerCommandAdapterStatus,
    GitBranchWorktreeRunnerCommandKind, GitBranchWorktreeRunnerDeliveryCommandAdapterInput,
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

pub(super) fn delivery_command_records(
    input: &GitBranchWorktreeRunnerDeliveryCommandAdapterInput,
    authority: GitBranchWorktreeRunnerAuthorityRecord,
) -> Vec<GitBranchWorktreeRunnerCommandAdapterRecord> {
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
    if authority.worktree_mode != GitBranchWorktreeMode::IsolatedWorktree {
        blockers
            .push(GitBranchWorktreeRunnerCommandAdapterBlocker::DeliveryRequiresIsolatedWorktree);
    }
    if authority
        .branch_ref
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(GitBranchWorktreeRunnerCommandAdapterBlocker::MissingBranchRef);
    }
    if authority
        .worktree_location_ref
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers
            .push(GitBranchWorktreeRunnerCommandAdapterBlocker::MissingIsolatedWorktreeLocationRef);
    }
    if input.commit_message.trim().is_empty()
        || input.commit_message.len() > 16 * 1024
        || input.commit_message.contains('\0')
    {
        blockers.push(GitBranchWorktreeRunnerCommandAdapterBlocker::MissingCommitMessage);
    }
    if input.remote_target.trim().is_empty()
        || input.remote_target.starts_with('-')
        || input.remote_target.contains('\0')
    {
        blockers.push(GitBranchWorktreeRunnerCommandAdapterBlocker::MissingRemoteTarget);
    }
    let status = status(&blockers);
    let kinds = [
        (
            "stage",
            GitBranchWorktreeRunnerCommandKind::StageRunWorktree,
        ),
        (
            "commit",
            GitBranchWorktreeRunnerCommandKind::CommitRunWorktree,
        ),
        ("push", GitBranchWorktreeRunnerCommandKind::PushRunBranch),
    ];
    kinds
        .into_iter()
        .map(|(suffix, command_kind)| {
            let argv = if blockers.is_empty() {
                delivery_argv(&command_kind, &authority, input)
            } else {
                Vec::new()
            };
            GitBranchWorktreeRunnerCommandAdapterRecord {
                command_id: format!(
                    "git-branch-worktree-runner-delivery-command:{}:{}",
                    authority.authority_id, suffix
                ),
                authority_id: authority.authority_id.clone(),
                handoff_id: authority.handoff_id.clone(),
                preflight_id: authority.preflight_id.clone(),
                descriptor_id: authority.descriptor_id.clone(),
                admission_id: authority.admission_id.clone(),
                request_id: authority.request_id.clone(),
                upstream_authority_id: authority.upstream_authority_id.clone(),
                git_plan_id: authority.git_plan_id.clone(),
                task_id: authority.task_id.clone(),
                repo_id: authority.repo_id.clone(),
                operator_ref: authority.operator_ref.clone(),
                operator_confirmation_ref: authority.operator_confirmation_ref.clone(),
                worktree_mode: authority.worktree_mode.clone(),
                command_kind,
                executable: input.executable.clone(),
                argv,
                repo_working_directory_ref: input.repo_working_directory_ref.clone(),
                branch_ref: authority.branch_ref.clone(),
                worktree_location_ref: authority.worktree_location_ref.clone(),
                stdout_limit_bytes: input.stdout_limit_bytes,
                stderr_limit_bytes: input.stderr_limit_bytes,
                status: status.clone(),
                blockers: blockers.clone(),
                executable_argv_created: status
                    == GitBranchWorktreeRunnerCommandAdapterStatus::Ready,
                shell_passthrough_used: false,
                shell_execution_performed: false,
                checkout_requested: false,
                branch_creation_requested: false,
                worktree_creation_requested: false,
                checkout_executed: false,
                branch_created: false,
                worktree_created: false,
                commit_created: false,
                push_executed: false,
                no_effects: ForgeScmNoEffects::none(),
            }
        })
        .collect()
}

fn delivery_argv(
    kind: &GitBranchWorktreeRunnerCommandKind,
    authority: &GitBranchWorktreeRunnerAuthorityRecord,
    input: &GitBranchWorktreeRunnerDeliveryCommandAdapterInput,
) -> Vec<String> {
    match kind {
        GitBranchWorktreeRunnerCommandKind::StageRunWorktree => {
            vec!["add".to_owned(), "--all".to_owned()]
        }
        GitBranchWorktreeRunnerCommandKind::CommitRunWorktree => vec![
            "commit".to_owned(),
            "--no-gpg-sign".to_owned(),
            "-m".to_owned(),
            input.commit_message.clone(),
        ],
        GitBranchWorktreeRunnerCommandKind::PushRunBranch => vec![
            "push".to_owned(),
            input.remote_target.clone(),
            authority.branch_ref.clone().unwrap_or_default(),
        ],
        _ => Vec::new(),
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
                | GitBranchWorktreeRunnerCommandAdapterBlocker::MissingCommitMessage
                | GitBranchWorktreeRunnerCommandAdapterBlocker::MissingRemoteTarget
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
