//! Engine-owned orchestrator designation service.
//!
//! The designation aggregate (contract 033 Orchestrator Designation Rule)
//! binds an operator-chosen provider instance to a project as orchestrator,
//! carrying the deny-by-default grant envelope. Designate and revoke are
//! commands; the spine event journal and runtime receipts record each.

mod helpers;
mod model;
mod service;

#[cfg(test)]
mod tests;

pub use model::{
    decode_orchestrator_designation, encode_orchestrator_designation,
    EngineDelegationAction, EngineDesignateCommand, EngineOrchestratorDesignation,
    EngineOrchestratorDesignationCodecError, EngineOrchestratorDesignationCommand,
    EngineOrchestratorDesignationCommandError, EngineOrchestratorDesignationCommandOutcome,
    EngineOrchestratorDesignationId, EngineOrchestratorDesignationRecord,
    EngineOrchestratorDesignationRepository, EngineOrchestratorDesignationStatus,
    EngineRevokeDesignationCommand,
};
pub use service::{
    designation_from_record, designation_record_id, designation_revision,
    EngineOrchestratorDesignationService,
};

/// Default designation id for a project + provider instance pair.
pub fn designation_id_for(project_id: &str, instance: &str) -> EngineOrchestratorDesignationId {
    EngineOrchestratorDesignationId(format!("designation:{project_id}:{instance}"))
}
