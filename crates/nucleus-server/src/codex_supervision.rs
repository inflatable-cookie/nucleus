//! Compile-only Codex app-server supervision boundary.
//!
//! These records describe whether Nucleus may consider starting a Codex
//! app-server process. They do not spawn Codex, open stdio, probe auth, read
//! provider payloads, or ingest live events.

mod callback_request;
mod callback_response_admission;
mod callback_response_envelope;
mod callback_response_execution_policy;
mod callback_response_execution_receipt_linkage;
mod callback_response_executor_admission;
mod callback_response_outcome;
mod callback_response_reactor;
mod event_store_linkage;
mod handshake;
mod idempotency;
mod interruption_admission;
mod interruption_envelope;
mod interruption_execution_policy;
mod interruption_execution_receipt_linkage;
mod interruption_executor_admission;
mod interruption_outcome;
mod interruption_request;
mod live_executor_outcome;
mod live_executor_outcome_persistence;
mod live_ingestion;
mod live_send_preflight;
mod live_send_smoke_boundary;
mod live_spawn_smoke_evidence;
mod live_spawn_smoke_request;
mod live_spawn_smoke_runner;
mod readiness;
mod recovery_admission;
mod recovery_envelope;
mod recovery_execution_policy;
mod recovery_execution_receipt_linkage;
mod recovery_executor_admission;
mod recovery_need;
mod recovery_outcome;
mod runtime_instance;
mod session_binding;
mod spawn_intent;
mod stdio_frame_ingestion_persistence;
mod stdio_frames;
mod task_backed_live_execution_policy;
mod task_work_live_executor_admission;
mod task_work_live_executor_receipt_linkage;
#[cfg(test)]
pub(crate) mod test_support;
mod transport_executor_authority;
mod transport_receipts;
mod turn_start_admission;
mod turn_start_envelope;
mod turn_start_executor_smoke_boundary;
mod turn_start_live_send_receipts;
mod turn_start_outcome;
mod turn_start_reactor;
mod turn_start_request;
mod turn_start_send_command;
mod turn_start_send_receipts;
mod turn_start_stdio_execution_envelope;
mod turn_start_subscription;
mod turn_start_transport_execution_persistence;

pub use callback_request::{
    codex_callback_request, CodexAppServerCallbackPromptRef,
    CodexAppServerCallbackPromptRetentionPolicy, CodexAppServerCallbackRequest,
    CodexAppServerCallbackRequestId, CodexAppServerCallbackRequestKind,
    CodexAppServerCallbackRequestRejection, CodexAppServerProviderCallbackId,
};
pub use callback_response_admission::{
    admit_codex_callback_response, CodexAppServerCallbackResponse,
    CodexAppServerCallbackResponseAdmission, CodexAppServerCallbackResponseAdmissionBlocker,
    CodexAppServerCallbackResponseAdmissionId, CodexAppServerCallbackResponseAdmissionInput,
    CodexAppServerCallbackResponseAdmissionStatus,
};
pub use callback_response_envelope::{
    codex_callback_response_envelope, CodexAppServerCallbackResponseEnvelopeId,
    CodexAppServerCallbackResponseEnvelopeRecord, CodexAppServerCallbackResponseEnvelopeRejection,
};
pub use callback_response_execution_policy::{
    codex_callback_response_execution_policy, CodexAppServerCallbackResponseExecutionPolicyBlocker,
    CodexAppServerCallbackResponseExecutionPolicyId,
    CodexAppServerCallbackResponseExecutionPolicyInput,
    CodexAppServerCallbackResponseExecutionPolicyRecord,
    CodexAppServerCallbackResponseExecutionPolicyStatus,
    CodexAppServerCallbackResponseExecutionToolPolicy,
    CodexAppServerCallbackResponseExecutionToolProjectionMode,
};
pub use callback_response_execution_receipt_linkage::{
    codex_callback_response_execution_receipt_link,
    CodexAppServerCallbackResponseExecutionReceiptLink,
    CodexAppServerCallbackResponseExecutionReceiptLinkBlocker,
    CodexAppServerCallbackResponseExecutionReceiptLinkId,
    CodexAppServerCallbackResponseExecutionReceiptLinkStatus,
    CodexAppServerCallbackResponseExecutionRuntimeProgress,
};
pub use callback_response_executor_admission::{
    admit_codex_callback_response_executor, CodexAppServerCallbackResponseExecutorAdmissionBlocker,
    CodexAppServerCallbackResponseExecutorAdmissionId,
    CodexAppServerCallbackResponseExecutorAdmissionInput,
    CodexAppServerCallbackResponseExecutorAdmissionRecord,
    CodexAppServerCallbackResponseExecutorAdmissionStatus,
};
pub use callback_response_outcome::{
    codex_callback_response_failed_outcome, codex_callback_response_outcome_from_admission,
    codex_callback_response_outcome_from_envelope, codex_receipt_from_callback_response_outcome,
    CodexAppServerCallbackResponseOutcomeId, CodexAppServerCallbackResponseOutcomeRecord,
    CodexAppServerCallbackResponseOutcomeStatus,
};
pub use callback_response_reactor::{
    codex_callback_response_reactor_dry_run, CodexAppServerCallbackResponseReactorDryRunInput,
    CodexAppServerCallbackResponseReactorDryRunRecord,
};
pub use event_store_linkage::{
    link_codex_observation_to_event_store, CodexAppServerObservationEventLink,
    CodexAppServerObservationEventLinkStatus,
};
pub use handshake::{
    assess_codex_app_server_handshake, CodexAppServerHandshakeBlocker,
    CodexAppServerHandshakeExpectation, CodexAppServerHandshakeObservation,
    CodexAppServerHandshakePreflight, CodexAppServerHandshakePreflightStatus,
};
pub use idempotency::{
    accept_codex_ingestion_source, codex_frame_key_from_source,
    CodexAppServerFrameAcceptanceContext, CodexAppServerFrameAcceptanceRecord,
    CodexAppServerFrameAcceptanceStatus, CodexAppServerFrameKey, CodexAppServerObservationKind,
};
pub use interruption_admission::{
    admit_codex_interruption, CodexAppServerInterruptionAdmission,
    CodexAppServerInterruptionAdmissionBlocker, CodexAppServerInterruptionAdmissionId,
    CodexAppServerInterruptionAdmissionInput, CodexAppServerInterruptionAdmissionStatus,
    CodexAppServerInterruptionTargetState,
};
pub use interruption_envelope::{
    codex_interruption_envelope, CodexAppServerInterruptionEnvelopeId,
    CodexAppServerInterruptionEnvelopeRecord, CodexAppServerInterruptionEnvelopeRejection,
};
pub use interruption_execution_policy::{
    codex_interruption_execution_policy, CodexAppServerInterruptionExecutionPolicyBlocker,
    CodexAppServerInterruptionExecutionPolicyId, CodexAppServerInterruptionExecutionPolicyInput,
    CodexAppServerInterruptionExecutionPolicyRecord,
    CodexAppServerInterruptionExecutionPolicyStatus, CodexAppServerInterruptionExecutionToolPolicy,
    CodexAppServerInterruptionExecutionToolProjectionMode,
};
pub use interruption_execution_receipt_linkage::{
    codex_interruption_execution_receipt_link, CodexAppServerInterruptionExecutionReceiptLink,
    CodexAppServerInterruptionExecutionReceiptLinkBlocker,
    CodexAppServerInterruptionExecutionReceiptLinkId,
    CodexAppServerInterruptionExecutionReceiptLinkStatus,
    CodexAppServerInterruptionExecutionRuntimeProgress,
};
pub use interruption_executor_admission::{
    admit_codex_interruption_executor, CodexAppServerInterruptionExecutorAdmissionBlocker,
    CodexAppServerInterruptionExecutorAdmissionId,
    CodexAppServerInterruptionExecutorAdmissionInput,
    CodexAppServerInterruptionExecutorAdmissionRecord,
    CodexAppServerInterruptionExecutorAdmissionStatus,
};
pub use interruption_outcome::{
    codex_interruption_failed_outcome, codex_interruption_outcome_from_admission,
    codex_interruption_outcome_from_envelope, codex_receipt_from_interruption_outcome,
    CodexAppServerInterruptionOutcomeId, CodexAppServerInterruptionOutcomeRecord,
    CodexAppServerInterruptionOutcomeStatus,
};
pub use interruption_request::{
    codex_interruption_request, CodexAppServerInterruptionReasonRef,
    CodexAppServerInterruptionReasonRetentionPolicy, CodexAppServerInterruptionRequest,
    CodexAppServerInterruptionRequestId, CodexAppServerInterruptionRequestRef,
    CodexAppServerInterruptionRequestRejection, CodexAppServerInterruptionTarget,
};
pub use live_executor_outcome::{
    codex_live_executor_outcome_record, validate_codex_live_executor_outcome_record,
    CodexAppServerLiveExecutorCleanupStatus, CodexAppServerLiveExecutorMethod,
    CodexAppServerLiveExecutorOutcomeId, CodexAppServerLiveExecutorOutcomeInput,
    CodexAppServerLiveExecutorOutcomeRecord, CodexAppServerLiveExecutorOutcomeStatus,
    CodexAppServerLiveExecutorOutcomeValidationError, CodexAppServerLiveExecutorTransportKind,
};
pub use live_executor_outcome_persistence::{
    persist_codex_live_executor_outcome, read_codex_live_executor_outcome_records,
    CodexAppServerLiveExecutorOutcomePersistenceInput,
    CodexAppServerLiveExecutorOutcomePersistenceRecord,
    CodexAppServerLiveExecutorOutcomeReplayPolicy,
};
pub use live_ingestion::{
    ingest_codex_app_server_live_frame, CodexAppServerLiveFrame, CodexAppServerLiveIngestion,
    CodexAppServerLiveIngestionStatus, CodexAppServerLiveProjection,
    CodexAppServerUnsupportedObservation, CodexRawPayloadPolicy,
};
pub use live_send_preflight::{
    codex_live_send_preflight, CodexAppServerLiveSendEvidenceState,
    CodexAppServerLiveSendOperatorPolicy, CodexAppServerLiveSendPreflightBlocker,
    CodexAppServerLiveSendPreflightId, CodexAppServerLiveSendPreflightInput,
    CodexAppServerLiveSendPreflightRecord, CodexAppServerLiveSendPreflightStatus,
};
pub use live_send_smoke_boundary::{
    codex_live_send_smoke_boundary, CodexAppServerLiveSendSmokeBoundaryBlocker,
    CodexAppServerLiveSendSmokeBoundaryId, CodexAppServerLiveSendSmokeBoundaryInput,
    CodexAppServerLiveSendSmokeBoundaryRecord, CodexAppServerLiveSendSmokeBoundaryStatus,
    CodexAppServerLiveSendSmokeOperatorPolicy,
};
pub use live_spawn_smoke_evidence::{
    codex_live_spawn_smoke_evidence, codex_receipt_from_live_spawn_smoke_evidence,
    CodexAppServerLiveSpawnSmokeEvidenceRecord, CodexAppServerLiveSpawnSmokeEvidenceRecordId,
};
pub use live_spawn_smoke_request::{
    codex_live_spawn_smoke_request, CodexAppServerLiveSpawnSmokeCleanupPolicy,
    CodexAppServerLiveSpawnSmokeLimits, CodexAppServerLiveSpawnSmokeRequest,
    CodexAppServerLiveSpawnSmokeRequestId, CodexAppServerLiveSpawnSmokeRequestRejection,
};
pub use live_spawn_smoke_runner::{
    run_codex_live_spawn_smoke, CodexAppServerLiveSpawnSmokeOutcome,
    CodexAppServerLiveSpawnSmokeRunnerInput, CodexAppServerLiveSpawnSmokeRunnerResult,
};
pub use readiness::{
    assess_codex_app_server_supervision, CodexAppServerBinary, CodexAppServerSchemaEvidenceRef,
    CodexAppServerSupervisionBlocker, CodexAppServerSupervisionLimits,
    CodexAppServerSupervisionReadiness, CodexAppServerSupervisionReadinessInput,
    CodexAppServerSupervisionReadinessStatus, CodexAppServerSupervisionRequest,
};
pub use recovery_admission::{
    admit_codex_recovery, CodexAppServerRecoveryAdmission, CodexAppServerRecoveryAdmissionBlocker,
    CodexAppServerRecoveryAdmissionId, CodexAppServerRecoveryAdmissionInput,
    CodexAppServerRecoveryAdmissionStatus, CodexAppServerRecoveryCapability,
};
pub use recovery_envelope::{
    codex_recovery_envelope, CodexAppServerRecoveryEnvelopeId,
    CodexAppServerRecoveryEnvelopeRecord, CodexAppServerRecoveryEnvelopeRejection,
};
pub use recovery_execution_policy::{
    codex_recovery_execution_policy, CodexAppServerRecoveryExecutionPolicyBlocker,
    CodexAppServerRecoveryExecutionPolicyId, CodexAppServerRecoveryExecutionPolicyInput,
    CodexAppServerRecoveryExecutionPolicyRecord, CodexAppServerRecoveryExecutionPolicyStatus,
    CodexAppServerRecoveryExecutionToolPolicy, CodexAppServerRecoveryExecutionToolProjectionMode,
};
pub use recovery_execution_receipt_linkage::{
    codex_recovery_execution_receipt_link, CodexAppServerRecoveryExecutionReceiptLink,
    CodexAppServerRecoveryExecutionReceiptLinkBlocker,
    CodexAppServerRecoveryExecutionReceiptLinkId, CodexAppServerRecoveryExecutionReceiptLinkStatus,
    CodexAppServerRecoveryExecutionRuntimeProgress,
};
pub use recovery_executor_admission::{
    admit_codex_recovery_executor, CodexAppServerRecoveryExecutorAdmissionBlocker,
    CodexAppServerRecoveryExecutorAdmissionId, CodexAppServerRecoveryExecutorAdmissionInput,
    CodexAppServerRecoveryExecutorAdmissionRecord, CodexAppServerRecoveryExecutorAdmissionStatus,
};
pub use recovery_need::{
    codex_recovery_need_record, CodexAppServerRecoveryNeedId, CodexAppServerRecoveryNeedRecord,
    CodexAppServerRecoveryNeedRejection, CodexAppServerRecoverySummaryRef,
    CodexAppServerRecoveryTrigger,
};
pub use recovery_outcome::{
    codex_receipt_from_recovery_outcome, codex_recovery_failed_outcome,
    codex_recovery_outcome_from_admission, codex_recovery_outcome_from_envelope,
    codex_recovery_replacement_thread_outcome, CodexAppServerRecoveryOutcomeId,
    CodexAppServerRecoveryOutcomeRecord, CodexAppServerRecoveryOutcomeStatus,
};
pub use runtime_instance::{
    codex_runtime_instance_from_supervision_request, CodexAppServerPayloadRetentionPolicy,
    CodexAppServerRuntimeInstanceId, CodexAppServerRuntimeInstanceRecord,
    CodexAppServerRuntimeInstanceState,
};
pub use session_binding::{
    codex_ingestion_source_from_live_frame, codex_replacement_thread_recovery_binding,
    codex_session_binding_from_live_frame, CodexAppServerBindingConfidence,
    CodexAppServerBindingStatus, CodexAppServerIngestionIdentityQuality,
    CodexAppServerIngestionSourceId, CodexAppServerIngestionSourceRecord,
    CodexAppServerSessionBindingId, CodexAppServerSessionBindingRecord,
};
pub use spawn_intent::{
    admit_codex_spawn_intent, CodexAppServerSpawnIntentAdmission,
    CodexAppServerSpawnIntentAdmissionStatus, CodexAppServerSpawnIntentId,
};
pub use stdio_frame_ingestion_persistence::{
    persist_codex_stdio_frame_ingestion, read_codex_stdio_frame_ingestion_records,
    CodexAppServerStdioFrameIngestionPersistenceInput,
    CodexAppServerStdioFrameIngestionPersistenceRecord,
};
pub use stdio_frames::{
    codex_stdio_frame_source_record, CodexAppServerStdioDecodeStatus,
    CodexAppServerStdioFrameDirection, CodexAppServerStdioFrameSourceId,
    CodexAppServerStdioFrameSourceRecord,
};
pub use task_backed_live_execution_policy::{
    codex_task_backed_live_execution_policy, CodexAppServerTaskBackedLiveExecutionPathwayEvidence,
    CodexAppServerTaskBackedLiveExecutionPolicyBlocker,
    CodexAppServerTaskBackedLiveExecutionPolicyId,
    CodexAppServerTaskBackedLiveExecutionPolicyInput,
    CodexAppServerTaskBackedLiveExecutionPolicyRecord,
    CodexAppServerTaskBackedLiveExecutionPolicyStatus,
    CodexAppServerTaskBackedLiveExecutionToolPolicy,
    CodexAppServerTaskBackedLiveExecutionToolProjectionMode,
};
pub use task_work_live_executor_admission::{
    admit_codex_task_work_live_executor, CodexAppServerTaskWorkLiveExecutorAdmissionBlocker,
    CodexAppServerTaskWorkLiveExecutorAdmissionId,
    CodexAppServerTaskWorkLiveExecutorAdmissionInput,
    CodexAppServerTaskWorkLiveExecutorAdmissionRecord,
    CodexAppServerTaskWorkLiveExecutorAdmissionStatus,
};
pub use task_work_live_executor_receipt_linkage::{
    codex_task_work_live_executor_receipt_link, CodexAppServerTaskWorkLiveExecutorReceiptLink,
    CodexAppServerTaskWorkLiveExecutorReceiptLinkBlocker,
    CodexAppServerTaskWorkLiveExecutorReceiptLinkId,
    CodexAppServerTaskWorkLiveExecutorReceiptLinkStatus,
    CodexAppServerTaskWorkLiveExecutorRuntimeProgress,
};
pub use transport_executor_authority::{
    codex_transport_executor_authority, CodexAppServerTransportExecutorAuthorityBlocker,
    CodexAppServerTransportExecutorAuthorityId, CodexAppServerTransportExecutorAuthorityInput,
    CodexAppServerTransportExecutorAuthorityRecord, CodexAppServerTransportExecutorAuthorityStatus,
    CodexAppServerTransportExecutorConfirmationScope, CodexAppServerTransportExecutorEvidenceState,
    CodexAppServerTransportExecutorOperatorConfirmation,
    CodexAppServerTransportExecutorProviderAuthority,
};
pub use transport_receipts::{
    codex_receipt_from_spawn_intent, codex_receipt_from_stdio_frame,
    CodexAppServerTransportReceiptKind,
};
pub use turn_start_admission::{
    admit_codex_turn_start, CodexAppServerTurnStartAdmission,
    CodexAppServerTurnStartAdmissionBlocker, CodexAppServerTurnStartAdmissionId,
    CodexAppServerTurnStartAdmissionInput, CodexAppServerTurnStartAdmissionStatus,
    CodexAppServerTurnStartDeferredPolicy,
};
pub use turn_start_envelope::{
    codex_turn_start_envelope, CodexAppServerTurnStartEnvelopeId,
    CodexAppServerTurnStartEnvelopeRecord, CodexAppServerTurnStartEnvelopeRejection,
};
pub use turn_start_executor_smoke_boundary::{
    codex_turn_start_executor_smoke_boundary, CodexAppServerTurnStartExecutorSmokeBoundaryBlocker,
    CodexAppServerTurnStartExecutorSmokeBoundaryId,
    CodexAppServerTurnStartExecutorSmokeBoundaryInput,
    CodexAppServerTurnStartExecutorSmokeBoundaryRecord,
    CodexAppServerTurnStartExecutorSmokeBoundaryStatus, CodexAppServerTurnStartExecutorSmokeIntent,
};
pub use turn_start_live_send_receipts::{
    codex_turn_start_live_send_receipt_link, CodexAppServerTurnStartLiveSendReceiptBlocker,
    CodexAppServerTurnStartLiveSendReceiptIdentity, CodexAppServerTurnStartLiveSendReceiptLink,
    CodexAppServerTurnStartLiveSendReceiptStatus,
};
pub use turn_start_outcome::{
    codex_receipt_from_turn_start_outcome, codex_turn_start_outcome_from_admission,
    codex_turn_start_outcome_from_envelope, CodexAppServerTurnStartOutcomeId,
    CodexAppServerTurnStartOutcomeRecord, CodexAppServerTurnStartOutcomeStatus,
};
pub use turn_start_reactor::{
    codex_turn_start_reactor_dry_run, CodexAppServerTurnStartReactorDryRunInput,
    CodexAppServerTurnStartReactorDryRunRecord,
};
pub use turn_start_request::{
    codex_turn_start_request, CodexAppServerTurnStartPromptRef,
    CodexAppServerTurnStartPromptRetentionPolicy, CodexAppServerTurnStartRequest,
    CodexAppServerTurnStartRequestId, CodexAppServerTurnStartRequestRejection,
};
pub use turn_start_send_command::{
    codex_turn_start_send_command, CodexAppServerTurnStartSendCommandId,
    CodexAppServerTurnStartSendCommandRecord, CodexAppServerTurnStartSendCommandRejection,
    CodexAppServerTurnStartWriteTarget,
};
pub use turn_start_send_receipts::{
    codex_receipt_from_stdio_write_state, codex_receipt_from_subscription_state,
};
pub use turn_start_stdio_execution_envelope::{
    codex_turn_start_stdio_execution_envelope,
    CodexAppServerTurnStartStdioExecutionEnvelopeBlocker,
    CodexAppServerTurnStartStdioExecutionEnvelopeId,
    CodexAppServerTurnStartStdioExecutionEnvelopeInput,
    CodexAppServerTurnStartStdioExecutionEnvelopeRecord,
    CodexAppServerTurnStartStdioExecutionEnvelopeStatus, CodexAppServerTurnStartStdioPayloadRef,
};
pub use turn_start_subscription::{
    codex_stdio_write_state_from_send_command, codex_subscription_state_from_send_command,
    CodexAppServerStdioWriteState, CodexAppServerStdioWriteStateId,
    CodexAppServerStdioWriteStateRecord, CodexAppServerSubscriptionState,
    CodexAppServerSubscriptionStateId, CodexAppServerSubscriptionStateRecord,
};
pub use turn_start_transport_execution_persistence::{
    persist_codex_turn_start_transport_execution,
    CodexAppServerTurnStartTransportExecutionPersistenceInput,
    CodexAppServerTurnStartTransportExecutionPersistenceRecord,
    CodexAppServerTurnStartTransportExecutionReplayPolicy,
    CodexAppServerTurnStartTransportExecutionResult,
};

#[cfg(test)]
mod tests;
