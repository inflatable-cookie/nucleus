//! Provider live-read smoke evidence diagnostics response DTO.

use serde::{Deserialize, Serialize};

use crate::ProviderLiveReadApprovedSmokeEvidenceDiagnostics;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlProviderLiveReadSmokeEvidenceDiagnosticsDto {
    pub diagnostics_id: String,
    #[ts(as = "u32")]
    pub evidence_count: usize,
    #[ts(as = "u32")]
    pub promoted_count: usize,
    #[ts(as = "u32")]
    pub repair_required_count: usize,
    #[ts(as = "u32")]
    pub blocked_count: usize,
    #[ts(as = "u32")]
    pub duplicate_count: usize,
    #[ts(as = "u32")]
    pub provider_network_read_performed_count: usize,
    #[ts(as = "u32")]
    pub blocker_count: usize,
    pub provider_write_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

impl From<&ProviderLiveReadApprovedSmokeEvidenceDiagnostics>
    for ControlProviderLiveReadSmokeEvidenceDiagnosticsDto
{
    fn from(diagnostics: &ProviderLiveReadApprovedSmokeEvidenceDiagnostics) -> Self {
        Self {
            diagnostics_id: diagnostics.diagnostics_id.clone(),
            evidence_count: diagnostics.evidence_count,
            promoted_count: diagnostics.promoted_count,
            repair_required_count: diagnostics.repair_required_count,
            blocked_count: diagnostics.blocked_count,
            duplicate_count: diagnostics.duplicate_count,
            provider_network_read_performed_count: diagnostics
                .provider_network_read_performed_count,
            blocker_count: diagnostics.blocker_count,
            provider_write_executed: diagnostics.provider_write_executed,
            callback_effect_executed: diagnostics.callback_effect_executed,
            interruption_effect_executed: diagnostics.interruption_effect_executed,
            recovery_effect_executed: diagnostics.recovery_effect_executed,
            task_mutation_executed: diagnostics.task_mutation_executed,
            raw_provider_payload_retained: diagnostics.raw_provider_payload_retained,
        }
    }
}
