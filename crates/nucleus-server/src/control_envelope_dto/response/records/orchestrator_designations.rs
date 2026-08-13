use nucleus_engine::{
    EngineDelegationAction, EngineOrchestratorDesignation, EngineOrchestratorDesignationStatus,
};
use serde::{Deserialize, Serialize};

use crate::control_envelope_dto::commands::ControlDelegationActionDto;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlOrchestratorDesignationDto {
    pub designation_id: String,
    pub project_id: String,
    pub orchestrator_provider_instance: String,
    pub allowed_worker_provider_instances: Option<Vec<String>>,
    pub allowed_worker_models: Option<Vec<String>>,
    pub concurrent_run_budget: u64,
    pub per_run_token_budget: Option<u64>,
    pub per_run_time_budget_seconds: Option<u64>,
    pub allowed_actions: Vec<ControlDelegationActionDto>,
    pub steering_permitted: bool,
    pub status: String,
    pub revision_id: String,
    pub created_at: u64,
    pub updated_at: u64,
}

impl From<&EngineOrchestratorDesignation> for ControlOrchestratorDesignationDto {
    fn from(designation: &EngineOrchestratorDesignation) -> Self {
        Self {
            designation_id: designation.designation_id.clone(),
            project_id: designation.project_id.clone(),
            orchestrator_provider_instance: designation.orchestrator_provider_instance.clone(),
            allowed_worker_provider_instances: designation
                .allowed_worker_provider_instances
                .clone(),
            allowed_worker_models: designation.allowed_worker_models.clone(),
            concurrent_run_budget: designation.concurrent_run_budget,
            per_run_token_budget: designation.per_run_token_budget,
            per_run_time_budget_seconds: designation.per_run_time_budget_seconds,
            allowed_actions: designation
                .allowed_actions
                .iter()
                .map(action_dto)
                .collect(),
            steering_permitted: designation.steering_permitted,
            status: status_dto(designation.status),
            revision_id: String::new(),
            created_at: designation.created_at,
            updated_at: designation.updated_at,
        }
    }
}

pub(crate) fn action_dto(action: &EngineDelegationAction) -> ControlDelegationActionDto {
    match action {
        EngineDelegationAction::Delegate => ControlDelegationActionDto::Delegate,
        EngineDelegationAction::RunStatus => ControlDelegationActionDto::RunStatus,
        EngineDelegationAction::CancelRun => ControlDelegationActionDto::CancelRun,
        EngineDelegationAction::AcceptDelivery => ControlDelegationActionDto::AcceptDelivery,
        EngineDelegationAction::RejectDelivery => ControlDelegationActionDto::RejectDelivery,
    }
}

pub(crate) fn status_dto(status: EngineOrchestratorDesignationStatus) -> String {
    match status {
        EngineOrchestratorDesignationStatus::Active => "active",
        EngineOrchestratorDesignationStatus::Revoked => "revoked",
    }
    .to_owned()
}
