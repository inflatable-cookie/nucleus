use serde::{Deserialize, Serialize};

use crate::{
    DurableProviderExecutorDispatchSelectionRecord, DurableProviderExecutorLane,
    DurableProviderExecutorMethod,
};

/// Stable id for one durable executor dispatch admission record.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct DurableProviderExecutorDispatchAdmissionId(pub String);

/// Input for admitting a selected durable executor command to dispatch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableProviderExecutorDispatchAdmissionInput {
    pub selection: DurableProviderExecutorDispatchSelectionRecord,
    pub dispatch_attempt_id: String,
    pub operator_confirmation_ref: Option<String>,
    pub runtime_session_evidence_refs: Vec<String>,
    pub provider_ready_evidence_refs: Vec<String>,
    pub admission_evidence_refs: Vec<String>,
    pub write_attempt_id: String,
    pub idempotency_key: String,
    pub invoke_executor_requested: bool,
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

/// Durable executor dispatch admission record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DurableProviderExecutorDispatchAdmissionRecord {
    pub admission_id: DurableProviderExecutorDispatchAdmissionId,
    pub selection_id: String,
    pub command_id: String,
    pub dispatch_attempt_id: String,
    pub lane: DurableProviderExecutorLane,
    pub lane_admission_id: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub write_attempt_id: String,
    pub idempotency_key: String,
    pub task_id: Option<String>,
    pub work_item_id: Option<String>,
    pub method: DurableProviderExecutorMethod,
    pub status: DurableProviderExecutorDispatchAdmissionStatus,
    pub blockers: Vec<DurableProviderExecutorDispatchAdmissionBlocker>,
    pub evidence_refs: Vec<String>,
    pub operator_confirmation_ref: Option<String>,
    pub executor_invoked: bool,
    pub provider_write_executed: bool,
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

/// Dispatch admission status.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableProviderExecutorDispatchAdmissionStatus {
    AcceptedForDispatch,
    Blocked,
}

/// Why dispatch admission is blocked.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableProviderExecutorDispatchAdmissionBlocker {
    SelectionNotAccepted,
    SelectionAlreadySelectedProviderWrite,
    SelectionPermitsForbiddenAuthority,
    MissingDispatchAttemptId,
    MissingOperatorConfirmation,
    MissingRuntimeSessionEvidence,
    MissingProviderReadyEvidence,
    MissingAdmissionEvidence,
    WriteAttemptMismatch,
    IdempotencyMismatch,
    ExecutorInvocationRequested,
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
