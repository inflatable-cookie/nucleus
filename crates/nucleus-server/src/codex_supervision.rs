//! Compile-only Codex app-server supervision boundary.
//!
//! These records describe whether Nucleus may consider starting a Codex
//! app-server process. They do not spawn Codex, open stdio, probe auth, read
//! provider payloads, or ingest live events.

mod event_store_linkage;
mod handshake;
mod idempotency;
mod live_ingestion;
mod live_spawn_smoke_evidence;
mod live_spawn_smoke_request;
mod live_spawn_smoke_runner;
mod readiness;
mod runtime_instance;
mod session_binding;
mod spawn_intent;
mod stdio_frames;
mod turn_start_admission;
mod turn_start_envelope;
mod turn_start_outcome;
mod turn_start_send_command;
mod turn_start_request;
mod transport_receipts;

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
pub use live_ingestion::{
    ingest_codex_app_server_live_frame, CodexAppServerLiveFrame, CodexAppServerLiveIngestion,
    CodexAppServerLiveIngestionStatus, CodexAppServerLiveProjection,
    CodexAppServerUnsupportedObservation, CodexRawPayloadPolicy,
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
pub use stdio_frames::{
    codex_stdio_frame_source_record, CodexAppServerStdioDecodeStatus,
    CodexAppServerStdioFrameDirection, CodexAppServerStdioFrameSourceId,
    CodexAppServerStdioFrameSourceRecord,
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
pub use turn_start_outcome::{
    codex_receipt_from_turn_start_outcome, codex_turn_start_outcome_from_admission,
    codex_turn_start_outcome_from_envelope, CodexAppServerTurnStartOutcomeId,
    CodexAppServerTurnStartOutcomeRecord, CodexAppServerTurnStartOutcomeStatus,
};
pub use turn_start_send_command::{
    codex_turn_start_send_command, CodexAppServerTurnStartSendCommandId,
    CodexAppServerTurnStartSendCommandRecord, CodexAppServerTurnStartSendCommandRejection,
    CodexAppServerTurnStartWriteTarget,
};
pub use turn_start_request::{
    codex_turn_start_request, CodexAppServerTurnStartPromptRef,
    CodexAppServerTurnStartPromptRetentionPolicy, CodexAppServerTurnStartRequest,
    CodexAppServerTurnStartRequestId, CodexAppServerTurnStartRequestRejection,
};
pub use transport_receipts::{
    codex_receipt_from_spawn_intent, codex_receipt_from_stdio_frame,
    CodexAppServerTransportReceiptKind,
};

#[cfg(test)]
mod tests;
