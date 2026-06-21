//! Read-only control DTOs for adapter-neutral change-request chains.

use serde::{Deserialize, Serialize};

use crate::{
    AdapterNeutralChangeRequestChainDiagnosticsRecord,
    AdapterNeutralChangeRequestChainPersistenceSet,
    AdapterNeutralChangeRequestChainPersistenceStatus,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AdapterNeutralChangeRequestChainControlDto {
    pub dto_id: String,
    pub diagnostics_id: String,
    pub persisted_projection_count: usize,
    pub duplicate_projection_count: usize,
    pub blocked_projection_count: usize,
    pub stage_count: usize,
    pub ready_stage_count: usize,
    pub blocked_stage_count: usize,
    pub unsupported_stage_count: usize,
    pub blocker_count: usize,
    pub git_like_provider_ref_count: usize,
    pub convergence_like_provider_ref_count: usize,
    pub unsupported_provider_ref_count: usize,
    pub mutation_authority_granted: bool,
    pub scm_execution_permitted: bool,
    pub forge_execution_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_material_retained: bool,
}

pub fn adapter_neutral_change_request_chain_control_dto(
    persistence: AdapterNeutralChangeRequestChainPersistenceSet,
    diagnostics: AdapterNeutralChangeRequestChainDiagnosticsRecord,
) -> AdapterNeutralChangeRequestChainControlDto {
    AdapterNeutralChangeRequestChainControlDto {
        dto_id: "adapter-neutral-change-request-chain-control-dto".to_owned(),
        diagnostics_id: diagnostics.diagnostics_id,
        persisted_projection_count: persistence
            .records
            .iter()
            .filter(|record| {
                record.status == AdapterNeutralChangeRequestChainPersistenceStatus::Persisted
            })
            .count(),
        duplicate_projection_count: persistence.duplicate_projection_ids.len(),
        blocked_projection_count: persistence.blocked_projection_ids.len(),
        stage_count: diagnostics.stage_count,
        ready_stage_count: diagnostics.ready_count,
        blocked_stage_count: diagnostics.blocked_count,
        unsupported_stage_count: diagnostics.unsupported_count,
        blocker_count: diagnostics.blocker_count,
        git_like_provider_ref_count: diagnostics.git_like_provider_ref_count,
        convergence_like_provider_ref_count: diagnostics.convergence_like_provider_ref_count,
        unsupported_provider_ref_count: diagnostics.unsupported_provider_ref_count,
        mutation_authority_granted: false,
        scm_execution_permitted: false,
        forge_execution_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_material_retained: false,
    }
}

#[cfg(test)]
#[path = "provider_adapter_neutral_change_request_chain_control_dto/tests.rs"]
mod tests;
