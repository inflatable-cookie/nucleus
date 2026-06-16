//! Native harness audit records.

use crate::sessions::NativeSessionId;

/// Stable native audit event id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct NativeAuditEventId(pub String);

/// Native harness audit event.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeAuditEvent {
    pub id: NativeAuditEventId,
    pub session_id: NativeSessionId,
    pub kind: NativeAuditEventKind,
    pub summary: Option<String>,
    pub evidence_refs: Vec<String>,
}

/// Native audit event kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeAuditEventKind {
    ProposedChange,
    ApprovalRequested,
    ApprovalGranted,
    ApprovalDenied,
    ToolActionCompleted,
    ModelCallCompleted,
    HumanDecisionRequired,
    PolicyBlocked,
    ManagementCommitPrepared,
    ManagementCommitCreated,
    ManagementPushRequested,
    ManagementPushCompleted,
    ConflictClassified,
    SemanticConflictEscalated,
    TaskDeletionRequested,
    TaskHistoryRewriteRequested,
}
