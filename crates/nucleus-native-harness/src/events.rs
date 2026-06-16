//! Native harness event records.

use nucleus_agent_protocol::RuntimeEventPayload;

use crate::audit::NativeAuditEventId;
use crate::sessions::NativeSessionId;
use crate::tools::{NativeApprovalRequestId, NativeToolActionId};

/// Stable native harness event id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct NativeEventId(pub String);

/// Event emitted by a Nucleus-owned native harness.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeHarnessEvent {
    pub id: NativeEventId,
    pub session_id: NativeSessionId,
    pub kind: NativeEventKind,
    pub payload: Option<RuntimeEventPayload>,
    pub app_owned: bool,
}

/// Native harness event kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeEventKind {
    SessionStateChanged,
    PersonaStarted,
    ToolActionStarted(NativeToolActionId),
    ToolActionCompleted(NativeToolActionId),
    ApprovalRequested(NativeApprovalRequestId),
    AuditRecorded(NativeAuditEventId),
    ModelCallStarted,
    ModelCallCompleted,
    Diagnostic,
}
