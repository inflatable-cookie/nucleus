use serde::{Deserialize, Serialize};

use super::{
    ProviderLiveReadCommandResultMappingRecord, ProviderLiveReadCommandSmokeRequestRecord,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderLiveReadApprovedSmokeEvidenceInput {
    pub request: ProviderLiveReadCommandSmokeRequestRecord,
    pub mapping: ProviderLiveReadCommandResultMappingRecord,
    pub evidence_ref: Option<String>,
    pub existing_evidence_ids: Vec<String>,
    pub provider_write_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadApprovedSmokeEvidenceRecord {
    pub evidence_id: String,
    pub evidence_ref: Option<String>,
    pub command_smoke_request_id: String,
    pub handoff_id: String,
    pub command_descriptor_id: String,
    pub executor_request_id: String,
    pub output_record_id: String,
    pub receipt_id: String,
    pub name_with_owner: Option<String>,
    pub default_branch: Option<String>,
    pub is_private: Option<bool>,
    pub visibility: Option<String>,
    pub url: Option<String>,
    pub viewer_permission: Option<String>,
    pub pushed_at: Option<String>,
    pub updated_at: Option<String>,
    pub status: ProviderLiveReadApprovedSmokeEvidenceStatus,
    pub blockers: Vec<ProviderLiveReadApprovedSmokeEvidenceBlocker>,
    pub duplicate_evidence_detected: bool,
    pub provider_network_call_performed: bool,
    pub provider_write_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadApprovedSmokeEvidenceStatus {
    Promoted,
    RepairRequired,
    Blocked,
    DuplicateNoop,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadApprovedSmokeEvidenceBlocker {
    CommandSmokeRequestNotStopped,
    MappingNotSanitized,
    ReceiptNotProviderReadPerformed,
    RequestHandoffMismatch,
    MissingEvidenceRef,
    DuplicateEvidence,
    ProviderWriteExecuted,
    CallbackEffectExecuted,
    InterruptionEffectExecuted,
    RecoveryEffectExecuted,
    TaskMutationExecuted,
    RawProviderPayloadRetained,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadApprovedSmokeEvidenceDiagnostics {
    pub diagnostics_id: String,
    pub evidence_count: usize,
    pub promoted_count: usize,
    pub repair_required_count: usize,
    pub blocked_count: usize,
    pub duplicate_count: usize,
    pub provider_network_read_performed_count: usize,
    pub blocker_count: usize,
    pub provider_write_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}
