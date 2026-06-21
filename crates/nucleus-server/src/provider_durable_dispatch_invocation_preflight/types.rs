use serde::{Deserialize, Serialize};

use crate::{
    DurableProviderExecutorDispatchAdmissionRecord, DurableProviderExecutorLane,
    DurableProviderExecutorMethod,
};

/// Stable id for one durable dispatch invocation preflight.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct DurableDispatchInvocationPreflightId(pub String);

/// Input for durable dispatch invocation preflight.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableDispatchInvocationPreflightInput {
    pub admission: DurableProviderExecutorDispatchAdmissionRecord,
    pub operator_confirmation_ref: Option<String>,
    pub provider_ready_evidence_refs: Vec<String>,
    pub runtime_session_evidence_refs: Vec<String>,
    pub invocation_evidence_refs: Vec<String>,
    pub supported_methods: Vec<DurableProviderExecutorMethod>,
    pub in_flight_invocation_attempt_ids: Vec<String>,
    pub stale_admission_evidence: bool,
    pub write_attempt_id: String,
    pub idempotency_key: String,
    pub executor_invocation_requested: bool,
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

/// Durable dispatch invocation preflight record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DurableDispatchInvocationPreflightRecord {
    pub preflight_id: DurableDispatchInvocationPreflightId,
    pub admission_id: String,
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
    pub status: DurableDispatchInvocationPreflightStatus,
    pub blockers: Vec<DurableDispatchInvocationPreflightBlocker>,
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

/// Invocation preflight status.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableDispatchInvocationPreflightStatus {
    AcceptedForInvocationRequest,
    Blocked,
}

/// Why durable dispatch invocation preflight is blocked.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableDispatchInvocationPreflightBlocker {
    AdmissionNotAccepted,
    AdmissionAlreadyExecutedProviderWrite,
    AdmissionPermitsForbiddenAuthority,
    MissingOperatorConfirmation,
    MissingProviderReadyEvidence,
    MissingRuntimeSessionEvidence,
    MissingInvocationEvidence,
    UnsupportedProviderMethod,
    DuplicateInFlightInvocationAttempt,
    StaleAdmissionEvidence,
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
