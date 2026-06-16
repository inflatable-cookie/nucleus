//! Native harness tool and approval records.

use crate::sessions::NativeSessionId;

/// Stable native tool action id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct NativeToolActionId(pub String);

/// Tool action requested by a native persona.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeToolAction {
    pub id: NativeToolActionId,
    pub session_id: NativeSessionId,
    pub capability: NativeToolCapability,
    pub policy: NativeToolPolicy,
    pub summary: Option<String>,
}

/// Native tool capability.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeToolCapability {
    ReadTaskRecords,
    ValidateTaskSchema,
    InspectGitStatus,
    InspectSyncQueue,
    DetectMechanicalConflicts,
    DetectSemanticConflicts,
    NormalizeTaskMetadata,
    PrepareManagementCommit,
    CommitManagementState,
    PushManagementState,
    ResolveMechanicalConflict,
    ProposeSemanticConflictResolution,
    DeleteTask,
    RewriteTaskHistory,
    UpdateDocsIndex,
    CreateArtifactReference,
    Custom(String),
}

/// Tool policy for a native tool action.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeToolPolicy {
    pub deterministic: bool,
    pub modifies_projected_state: bool,
    pub modifies_code: bool,
    pub approval: NativeApprovalPolicy,
}

/// Approval policy for native tool actions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeApprovalPolicy {
    NotRequired,
    RequiredBeforeRun,
    RequiredBeforeCommit,
    RequiredBeforePush,
    RequiredBeforeDelete,
    RequiredBeforeHistoryRewrite,
    RequiredBeforePolicyChange,
    Unsupported,
}

/// Stable native approval request id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct NativeApprovalRequestId(pub String);

/// Approval request created by a native persona.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeApprovalRequest {
    pub id: NativeApprovalRequestId,
    pub session_id: NativeSessionId,
    pub tool_action_id: Option<NativeToolActionId>,
    pub reason: String,
    pub policy: NativeApprovalPolicy,
}
