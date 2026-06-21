use super::super::transport_executor_authority::CodexAppServerTransportExecutorAuthorityRecord;
use super::super::turn_start_stdio_execution_envelope::CodexAppServerTurnStartStdioExecutionEnvelopeRecord;
use super::super::turn_start_transport_execution_persistence::CodexAppServerTurnStartTransportExecutionPersistenceRecord;
use super::super::CodexAppServerTransportExecutorOperatorConfirmation;
use crate::diagnostics_read_models::CodexTransportExecutorDiagnosticsDto;

/// Stable id for one Codex `turn/start` real-write smoke boundary decision.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerTurnStartExecutorSmokeBoundaryId(pub String);

/// Input for the Codex `turn/start` real-write smoke boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTurnStartExecutorSmokeBoundaryInput {
    pub authority: CodexAppServerTransportExecutorAuthorityRecord,
    pub envelope: CodexAppServerTurnStartStdioExecutionEnvelopeRecord,
    pub execution: CodexAppServerTurnStartTransportExecutionPersistenceRecord,
    pub diagnostics: CodexTransportExecutorDiagnosticsDto,
    pub smoke_intent: CodexAppServerTurnStartExecutorSmokeIntent,
    pub operator_confirmation: CodexAppServerTransportExecutorOperatorConfirmation,
    pub raw_payload_policy_confirmed: bool,
    pub raw_stream_policy_confirmed: bool,
    pub task_mutation_requested: bool,
}

/// Explicit opt-in for a real provider write smoke.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTurnStartExecutorSmokeIntent {
    DisabledByDefault,
    RealProviderWriteSmokeRequested { evidence_ref: String },
}

/// Boundary decision for a real provider write smoke.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTurnStartExecutorSmokeBoundaryRecord {
    pub boundary_id: CodexAppServerTurnStartExecutorSmokeBoundaryId,
    pub status: CodexAppServerTurnStartExecutorSmokeBoundaryStatus,
    pub authority_id: String,
    pub envelope_id: String,
    pub execution_id: String,
    pub write_attempt_id: String,
    pub idempotency_key: String,
    pub receipt_id: String,
    pub evidence_refs: Vec<String>,
    pub provider_write_executed: bool,
    pub raw_payload_retained: bool,
    pub raw_stream_retained: bool,
    pub callback_response_permitted: bool,
    pub cancellation_permitted: bool,
    pub retry_scheduled: bool,
    pub task_mutation_permitted: bool,
}

/// Real-write smoke boundary status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTurnStartExecutorSmokeBoundaryStatus {
    EligibleForSeparatelyConfirmedRealWriteSmoke,
    Blocked(Vec<CodexAppServerTurnStartExecutorSmokeBoundaryBlocker>),
}

/// Why a real provider write smoke is not eligible.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTurnStartExecutorSmokeBoundaryBlocker {
    SmokeIntentDisabledByDefault,
    OperatorConfirmationMissing,
    OperatorConfirmationScopeNotRealWriteSmoke,
    AuthorityNotReady,
    EnvelopeNotReady,
    ExecutionReceiptMissing,
    ExecutionEventMissing,
    ExecutionReplayPolicyNotInspectOnly,
    DiagnosticsMissingAuthority,
    DiagnosticsMissingEnvelope,
    DiagnosticsMissingExecution,
    DiagnosticsGrantProviderControl,
    DiagnosticsGrantTaskMutation,
    DiagnosticsExposeProviderMaterial,
    DiagnosticsExposeRawStreams,
    WriteAttemptIdentityMismatch,
    ProviderInstanceIdentityMismatch,
    ProviderWriteAlreadyExecuted,
    RawPayloadPolicyUnconfirmed,
    RawStreamPolicyUnconfirmed,
    TaskMutationRequested,
}
