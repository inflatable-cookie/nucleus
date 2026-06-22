use crate::{GitCommitRunnerAuthorityRecord, GitCommitRunnerAuthorityStatus};

use super::types::{
    GitCommitRunnerCommandAdapterBlocker, GitCommitRunnerCommandAdapterInput,
    GitCommitRunnerCommandAdapterRecord, GitCommitRunnerCommandAdapterStatus,
    GitCommitRunnerCommandKind,
};

pub(super) fn command_record(
    input: &GitCommitRunnerCommandAdapterInput,
    authority: GitCommitRunnerAuthorityRecord,
) -> GitCommitRunnerCommandAdapterRecord {
    let blockers = blockers(input, &authority);
    let status = status(&blockers);
    let argv = if blockers.is_empty() {
        argv(&authority)
    } else {
        Vec::new()
    };
    let executable_argv_created = status == GitCommitRunnerCommandAdapterStatus::Ready;

    GitCommitRunnerCommandAdapterRecord {
        command_id: format!("git-commit-runner-command:{}", authority.authority_id),
        authority_id: authority.authority_id,
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
        command_kind: GitCommitRunnerCommandKind::CreateCommit,
        executable: input.executable.clone(),
        argv,
        repo_working_directory_ref: input.repo_working_directory_ref.clone(),
        commit_message_source: authority.commit_message_source,
        commit_message_ref: authority.commit_message_ref,
        stdout_limit_bytes: input.stdout_limit_bytes,
        stderr_limit_bytes: input.stderr_limit_bytes,
        status,
        blockers,
        executable_argv_created,
        shell_passthrough_used: false,
        shell_execution_performed: false,
        commit_creation_requested: executable_argv_created,
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

fn blockers(
    input: &GitCommitRunnerCommandAdapterInput,
    authority: &GitCommitRunnerAuthorityRecord,
) -> Vec<GitCommitRunnerCommandAdapterBlocker> {
    let mut blockers = Vec::new();
    if authority.status != GitCommitRunnerAuthorityStatus::ReadyForRunner {
        blockers.push(GitCommitRunnerCommandAdapterBlocker::AuthorityNotReady);
    }
    if input.executable.trim().is_empty() {
        blockers.push(GitCommitRunnerCommandAdapterBlocker::MissingExecutable);
    }
    if input.repo_working_directory_ref.trim().is_empty() {
        blockers.push(GitCommitRunnerCommandAdapterBlocker::MissingRepoWorkingDirectoryRef);
    }
    if authority
        .commit_message_ref
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(GitCommitRunnerCommandAdapterBlocker::MissingCommitMessageRef);
    }
    forbidden_blockers(input, &mut blockers);
    blockers
}

fn forbidden_blockers(
    input: &GitCommitRunnerCommandAdapterInput,
    blockers: &mut Vec<GitCommitRunnerCommandAdapterBlocker>,
) {
    if input.shell_passthrough_requested {
        blockers.push(GitCommitRunnerCommandAdapterBlocker::ShellPassthroughRequested);
    }
    if input.raw_output_retention_requested {
        blockers.push(GitCommitRunnerCommandAdapterBlocker::RawOutputRetentionRequested);
    }
    if input.push_requested {
        blockers.push(GitCommitRunnerCommandAdapterBlocker::PushRequested);
    }
    if input.pull_request_requested {
        blockers.push(GitCommitRunnerCommandAdapterBlocker::PullRequestRequested);
    }
    if input.forge_effect_requested {
        blockers.push(GitCommitRunnerCommandAdapterBlocker::ForgeEffectRequested);
    }
    if input.provider_effect_requested {
        blockers.push(GitCommitRunnerCommandAdapterBlocker::ProviderEffectRequested);
    }
    if input.callback_effect_requested {
        blockers.push(GitCommitRunnerCommandAdapterBlocker::CallbackEffectRequested);
    }
    if input.interruption_effect_requested {
        blockers.push(GitCommitRunnerCommandAdapterBlocker::InterruptionEffectRequested);
    }
    if input.recovery_effect_requested {
        blockers.push(GitCommitRunnerCommandAdapterBlocker::RecoveryEffectRequested);
    }
    if input.task_mutation_requested {
        blockers.push(GitCommitRunnerCommandAdapterBlocker::TaskMutationRequested);
    }
}

fn status(
    blockers: &[GitCommitRunnerCommandAdapterBlocker],
) -> GitCommitRunnerCommandAdapterStatus {
    if blockers.is_empty() {
        GitCommitRunnerCommandAdapterStatus::Ready
    } else if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            GitCommitRunnerCommandAdapterBlocker::AuthorityNotReady
                | GitCommitRunnerCommandAdapterBlocker::MissingExecutable
                | GitCommitRunnerCommandAdapterBlocker::MissingRepoWorkingDirectoryRef
                | GitCommitRunnerCommandAdapterBlocker::MissingCommitMessageRef
        )
    }) {
        GitCommitRunnerCommandAdapterStatus::RepairRequired
    } else {
        GitCommitRunnerCommandAdapterStatus::Blocked
    }
}

fn argv(authority: &GitCommitRunnerAuthorityRecord) -> Vec<String> {
    vec![
        "commit".to_owned(),
        "--file".to_owned(),
        authority.commit_message_ref.clone().unwrap_or_default(),
    ]
}
