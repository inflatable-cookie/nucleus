use crate::provider_no_effects::{ForgeScmNoEffects};
use crate::{GitBranchWorktreeExecutionHandoffRecord, GitBranchWorktreeMode};

use super::blockers::blockers;
use super::types::{
    GitBranchWorktreeRunnerAction, GitBranchWorktreeRunnerAuthorityContext,
    GitBranchWorktreeRunnerAuthorityRecord, GitBranchWorktreeRunnerAuthorityStatus,
    GitBranchWorktreeRunnerOperatorEffectIntent,
};

pub(super) fn authority_record(
    context: &GitBranchWorktreeRunnerAuthorityContext,
    handoff: GitBranchWorktreeExecutionHandoffRecord,
) -> GitBranchWorktreeRunnerAuthorityRecord {
    let target_ref = context
        .target_refs
        .iter()
        .find(|target| target.handoff_id == handoff.handoff_id);
    let blockers = blockers(context, &handoff, target_ref);
    let status = if blockers.is_empty() {
        GitBranchWorktreeRunnerAuthorityStatus::ReadyForRunner
    } else {
        GitBranchWorktreeRunnerAuthorityStatus::Blocked
    };
    let operator_confirmation_ref = operator_confirmation_ref(&context.operator_effect_intent);
    let runner_action = runner_action(&handoff.worktree_mode);
    let runner_invocation_permitted =
        status == GitBranchWorktreeRunnerAuthorityStatus::ReadyForRunner;

    GitBranchWorktreeRunnerAuthorityRecord {
        authority_id: format!(
            "git-branch-worktree-runner-authority:{}",
            handoff.handoff_id
        ),
        handoff_id: handoff.handoff_id,
        preflight_id: handoff.preflight_id,
        descriptor_id: handoff.descriptor_id,
        admission_id: handoff.admission_id,
        dry_run_evidence_id: handoff.dry_run_evidence_id,
        dry_run_outcome_id: handoff.dry_run_outcome_id,
        dry_run_handoff_id: handoff.dry_run_handoff_id,
        request_id: handoff.request_id,
        upstream_authority_id: handoff.authority_id,
        git_plan_id: handoff.git_plan_id,
        task_id: handoff.task_id,
        repo_id: handoff.repo_id,
        operator_ref: handoff.operator_ref,
        operator_confirmation_ref,
        worktree_mode: handoff.worktree_mode,
        runner_action,
        branch_ref: target_ref.and_then(|target| target.branch_ref.clone()),
        worktree_location_ref: target_ref.and_then(|target| target.worktree_location_ref.clone()),
        status,
        blockers,
        runner_invocation_permitted,
        shell_execution_performed: false,
        checkout_executed: false,
        branch_created: false,
        worktree_created: false,
        commit_created: false,
        push_executed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

fn operator_confirmation_ref(
    intent: &GitBranchWorktreeRunnerOperatorEffectIntent,
) -> Option<String> {
    match intent {
        GitBranchWorktreeRunnerOperatorEffectIntent::Missing => None,
        GitBranchWorktreeRunnerOperatorEffectIntent::Confirmed {
            confirmation_ref, ..
        } => Some(confirmation_ref.clone()),
    }
}

fn runner_action(mode: &GitBranchWorktreeMode) -> GitBranchWorktreeRunnerAction {
    match mode {
        GitBranchWorktreeMode::PrimaryTree => {
            GitBranchWorktreeRunnerAction::CheckoutTemporaryBranch
        }
        GitBranchWorktreeMode::IsolatedWorktree => {
            GitBranchWorktreeRunnerAction::CreateIsolatedWorktree
        }
    }
}
