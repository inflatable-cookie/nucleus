use crate::provider_no_effects::{ForgeScmNoEffects};
use crate::GitPushPreflightRecord;

use super::blockers::blockers;
use super::types::{
    GitPushRunnerAuthorityContext, GitPushRunnerAuthorityRecord, GitPushRunnerAuthorityStatus,
    GitPushRunnerOperatorEffectIntent,
};

pub(super) fn authority_record(
    context: &GitPushRunnerAuthorityContext,
    preflight: GitPushPreflightRecord,
) -> GitPushRunnerAuthorityRecord {
    let blockers = blockers(context, &preflight);
    let status = if blockers.is_empty() {
        GitPushRunnerAuthorityStatus::ReadyForRunner
    } else {
        GitPushRunnerAuthorityStatus::Blocked
    };
    let runner_invocation_permitted = status == GitPushRunnerAuthorityStatus::ReadyForRunner;

    GitPushRunnerAuthorityRecord {
        authority_id: format!("git-push-runner-authority:{}", preflight.preflight_id),
        preflight_id: preflight.preflight_id,
        descriptor_id: preflight.descriptor_id,
        admission_id: preflight.admission_id,
        commit_preflight_id: preflight.commit_preflight_id,
        commit_descriptor_id: preflight.commit_descriptor_id,
        commit_admission_id: preflight.commit_admission_id,
        branch_worktree_evidence_id: preflight.branch_worktree_evidence_id,
        request_id: preflight.request_id,
        upstream_authority_id: preflight.authority_id,
        git_plan_id: preflight.git_plan_id,
        task_id: preflight.task_id,
        repo_id: preflight.repo_id,
        operator_ref: preflight.operator_ref,
        operator_confirmation_ref: operator_confirmation_ref(&context.operator_effect_intent),
        remote_target: preflight.remote_target,
        status,
        blockers,
        runner_invocation_permitted,
        shell_execution_performed: false,
        push_executed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

fn operator_confirmation_ref(intent: &GitPushRunnerOperatorEffectIntent) -> Option<String> {
    match intent {
        GitPushRunnerOperatorEffectIntent::Missing => None,
        GitPushRunnerOperatorEffectIntent::Confirmed {
            confirmation_ref, ..
        } => Some(confirmation_ref.clone()),
    }
}
