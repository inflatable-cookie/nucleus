use serde::{Deserialize, Serialize};

use crate::codex_supervision::{
    CodexAppServerLiveExecutorCleanupStatus, CodexAppServerLiveExecutorOutcomeInput,
};
use crate::provider_retention_policy::ProviderRetentionPolicyStatus;
use crate::DurableCodexLiveSmokeDispatchRunRecord;

/// Input for durable live-smoke persistence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableCodexLiveSmokeEvidencePersistenceInput {
    pub run: DurableCodexLiveSmokeDispatchRunRecord,
    pub live_outcome: Option<CodexAppServerLiveExecutorOutcomeInput>,
    pub existing_write_attempt_ids: Vec<String>,
    pub persistence_evidence_refs: Vec<String>,
    pub artifact_refs: Vec<String>,
    pub raw_provider_material_present: bool,
    pub raw_stream_present: bool,
    pub secret_material_present: bool,
    pub credential_material_present: bool,
    pub unbounded_local_path_present: bool,
}

/// Persisted durable live-smoke evidence summary.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DurableCodexLiveSmokeEvidenceRecord {
    pub evidence_id: String,
    pub run_id: String,
    pub boundary_id: String,
    pub command_id: String,
    pub dispatch_attempt_id: String,
    pub handoff_id: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub write_attempt_id: String,
    pub idempotency_key: String,
    pub status: DurableCodexLiveSmokeEvidenceStatus,
    pub retention_status: ProviderRetentionPolicyStatus,
    pub live_executor_outcome_id: Option<String>,
    pub runtime_receipt_id: Option<String>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub final_turn_status: Option<String>,
    pub method_sequence_count: usize,
    pub notification_count: usize,
    pub server_request_count: usize,
    pub cleanup_status: CodexAppServerLiveExecutorCleanupStatus,
    pub evidence_refs: Vec<String>,
    pub artifact_refs: Vec<String>,
    pub duplicate_write_attempt_detected: bool,
    pub provider_write_executed: bool,
    pub executor_invoked: bool,
    pub raw_provider_material_retained: bool,
    pub raw_stream_retained: bool,
    pub task_mutation_permitted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableCodexLiveSmokeEvidenceStatus {
    Persisted,
    DuplicateWriteAttemptNoop,
    Blocked(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct DurableCodexLiveSmokeOutcomeSummary {
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub final_turn_status: Option<String>,
    pub method_sequence_count: usize,
    pub notification_count: usize,
    pub server_request_count: usize,
    pub cleanup_status: CodexAppServerLiveExecutorCleanupStatus,
}

impl From<&crate::CodexAppServerLiveExecutorOutcomeRecord> for DurableCodexLiveSmokeOutcomeSummary {
    fn from(outcome: &crate::CodexAppServerLiveExecutorOutcomeRecord) -> Self {
        Self {
            thread_id: outcome.thread_id.clone(),
            turn_id: outcome.turn_id.clone(),
            final_turn_status: outcome.final_turn_status.clone(),
            method_sequence_count: outcome.method_sequence.len(),
            notification_count: outcome.notification_count,
            server_request_count: outcome.server_request_count,
            cleanup_status: outcome.cleanup_status.clone(),
        }
    }
}
