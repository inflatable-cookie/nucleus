use crate::provider_no_effects::ForgeScmNoEffects;
use crate::{GitPushRemoteTarget, GitPushRunnerAuthorityRecord, GitPushRunnerAuthorityStatus};

use super::types::{
    GitPushRunnerCommandAdapterBlocker, GitPushRunnerCommandAdapterInput,
    GitPushRunnerCommandAdapterRecord, GitPushRunnerCommandAdapterStatus, GitPushRunnerCommandKind,
};

pub(super) fn command_record(
    input: &GitPushRunnerCommandAdapterInput,
    authority: GitPushRunnerAuthorityRecord,
) -> GitPushRunnerCommandAdapterRecord {
    let blockers = blockers(input, &authority);
    let status = status(&blockers);
    let argv = if blockers.is_empty() {
        argv(authority.remote_target.as_ref())
    } else {
        Vec::new()
    };
    let executable_argv_created = status == GitPushRunnerCommandAdapterStatus::Ready;

    GitPushRunnerCommandAdapterRecord {
        command_id: format!("git-push-runner-command:{}", authority.authority_id),
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
        command_kind: GitPushRunnerCommandKind::PushBranch,
        executable: input.executable.clone(),
        argv,
        repo_working_directory_ref: input.repo_working_directory_ref.clone(),
        remote_target: authority.remote_target,
        stdout_limit_bytes: input.stdout_limit_bytes,
        stderr_limit_bytes: input.stderr_limit_bytes,
        status,
        blockers,
        executable_argv_created,
        shell_passthrough_used: false,
        shell_execution_performed: false,
        push_requested: executable_argv_created,
        push_executed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

fn blockers(
    input: &GitPushRunnerCommandAdapterInput,
    authority: &GitPushRunnerAuthorityRecord,
) -> Vec<GitPushRunnerCommandAdapterBlocker> {
    let mut blockers = Vec::new();
    if authority.status != GitPushRunnerAuthorityStatus::ReadyForRunner {
        blockers.push(GitPushRunnerCommandAdapterBlocker::AuthorityNotReady);
    }
    if input.executable.trim().is_empty() {
        blockers.push(GitPushRunnerCommandAdapterBlocker::MissingExecutable);
    }
    if input.repo_working_directory_ref.trim().is_empty() {
        blockers.push(GitPushRunnerCommandAdapterBlocker::MissingRepoWorkingDirectoryRef);
    }
    remote_blockers(authority.remote_target.as_ref(), &mut blockers);
    forbidden_blockers(input, &mut blockers);
    blockers
}

fn remote_blockers(
    target: Option<&GitPushRemoteTarget>,
    blockers: &mut Vec<GitPushRunnerCommandAdapterBlocker>,
) {
    let Some(target) = target else {
        blockers.push(GitPushRunnerCommandAdapterBlocker::MissingRemoteTarget);
        return;
    };
    if target.remote_name.trim().is_empty() {
        blockers.push(GitPushRunnerCommandAdapterBlocker::MissingRemoteName);
    }
    if target.branch_name.trim().is_empty() {
        blockers.push(GitPushRunnerCommandAdapterBlocker::MissingBranchName);
    }
}

fn forbidden_blockers(
    input: &GitPushRunnerCommandAdapterInput,
    blockers: &mut Vec<GitPushRunnerCommandAdapterBlocker>,
) {
    if input.shell_passthrough_requested {
        blockers.push(GitPushRunnerCommandAdapterBlocker::ShellPassthroughRequested);
    }
    if input.raw_output_retention_requested {
        blockers.push(GitPushRunnerCommandAdapterBlocker::RawOutputRetentionRequested);
    }
    if input.pull_request_requested {
        blockers.push(GitPushRunnerCommandAdapterBlocker::PullRequestRequested);
    }
    if input.forge_effect_requested {
        blockers.push(GitPushRunnerCommandAdapterBlocker::ForgeEffectRequested);
    }
    if input.provider_effect_requested {
        blockers.push(GitPushRunnerCommandAdapterBlocker::ProviderEffectRequested);
    }
    if input.callback_effect_requested {
        blockers.push(GitPushRunnerCommandAdapterBlocker::CallbackEffectRequested);
    }
    if input.interruption_effect_requested {
        blockers.push(GitPushRunnerCommandAdapterBlocker::InterruptionEffectRequested);
    }
    if input.recovery_effect_requested {
        blockers.push(GitPushRunnerCommandAdapterBlocker::RecoveryEffectRequested);
    }
    if input.task_mutation_requested {
        blockers.push(GitPushRunnerCommandAdapterBlocker::TaskMutationRequested);
    }
}

fn status(blockers: &[GitPushRunnerCommandAdapterBlocker]) -> GitPushRunnerCommandAdapterStatus {
    if blockers.is_empty() {
        GitPushRunnerCommandAdapterStatus::Ready
    } else if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            GitPushRunnerCommandAdapterBlocker::AuthorityNotReady
                | GitPushRunnerCommandAdapterBlocker::MissingExecutable
                | GitPushRunnerCommandAdapterBlocker::MissingRepoWorkingDirectoryRef
                | GitPushRunnerCommandAdapterBlocker::MissingRemoteTarget
                | GitPushRunnerCommandAdapterBlocker::MissingRemoteName
                | GitPushRunnerCommandAdapterBlocker::MissingBranchName
        )
    }) {
        GitPushRunnerCommandAdapterStatus::RepairRequired
    } else {
        GitPushRunnerCommandAdapterStatus::Blocked
    }
}

fn argv(target: Option<&GitPushRemoteTarget>) -> Vec<String> {
    let target = target.expect("validated target");
    vec![
        "push".to_owned(),
        target.remote_name.clone(),
        format!("HEAD:{}", target.branch_name),
    ]
}
