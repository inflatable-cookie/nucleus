use serde::{Deserialize, Serialize};

use crate::{
    DurableProviderExecutorCommandRecord, DurableProviderExecutorLane,
    DurableProviderExecutorMethod, DurableProviderExecutorState,
    DurableProviderExecutorStatusRecord,
};

/// Stable id for one durable executor dispatch selection record.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct DurableProviderExecutorDispatchSelectionId(pub String);

/// Input for selecting a durable executor command for dispatch admission.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableProviderExecutorDispatchSelectionInput {
    pub command: DurableProviderExecutorCommandRecord,
    pub latest_status: Option<DurableProviderExecutorStatusRecord>,
    pub provider_ready_evidence_refs: Vec<String>,
    pub runtime_ready_evidence_refs: Vec<String>,
    pub selection_evidence_refs: Vec<String>,
    pub in_flight_write_attempt_ids: Vec<String>,
    pub stale_command_evidence: bool,
    pub background_execution_requested: bool,
    pub provider_write_requested: bool,
    pub raw_provider_material_requested: bool,
    pub raw_callback_material_requested: bool,
    pub task_mutation_requested: bool,
    pub review_acceptance_requested: bool,
    pub callback_answer_requested: bool,
    pub interruption_requested: bool,
    pub recovery_requested: bool,
    pub replacement_thread_promotion_requested: bool,
    pub scm_mutation_requested: bool,
}

/// Durable executor command dispatch selection record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DurableProviderExecutorDispatchSelectionRecord {
    pub selection_id: DurableProviderExecutorDispatchSelectionId,
    pub command_id: String,
    pub lane: DurableProviderExecutorLane,
    pub lane_admission_id: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub write_attempt_id: String,
    pub idempotency_key: String,
    pub task_id: Option<String>,
    pub work_item_id: Option<String>,
    pub method: DurableProviderExecutorMethod,
    pub latest_status_state: Option<DurableProviderExecutorState>,
    pub status: DurableProviderExecutorDispatchSelectionStatus,
    pub blockers: Vec<DurableProviderExecutorDispatchSelectionBlocker>,
    pub evidence_refs: Vec<String>,
    pub operator_confirmation_ref: Option<String>,
    pub executor_invoked: bool,
    pub provider_write_selected: bool,
    pub client_authority_granted: bool,
    pub raw_provider_material_retained: bool,
    pub raw_callback_material_retained: bool,
    pub task_mutation_permitted: bool,
    pub review_acceptance_permitted: bool,
    pub callback_answer_permitted: bool,
    pub interruption_permitted: bool,
    pub recovery_permitted: bool,
    pub replacement_thread_promotion_permitted: bool,
    pub scm_mutation_permitted: bool,
}

/// Selection status.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableProviderExecutorDispatchSelectionStatus {
    SelectedForDispatchAdmission,
    Blocked,
}

/// Why a durable executor command cannot be selected for dispatch admission.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableProviderExecutorDispatchSelectionBlocker {
    CommandNotAccepted,
    CommandAlreadyExecutedProviderWrite,
    CommandPermitsForbiddenAuthority,
    LatestStatusInFlight,
    LatestStatusTerminal,
    LatestStatusInvalid,
    MissingOperatorConfirmation,
    MissingRuntimeSessionRef,
    MissingProviderReadyEvidence,
    MissingRuntimeReadyEvidence,
    MissingSelectionEvidence,
    DuplicateInFlightWriteAttempt,
    StaleCommandEvidence,
    BackgroundExecutionRequested,
    ProviderWriteRequested,
    RawProviderMaterialRequested,
    RawCallbackMaterialRequested,
    TaskMutationRequested,
    ReviewAcceptanceRequested,
    CallbackAnswerRequested,
    InterruptionRequested,
    RecoveryRequested,
    ReplacementThreadPromotionRequested,
    ScmMutationRequested,
}
