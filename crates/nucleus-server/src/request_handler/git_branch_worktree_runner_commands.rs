//! Server-owned operator effect intent command wiring for the Git
//! branch/worktree runner.
//!
//! The confirmation command records a durable
//! `GitBranchWorktreeRunnerOperatorEffectIntent::Confirmed` (carrying
//! `allow_isolated_worktree_creation` and the exact target refs) for one run
//! dispatch. It rides the contract-018 admission spine (family
//! `GitBranchWorktreeRunner`), persists the intent record in the artifact
//! metadata domain, and writes a contract-020 runtime receipt. The gated
//! `git worktree add` execution path runs only after this durable intent
//! exists (see `run_git_branch_worktree_runner`). The distinct delivery
//! confirmation records commit message, own branch, worktree location, and
//! remote target for `run_git_branch_worktree_runner_delivery`.

use nucleus_core::RevisionId;
use nucleus_engine::{
    EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId,
    EngineRuntimeReceiptRef, EngineRuntimeReceiptStatus,
};
use nucleus_local_store::{LocalStoreBackend, RevisionExpectation};

use super::handler::LocalControlRequestHandler;
use crate::commands::{
    GitBranchWorktreeRunnerDeliveryEffectConfirmationCommand,
    GitBranchWorktreeRunnerEffectConfirmationCommand,
};
use crate::control_api::{ServerCommandReceiptStatus, ServerControlError};
use crate::provider_git_branch_worktree_runner_authority::{
    write_git_branch_worktree_runner_delivery_intent,
    write_git_branch_worktree_runner_operator_effect_intent,
    GitBranchWorktreeRunnerDeliveryIntentRecord, GitBranchWorktreeRunnerDeliveryIntentStatus,
    GitBranchWorktreeRunnerDeliveryIntentWriteError,
    GitBranchWorktreeRunnerDeliveryIntentWriteOutcome,
    GitBranchWorktreeRunnerOperatorEffectIntentRecord,
    GitBranchWorktreeRunnerOperatorEffectIntentStatus,
    GitBranchWorktreeRunnerOperatorEffectIntentWriteError,
    GitBranchWorktreeRunnerOperatorEffectIntentWriteOutcome,
};
use crate::runtime_receipt_state::write_runtime_receipt;
use crate::ServerStateService;

pub(crate) fn handle_git_branch_worktree_runner_delivery_command<B>(
    handler: &LocalControlRequestHandler<B>,
    command_id: &str,
    command: GitBranchWorktreeRunnerDeliveryEffectConfirmationCommand,
) -> ServerCommandReceiptStatus
where
    B: LocalStoreBackend + Clone,
{
    if command.handoff_id.trim().is_empty()
        || command.branch_ref.trim().is_empty()
        || command.worktree_location_ref.trim().is_empty()
        || command.commit_message.trim().is_empty()
        || command.remote_target.trim().is_empty()
        || command.operator_ref.trim().is_empty()
        || command.idempotency_key.trim().is_empty()
        || command.commit_message.contains('\0')
        || command.remote_target.starts_with('-')
        || command.remote_target.contains('\0')
    {
        return ServerCommandReceiptStatus::Rejected(ServerControlError::InvalidRequest {
            reason: "delivery confirmation requires a handoff, own branch, isolated worktree, commit message, remote target, operator, and idempotency key".to_owned(),
        });
    }
    if command.commit_message.len() > 16 * 1024 {
        return ServerCommandReceiptStatus::Rejected(ServerControlError::InvalidRequest {
            reason: "delivery commit message exceeds its size limit".to_owned(),
        });
    }
    if let Some(scope) = &command.pull_request_creation {
        if !scope.is_complete() {
            return ServerCommandReceiptStatus::Rejected(ServerControlError::InvalidRequest {
                reason: "delivery PR-creation scope requires a complete forge provider, base branch, head branch, title source, and body source".to_owned(),
            });
        }
        if scope.head_branch != command.branch_ref {
            return ServerCommandReceiptStatus::Rejected(ServerControlError::InvalidRequest {
                reason: "delivery PR-creation head branch must be the run's own branch".to_owned(),
            });
        }
        if scope.base_branch == command.branch_ref {
            return ServerCommandReceiptStatus::Rejected(ServerControlError::InvalidRequest {
                reason: "delivery PR-creation base branch must differ from the run's own branch".to_owned(),
            });
        }
    }
    let record = GitBranchWorktreeRunnerDeliveryIntentRecord {
        confirmation_ref: delivery_confirmation_ref(&command.idempotency_key),
        run_id: command.run_id.0.clone(),
        handoff_id: command.handoff_id,
        branch_ref: command.branch_ref,
        worktree_location_ref: command.worktree_location_ref,
        commit_message: command.commit_message,
        remote_target: command.remote_target,
        pull_request_creation: command.pull_request_creation,
        operator_ref: command.operator_ref,
        idempotency_key: command.idempotency_key,
        status: GitBranchWorktreeRunnerDeliveryIntentStatus::Confirmed,
    };
    write_confirmed_delivery_effect_intent(handler.state(), command_id, record)
}

pub(crate) fn handle_git_branch_worktree_runner_command<B>(
    handler: &LocalControlRequestHandler<B>,
    command_id: &str,
    command: GitBranchWorktreeRunnerEffectConfirmationCommand,
) -> ServerCommandReceiptStatus
where
    B: LocalStoreBackend + Clone,
{
    if command.handoff_id.trim().is_empty() {
        return ServerCommandReceiptStatus::Rejected(ServerControlError::InvalidRequest {
            reason: "operator effect intent confirmation requires a handoff id".to_owned(),
        });
    }
    if command.branch_ref.trim().is_empty() {
        return ServerCommandReceiptStatus::Rejected(ServerControlError::InvalidRequest {
            reason: "operator effect intent confirmation requires a branch ref".to_owned(),
        });
    }
    if command.worktree_location_ref.trim().is_empty() {
        return ServerCommandReceiptStatus::Rejected(ServerControlError::InvalidRequest {
            reason: "operator effect intent confirmation requires a worktree location ref"
                .to_owned(),
        });
    }
    if command.idempotency_key.trim().is_empty() {
        return ServerCommandReceiptStatus::Rejected(ServerControlError::InvalidRequest {
            reason: "operator effect intent confirmation requires an idempotency key".to_owned(),
        });
    }

    let record = GitBranchWorktreeRunnerOperatorEffectIntentRecord {
        confirmation_ref: confirmation_ref(&command.idempotency_key),
        run_id: command.run_id.0.clone(),
        handoff_id: command.handoff_id.clone(),
        branch_ref: command.branch_ref.clone(),
        worktree_location_ref: command.worktree_location_ref.clone(),
        allow_primary_tree_checkout: false,
        allow_isolated_worktree_creation: true,
        operator_ref: command.operator_ref.clone(),
        idempotency_key: command.idempotency_key.clone(),
        status: GitBranchWorktreeRunnerOperatorEffectIntentStatus::Confirmed,
    };

    write_confirmed_worktree_effect_intent(handler.state(), command_id, record)
}

/// Write one durable delivery confirmation and its contract-020 receipt.
pub(crate) fn write_confirmed_delivery_effect_intent<B>(
    state: &ServerStateService<B>,
    command_id: &str,
    record: GitBranchWorktreeRunnerDeliveryIntentRecord,
) -> ServerCommandReceiptStatus
where
    B: LocalStoreBackend,
{
    let confirmation_ref = record.confirmation_ref.clone();
    let run_id = record.run_id.clone();
    let branch_ref = record.branch_ref.clone();
    let remote_target = record.remote_target.clone();
    let write = write_git_branch_worktree_runner_delivery_intent(state, record);
    let created = match write {
        Ok(GitBranchWorktreeRunnerDeliveryIntentWriteOutcome::Created(_)) => true,
        Ok(GitBranchWorktreeRunnerDeliveryIntentWriteOutcome::Replayed(_)) => false,
        Err(GitBranchWorktreeRunnerDeliveryIntentWriteError::Conflict { reason }) => {
            return ServerCommandReceiptStatus::Rejected(ServerControlError::Conflict { reason });
        }
        Err(GitBranchWorktreeRunnerDeliveryIntentWriteError::Storage(error)) => {
            return ServerCommandReceiptStatus::Rejected(ServerControlError::StorageUnavailable {
                reason: format!("{error:?}"),
            });
        }
    };
    if created {
        let receipt = EngineRuntimeReceiptRecord {
            receipt_id: EngineRuntimeReceiptRecordId(format!(
                "receipt:git-branch-worktree-runner-delivery-intent:{confirmation_ref}"
            )),
            family: EngineRuntimeReceiptEffectFamily::CommandExecution,
            status: EngineRuntimeReceiptStatus::Completed,
            command_ref: Some(EngineRuntimeReceiptRef::CommandId(command_id.to_owned())),
            effect_ref: Some(EngineRuntimeReceiptRef::Custom(format!(
                "git-branch-worktree-runner:delivery-intent:confirmed:{run_id}"
            ))),
            evidence_refs: vec![EngineRuntimeReceiptRef::EventId(format!(
                "event:{command_id}:admitted"
            ))],
            artifact_refs: Vec::new(),
            summary: Some(format!(
                "operator confirmed delivery commit and own-branch push for run {} ({} -> {})",
                run_id, branch_ref, remote_target
            )),
        };
        if let Err(error) = write_runtime_receipt(
            state,
            &receipt,
            RevisionId(format!("rev:{confirmation_ref}")),
            RevisionExpectation::MustNotExist,
        ) {
            return ServerCommandReceiptStatus::Rejected(ServerControlError::StorageUnavailable {
                reason: format!("{error:?}"),
            });
        }
    }
    ServerCommandReceiptStatus::AcceptedForStateMutation
}

/// Write one durable operator effect intent confirmation and its contract-020
/// receipt. Shared by the standalone confirmation command and run dispatch
/// (the dispatch dialog's explicit confirmation is the dispatch command).
pub(crate) fn write_confirmed_worktree_effect_intent<B>(
    state: &ServerStateService<B>,
    command_id: &str,
    record: GitBranchWorktreeRunnerOperatorEffectIntentRecord,
) -> ServerCommandReceiptStatus
where
    B: LocalStoreBackend,
{
    let confirmation_ref = record.confirmation_ref.clone();
    let run_id = record.run_id.clone();
    let branch_ref = record.branch_ref.clone();
    let worktree_location_ref = record.worktree_location_ref.clone();
    let write = write_git_branch_worktree_runner_operator_effect_intent(state, record);
    let created = match write {
        Ok(GitBranchWorktreeRunnerOperatorEffectIntentWriteOutcome::Created(_)) => true,
        Ok(GitBranchWorktreeRunnerOperatorEffectIntentWriteOutcome::Replayed(_)) => false,
        Err(GitBranchWorktreeRunnerOperatorEffectIntentWriteError::Conflict { reason }) => {
            return ServerCommandReceiptStatus::Rejected(ServerControlError::Conflict { reason });
        }
        Err(GitBranchWorktreeRunnerOperatorEffectIntentWriteError::Storage(error)) => {
            return ServerCommandReceiptStatus::Rejected(ServerControlError::StorageUnavailable {
                reason: format!("{error:?}"),
            });
        }
    };

    if created {
        let receipt = EngineRuntimeReceiptRecord {
            receipt_id: EngineRuntimeReceiptRecordId(format!(
                "receipt:git-branch-worktree-runner-operator-effect-intent:{confirmation_ref}"
            )),
            family: EngineRuntimeReceiptEffectFamily::CommandExecution,
            status: EngineRuntimeReceiptStatus::Completed,
            command_ref: Some(EngineRuntimeReceiptRef::CommandId(command_id.to_owned())),
            effect_ref: Some(EngineRuntimeReceiptRef::Custom(format!(
                "git-branch-worktree-runner:operator-effect-intent:confirmed:{run_id}"
            ))),
            evidence_refs: vec![EngineRuntimeReceiptRef::EventId(format!(
                "event:{command_id}:admitted"
            ))],
            artifact_refs: Vec::new(),
            summary: Some(format!(
                "operator confirmed isolated worktree creation for run {} ({}@{})",
                run_id, branch_ref, worktree_location_ref
            )),
        };
        if let Err(error) = write_runtime_receipt(
            state,
            &receipt,
            RevisionId(format!("rev:{confirmation_ref}")),
            RevisionExpectation::MustNotExist,
        ) {
            return ServerCommandReceiptStatus::Rejected(ServerControlError::StorageUnavailable {
                reason: format!("{error:?}"),
            });
        }
    }

    ServerCommandReceiptStatus::AcceptedForStateMutation
}

pub(crate) fn confirmation_ref(idempotency_key: &str) -> String {
    format!("operator-confirmation:git-branch-worktree-runner:{idempotency_key}")
}

fn delivery_confirmation_ref(idempotency_key: &str) -> String {
    format!("operator-confirmation:git-branch-worktree-runner-delivery:{idempotency_key}")
}
