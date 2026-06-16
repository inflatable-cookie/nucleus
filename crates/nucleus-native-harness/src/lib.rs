//! Nucleus-owned native harness boundary types.
//!
//! This crate names app-owned persona, session, event, tool, approval, model
//! backend, and audit surfaces. It does not implement agent execution, model
//! inference, Git sync, or steward behavior yet.

pub mod audit;
pub mod backends;
pub mod events;
pub mod personas;
pub mod sessions;
pub mod tools;

pub use audit::{NativeAuditEvent, NativeAuditEventId, NativeAuditEventKind};
pub use backends::{NativeModelBackend, NativeModelBackendId, NativeModelBackendKind};
pub use events::{NativeEventId, NativeEventKind, NativeHarnessEvent};
pub use personas::{
    NativePersona, NativePersonaCapability, NativePersonaId, NativePersonaPolicy,
    NativePersonaRole, NativeSyncAuthority,
};
pub use sessions::{NativeHarnessSession, NativeSessionId, NativeSessionState};
pub use tools::{
    NativeApprovalPolicy, NativeApprovalRequest, NativeApprovalRequestId, NativeToolAction,
    NativeToolActionId, NativeToolCapability, NativeToolPolicy,
};
