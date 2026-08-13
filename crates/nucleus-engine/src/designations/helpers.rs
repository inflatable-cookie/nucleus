//! Designation command helpers: revision policy, codecs, validation.

use std::time::{SystemTime, UNIX_EPOCH};

use nucleus_core::RevisionId;

use super::model::{
    EngineDesignateCommand, EngineOrchestratorDesignation,
    EngineOrchestratorDesignationCodecError, EngineOrchestratorDesignationCommandError,
    EngineOrchestratorDesignationStatus,
};

pub(crate) fn designation_codec_error<E>(
    error: EngineOrchestratorDesignationCodecError,
) -> EngineOrchestratorDesignationCommandError<E> {
    EngineOrchestratorDesignationCommandError::InvalidRequest {
        reason: format!("designation storage payload is invalid: {error:?}"),
    }
}

pub(crate) fn next_designation_revision(command_id: &str) -> RevisionId {
    RevisionId(format!("rev:designation:{command_id}"))
}

pub(crate) fn now_unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

pub(crate) fn validate_designate<E>(
    command: &EngineDesignateCommand,
) -> Result<(), EngineOrchestratorDesignationCommandError<E>> {
    if command.designation_id.0.trim().is_empty() {
        return Err(EngineOrchestratorDesignationCommandError::InvalidRequest {
            reason: "designation requires a designation id".to_owned(),
        });
    }
    if command.project_id.trim().is_empty() {
        return Err(EngineOrchestratorDesignationCommandError::InvalidRequest {
            reason: "designation requires a project id".to_owned(),
        });
    }
    if command.orchestrator_provider_instance.trim().is_empty() {
        return Err(EngineOrchestratorDesignationCommandError::InvalidRequest {
            reason: "designation requires an orchestrator provider instance".to_owned(),
        });
    }
    if !command.designation_id.0.starts_with("designation:") {
        return Err(EngineOrchestratorDesignationCommandError::InvalidRequest {
            reason: format!(
                "designation id must start with \"designation:\", got {}",
                command.designation_id.0
            ),
        });
    }
    let mut actions = command.allowed_actions.clone();
    actions.sort();
    actions.dedup();
    if actions.len() != command.allowed_actions.len() {
        return Err(EngineOrchestratorDesignationCommandError::InvalidRequest {
            reason: "allowed actions must not repeat".to_owned(),
        });
    }
    Ok(())
}

pub(crate) fn storage_designation_from_command(
    command: &EngineDesignateCommand,
    at: u64,
) -> EngineOrchestratorDesignation {
    EngineOrchestratorDesignation {
        designation_id: command.designation_id.0.clone(),
        project_id: command.project_id.clone(),
        orchestrator_provider_instance: command.orchestrator_provider_instance.clone(),
        allowed_worker_provider_instances: command.allowed_worker_provider_instances.clone(),
        allowed_worker_models: command.allowed_worker_models.clone(),
        concurrent_run_budget: command.concurrent_run_budget,
        per_run_token_budget: command.per_run_token_budget,
        per_run_time_budget_seconds: command.per_run_time_budget_seconds,
        allowed_actions: command.allowed_actions.clone(),
        steering_permitted: command.steering_permitted,
        status: EngineOrchestratorDesignationStatus::Active,
        created_at: at,
        updated_at: at,
    }
}
