use serde::{Deserialize, Serialize};

use crate::{ForgeReadIntentProjectionControlDto, ForgeReadIntentProjectionSet};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeReadIntentQueryResult {
    pub query_id: String,
    pub projection: ForgeReadIntentProjectionSet,
    pub source_counts: ForgeReadIntentQuerySourceCounts,
    pub control: ForgeReadIntentQueryControlDto,
    pub credential_resolution_performed: bool,
    pub provider_network_call_performed: bool,
    pub provider_effect_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeReadIntentQuerySourceCounts {
    pub credential_status_records: usize,
    pub repository_metadata_records: usize,
    pub pull_request_records: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeReadIntentQueryControlDto {
    pub dto_id: String,
    pub projection_control: ForgeReadIntentProjectionControlDto,
    pub source_counts: ForgeReadIntentQuerySourceCounts,
    pub credential_resolution_performed: bool,
    pub provider_network_call_performed: bool,
    pub provider_effect_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}
