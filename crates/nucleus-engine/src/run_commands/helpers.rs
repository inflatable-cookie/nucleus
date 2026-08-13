//! Run command helpers: transition validation, revision policy, codecs.

use std::time::{SystemTime, UNIX_EPOCH};

use nucleus_core::RevisionId;

use super::model::{
    EngineRunCommandError, EngineRunLifecycleState, EngineRunProposeCommand,
    EngineRunRecordCodecError, EngineRunStorageRecord,
};

/// Allowed lifecycle transitions (contract 033 Lifecycle Rule).
///
/// `proposed -> dispatched -> running -> delivered -> accepted | rejected`;
/// `failed` and `cancelled` are terminal and reachable before delivery.
pub(crate) fn validate_transition<E>(
    from: EngineRunLifecycleState,
    to: EngineRunLifecycleState,
) -> Result<(), EngineRunCommandError<E>> {
    let allowed = match from {
        EngineRunLifecycleState::Proposed => matches!(
            to,
            EngineRunLifecycleState::Dispatched
                | EngineRunLifecycleState::Failed
                | EngineRunLifecycleState::Cancelled
        ),
        EngineRunLifecycleState::Dispatched => matches!(
            to,
            EngineRunLifecycleState::Running
                | EngineRunLifecycleState::Failed
                | EngineRunLifecycleState::Cancelled
        ),
        EngineRunLifecycleState::Running => matches!(
            to,
            EngineRunLifecycleState::Delivered
                | EngineRunLifecycleState::Failed
                | EngineRunLifecycleState::Cancelled
        ),
        EngineRunLifecycleState::Delivered => matches!(
            to,
            EngineRunLifecycleState::Accepted | EngineRunLifecycleState::Rejected
        ),
        EngineRunLifecycleState::Accepted
        | EngineRunLifecycleState::Rejected
        | EngineRunLifecycleState::Failed
        | EngineRunLifecycleState::Cancelled => false,
    };

    if allowed {
        Ok(())
    } else {
        Err(EngineRunCommandError::InvalidTransition { from, to })
    }
}

pub(crate) fn run_codec_error<E>(
    error: EngineRunRecordCodecError,
) -> EngineRunCommandError<E> {
    EngineRunCommandError::InvalidRequest {
        reason: error.reason,
    }
}

pub(crate) fn next_run_revision(command_id: &str) -> RevisionId {
    RevisionId(format!("rev:run:{command_id}"))
}

pub(crate) fn now_unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

pub(crate) fn validate_propose<E>(command: &EngineRunProposeCommand) -> Result<(), EngineRunCommandError<E>> {
    if command.run_id.0.trim().is_empty() {
        return Err(EngineRunCommandError::InvalidRequest {
            reason: "run propose requires a run id".to_owned(),
        });
    }
    if command.project_id.0.trim().is_empty() {
        return Err(EngineRunCommandError::InvalidRequest {
            reason: "run propose requires a project id".to_owned(),
        });
    }
    if command.objective.scope.trim().is_empty() {
        return Err(EngineRunCommandError::InvalidRequest {
            reason: "run propose requires an objective scope".to_owned(),
        });
    }
    if command.provider_instance.trim().is_empty() {
        return Err(EngineRunCommandError::InvalidRequest {
            reason: "run propose requires a provider instance".to_owned(),
        });
    }
    if command.provider_model.trim().is_empty() {
        return Err(EngineRunCommandError::InvalidRequest {
            reason: "run propose requires a provider model".to_owned(),
        });
    }
    Ok(())
}

pub(crate) fn storage_record_from_propose(
    command: &EngineRunProposeCommand,
    at: u64,
) -> EngineRunStorageRecord {
    EngineRunStorageRecord {
        run_id: command.run_id.clone(),
        project_id: command.project_id.0.clone(),
        objective: command.objective.clone(),
        worktree_ref: command.worktree_ref.clone(),
        provider_instance: command.provider_instance.clone(),
        provider_model: command.provider_model.clone(),
        orchestrator_designation: command.orchestrator_designation.clone(),
        operation_id: None,
        conversation_id: None,
        state: EngineRunLifecycleState::Proposed,
        budget: command.budget.clone(),
        closeout: None,
        transitions: Vec::new(),
        created_at: at,
        updated_at: at,
    }
}

pub(crate) fn validate_closeout<E>(summary: &str) -> Result<(), EngineRunCommandError<E>> {
    if summary.trim().is_empty() {
        return Err(EngineRunCommandError::InvalidRequest {
            reason: "run delivery requires a closeout summary".to_owned(),
        });
    }
    Ok(())
}
