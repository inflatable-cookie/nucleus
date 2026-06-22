use crate::GitCommitPreflightRecord;

use super::blockers::blockers;
use super::types::{
    GitCommitRunnerAuthorityContext, GitCommitRunnerAuthorityRecord,
    GitCommitRunnerAuthorityStatus, GitCommitRunnerOperatorEffectIntent,
};

pub(super) fn authority_record(
    context: &GitCommitRunnerAuthorityContext,
    preflight: GitCommitPreflightRecord,
) -> GitCommitRunnerAuthorityRecord {
    let target_ref = context
        .target_refs
        .iter()
        .find(|target| target.preflight_id == preflight.preflight_id);
    let blockers = blockers(context, &preflight, target_ref);
    let status = if blockers.is_empty() {
        GitCommitRunnerAuthorityStatus::ReadyForRunner
    } else {
        GitCommitRunnerAuthorityStatus::Blocked
    };
    let runner_invocation_permitted = status == GitCommitRunnerAuthorityStatus::ReadyForRunner;

    GitCommitRunnerAuthorityRecord {
        authority_id: format!("git-commit-runner-authority:{}", preflight.preflight_id),
        preflight_id: preflight.preflight_id,
        descriptor_id: preflight.descriptor_id,
        admission_id: preflight.admission_id,
        branch_worktree_evidence_id: preflight.branch_worktree_evidence_id,
        branch_worktree_outcome_id: preflight.branch_worktree_outcome_id,
        branch_worktree_handoff_id: preflight.branch_worktree_handoff_id,
        branch_worktree_preflight_id: preflight.branch_worktree_preflight_id,
        branch_worktree_descriptor_id: preflight.branch_worktree_descriptor_id,
        branch_worktree_admission_id: preflight.branch_worktree_admission_id,
        dry_run_evidence_id: preflight.dry_run_evidence_id,
        dry_run_outcome_id: preflight.dry_run_outcome_id,
        dry_run_handoff_id: preflight.dry_run_handoff_id,
        request_id: preflight.request_id,
        upstream_authority_id: preflight.authority_id,
        git_plan_id: preflight.git_plan_id,
        task_id: preflight.task_id,
        repo_id: preflight.repo_id,
        operator_ref: preflight.operator_ref,
        operator_confirmation_ref: operator_confirmation_ref(&context.operator_effect_intent),
        worktree_mode: preflight.worktree_mode,
        commit_message_source: preflight.commit_message_source,
        commit_message_ref: target_ref.and_then(|target| target.commit_message_ref.clone()),
        status,
        blockers,
        runner_invocation_permitted,
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

fn operator_confirmation_ref(intent: &GitCommitRunnerOperatorEffectIntent) -> Option<String> {
    match intent {
        GitCommitRunnerOperatorEffectIntent::Missing => None,
        GitCommitRunnerOperatorEffectIntent::Confirmed {
            confirmation_ref, ..
        } => Some(confirmation_ref.clone()),
    }
}
