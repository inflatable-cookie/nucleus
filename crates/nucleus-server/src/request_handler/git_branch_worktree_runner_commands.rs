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
//! exists (see `run_git_branch_worktree_runner`).

use nucleus_core::RevisionId;
use nucleus_engine::{
    EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId,
    EngineRuntimeReceiptRef, EngineRuntimeReceiptStatus,
};
use nucleus_local_store::{LocalStoreBackend, RevisionExpectation};

use super::handler::LocalControlRequestHandler;
use crate::commands::GitBranchWorktreeRunnerEffectConfirmationCommand;
use crate::control_api::{ServerCommandReceiptStatus, ServerControlError};
use crate::provider_git_branch_worktree_runner_authority::{
    write_git_branch_worktree_runner_operator_effect_intent,
    GitBranchWorktreeRunnerOperatorEffectIntentRecord,
    GitBranchWorktreeRunnerOperatorEffectIntentStatus,
    GitBranchWorktreeRunnerOperatorEffectIntentWriteError,
    GitBranchWorktreeRunnerOperatorEffectIntentWriteOutcome,
};
use crate::runtime_receipt_state::write_runtime_receipt;

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
            reason: "operator effect intent confirmation requires a worktree location ref".to_owned(),
        });
    }
    if command.idempotency_key.trim().is_empty() {
        return ServerCommandReceiptStatus::Rejected(ServerControlError::InvalidRequest {
            reason: "operator effect intent confirmation requires an idempotency key".to_owned(),
        });
    }

    let confirmation_ref =
        confirmation_ref(&command.idempotency_key);
    let record = GitBranchWorktreeRunnerOperatorEffectIntentRecord {
        confirmation_ref: confirmation_ref.clone(),
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

    let write = write_git_branch_worktree_runner_operator_effect_intent(handler.state(), record);
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
                "git-branch-worktree-runner:operator-effect-intent:confirmed:{}",
                command.run_id.0
            ))),
            evidence_refs: vec![EngineRuntimeReceiptRef::EventId(format!(
                "event:{command_id}:admitted"
            ))],
            artifact_refs: Vec::new(),
            summary: Some(format!(
                "operator confirmed isolated worktree creation for run {} ({}@{})",
                command.run_id.0, command.branch_ref, command.worktree_location_ref
            )),
        };
        if let Err(error) = write_runtime_receipt(
            handler.state(),
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
