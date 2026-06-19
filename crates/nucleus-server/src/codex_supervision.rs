//! Compile-only Codex app-server supervision boundary.
//!
//! These records describe whether Nucleus may consider starting a Codex
//! app-server process. They do not spawn Codex, open stdio, probe auth, read
//! provider payloads, or ingest live events.

mod handshake;
mod live_ingestion;
mod readiness;
mod session_binding;

pub use handshake::{
    assess_codex_app_server_handshake, CodexAppServerHandshakeBlocker,
    CodexAppServerHandshakeExpectation, CodexAppServerHandshakeObservation,
    CodexAppServerHandshakePreflight, CodexAppServerHandshakePreflightStatus,
};
pub use live_ingestion::{
    ingest_codex_app_server_live_frame, CodexAppServerLiveFrame, CodexAppServerLiveIngestion,
    CodexAppServerLiveIngestionStatus, CodexAppServerLiveProjection,
    CodexAppServerUnsupportedObservation, CodexRawPayloadPolicy,
};
pub use readiness::{
    assess_codex_app_server_supervision, CodexAppServerBinary, CodexAppServerSchemaEvidenceRef,
    CodexAppServerSupervisionBlocker, CodexAppServerSupervisionLimits,
    CodexAppServerSupervisionReadiness, CodexAppServerSupervisionReadinessInput,
    CodexAppServerSupervisionReadinessStatus, CodexAppServerSupervisionRequest,
};
pub use session_binding::{
    codex_ingestion_source_from_live_frame, codex_replacement_thread_recovery_binding,
    codex_session_binding_from_live_frame, CodexAppServerBindingConfidence,
    CodexAppServerBindingStatus, CodexAppServerIngestionIdentityQuality,
    CodexAppServerIngestionSourceId, CodexAppServerIngestionSourceRecord,
    CodexAppServerSessionBindingId, CodexAppServerSessionBindingRecord,
};

#[cfg(test)]
mod tests;
