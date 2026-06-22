//! Provider live-read executor diagnostics response DTO.

use serde::{Deserialize, Serialize};

use crate::ProviderLiveReadServerExecutorDiagnostics;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlProviderLiveReadExecutorDiagnosticsDto {
    pub diagnostics_id: String,
    pub request_count: usize,
    pub ready_request_count: usize,
    pub blocked_request_count: usize,
    pub descriptor_ready_count: usize,
    pub sanitized_output_count: usize,
    pub parse_error_count: usize,
    pub receipt_count: usize,
    pub provider_network_read_performed_count: usize,
    pub blocker_count: usize,
    pub provider_write_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

impl From<&ProviderLiveReadServerExecutorDiagnostics>
    for ControlProviderLiveReadExecutorDiagnosticsDto
{
    fn from(diagnostics: &ProviderLiveReadServerExecutorDiagnostics) -> Self {
        Self {
            diagnostics_id: diagnostics.diagnostics_id.clone(),
            request_count: diagnostics.request_count,
            ready_request_count: diagnostics.ready_request_count,
            blocked_request_count: diagnostics.blocked_request_count,
            descriptor_ready_count: diagnostics.descriptor_ready_count,
            sanitized_output_count: diagnostics.sanitized_output_count,
            parse_error_count: diagnostics.parse_error_count,
            receipt_count: diagnostics.receipt_count,
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
