use crate::provider_no_effects::ForgeScmNoEffects;
use crate::ForgePullRequestExecutionPreflightRecord;

use super::blockers::blockers;
use super::types::{
    ForgePullRequestRunnerAuthorityContext, ForgePullRequestRunnerAuthorityRecord,
    ForgePullRequestRunnerAuthorityStatus, ForgePullRequestRunnerOperatorEffectIntent,
};

pub(super) fn authority_record(
    context: &ForgePullRequestRunnerAuthorityContext,
    preflight: ForgePullRequestExecutionPreflightRecord,
) -> ForgePullRequestRunnerAuthorityRecord {
    let blockers = blockers(context, &preflight);
    let status = if blockers.is_empty() {
        ForgePullRequestRunnerAuthorityStatus::ReadyForRequest
    } else {
        ForgePullRequestRunnerAuthorityStatus::Blocked
    };
    let request_preparation_permitted =
        status == ForgePullRequestRunnerAuthorityStatus::ReadyForRequest;

    ForgePullRequestRunnerAuthorityRecord {
        authority_id: format!(
            "forge-pull-request-runner-authority:{}",
            preflight.preflight_id
        ),
        preflight_id: preflight.preflight_id,
        admission_id: preflight.admission_id,
        pr_evidence_id: preflight.pr_evidence_id,
        pr_descriptor_id: preflight.pr_descriptor_id,
        push_preflight_id: preflight.push_preflight_id,
        request_id: preflight.request_id,
        upstream_authority_id: preflight.authority_id,
        git_plan_id: preflight.git_plan_id,
        task_id: preflight.task_id,
        repo_id: preflight.repo_id,
        operator_ref: preflight.operator_ref,
        operator_confirmation_ref: confirmation_ref(&context.operator_effect_intent),
        remote_target: preflight.remote_target,
        forge_provider: preflight.forge_provider,
        base_branch: preflight.base_branch,
        head_branch: preflight.head_branch,
        title_source: preflight.title_source,
        body_source: preflight.body_source,
        status,
        blockers,
        request_preparation_permitted,
        shell_execution_performed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

fn confirmation_ref(intent: &ForgePullRequestRunnerOperatorEffectIntent) -> Option<String> {
    match intent {
        ForgePullRequestRunnerOperatorEffectIntent::Missing => None,
        ForgePullRequestRunnerOperatorEffectIntent::Confirmed {
            confirmation_ref, ..
        } => Some(confirmation_ref.clone()),
    }
}
