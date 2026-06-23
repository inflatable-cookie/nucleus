use serde::{Deserialize, Serialize};

use super::ProviderLiveReadStatusCheckSmokeRequestRecord;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderLiveReadStatusCheckSmokeEvidenceInput {
    pub request: ProviderLiveReadStatusCheckSmokeRequestRecord,
    pub evidence_ref: Option<String>,
    pub selected_command_scope_confirmed: bool,
    pub command_exit_code: Option<i32>,
    pub check_count: usize,
    pub pass_count: usize,
    pub fail_count: usize,
    pub pending_count: usize,
    pub skipping_count: usize,
    pub cancel_count: usize,
    pub provider_network_call_performed: bool,
    pub provider_write_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadStatusCheckSmokeEvidenceRecord {
    pub evidence_id: String,
    pub evidence_ref: Option<String>,
    pub request_id: String,
    pub remote_repo_ref: Option<String>,
    pub pull_request_ref: Option<String>,
    pub selected_fields: Vec<String>,
    pub command_exit_code: Option<i32>,
    pub check_count: usize,
    pub pass_count: usize,
    pub fail_count: usize,
    pub pending_count: usize,
    pub skipping_count: usize,
    pub cancel_count: usize,
    pub status: ProviderLiveReadStatusCheckSmokeEvidenceStatus,
    pub blockers: Vec<ProviderLiveReadStatusCheckSmokeEvidenceBlocker>,
    pub selected_command_scope_confirmed: bool,
    pub provider_network_call_performed: bool,
    pub provider_write_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadStatusCheckSmokeEvidenceStatus {
    Promoted,
    RepairRequired,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadStatusCheckSmokeEvidenceBlocker {
    RequestNotStopped,
    MissingEvidenceRef,
    SelectedCommandScopeNotConfirmed,
    ProviderReadNotPerformed,
    EmptyCheckSet,
    CheckCountMismatch,
    ProviderWriteExecuted,
    TaskMutationExecuted,
    RawProviderPayloadRetained,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadStatusCheckSmokeEvidenceDiagnostics {
    pub diagnostics_id: String,
    pub evidence_count: usize,
    pub promoted_count: usize,
    pub repair_required_count: usize,
    pub blocked_count: usize,
    pub total_check_count: usize,
    pub total_pass_count: usize,
    pub total_fail_count: usize,
    pub total_pending_count: usize,
    pub total_skipping_count: usize,
    pub total_cancel_count: usize,
    pub blocker_count: usize,
    pub provider_network_read_performed_count: usize,
    pub provider_write_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}
