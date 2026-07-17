//! Native harness tool and approval records.

use crate::audit::NativeAuditEventId;
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
    pub state: NativeToolActionState,
    pub approval_request_ids: Vec<NativeApprovalRequestId>,
    pub receipt_refs: Vec<NativeRuntimeReceiptRef>,
    pub audit_event_ids: Vec<NativeAuditEventId>,
    pub evidence_refs: Vec<NativeToolEvidenceRef>,
    pub summary: Option<String>,
}

impl NativeToolAction {
    /// True when this action has durable refs but no raw output fields.
    pub fn uses_reference_only_evidence(&self) -> bool {
        self.summary
            .as_ref()
            .map(|summary| !contains_forbidden_raw_output_term(summary))
            .unwrap_or(true)
            && self
                .evidence_refs
                .iter()
                .all(|evidence_ref| !contains_forbidden_raw_output_term(&evidence_ref.0))
    }

    /// True when approval is pending before execution or capture/share.
    pub fn is_waiting_for_approval(&self) -> bool {
        self.state == NativeToolActionState::WaitingForApproval
            || matches!(
                self.policy.approval,
                NativeApprovalPolicy::RequiredBeforeRun
                    | NativeApprovalPolicy::RequiredBeforeCapture
                    | NativeApprovalPolicy::RequiredBeforeShare
                    | NativeApprovalPolicy::RequiredBeforeDelete
                    | NativeApprovalPolicy::RequiredBeforeHistoryRewrite
                    | NativeApprovalPolicy::RequiredBeforePolicyChange
            ) && !self.approval_request_ids.is_empty()
    }

    /// Attach receipt evidence without changing execution state.
    pub fn with_receipt_ref(mut self, receipt_ref: NativeRuntimeReceiptRef) -> Self {
        if !self.receipt_refs.contains(&receipt_ref) {
            self.receipt_refs.push(receipt_ref);
        }
        self
    }
}

/// Tool action lifecycle.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeToolActionState {
    Draft,
    WaitingForApproval,
    Accepted,
    Running,
    Completed,
    CompletedWithWarnings,
    Rejected(String),
    Blocked(String),
    Failed(String),
    Cancelled,
    Unknown,
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
    PrepareManagementCapture,
    CreateManagementCapture,
    ShareManagementCapture,
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
    RequiredBeforeCapture,
    RequiredBeforeShare,
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

/// Stable reference to an engine-owned runtime receipt.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct NativeRuntimeReceiptRef(pub String);

/// Sanitized evidence ref for a native tool action (shared core type).
pub use nucleus_core::EvidenceRef as NativeToolEvidenceRef;

fn contains_forbidden_raw_output_term(value: &str) -> bool {
    [
        "raw_stdout",
        "raw_stderr",
        "terminal stream",
        "provider payload",
        "model raw output",
        "credential",
    ]
    .iter()
    .any(|term| value.to_lowercase().contains(term))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn action(state: NativeToolActionState, approval: NativeApprovalPolicy) -> NativeToolAction {
        NativeToolAction {
            id: NativeToolActionId("tool:1".to_owned()),
            session_id: NativeSessionId("native-session:1".to_owned()),
            capability: NativeToolCapability::ValidateTaskSchema,
            policy: NativeToolPolicy {
                deterministic: true,
                modifies_projected_state: false,
                modifies_code: false,
                approval,
            },
            state,
            approval_request_ids: Vec::new(),
            receipt_refs: Vec::new(),
            audit_event_ids: Vec::new(),
            evidence_refs: Vec::new(),
            summary: Some("sanitized tool action summary".to_owned()),
        }
    }

    #[test]
    fn native_tool_action_can_reference_approval_receipts_and_audit() {
        let mut tool = action(
            NativeToolActionState::WaitingForApproval,
            NativeApprovalPolicy::RequiredBeforeRun,
        );
        tool.approval_request_ids
            .push(NativeApprovalRequestId("approval:1".to_owned()));
        tool.audit_event_ids
            .push(NativeAuditEventId("audit:approval-requested".to_owned()));
        tool.evidence_refs
            .push(NativeToolEvidenceRef("evidence:sanitized-plan".to_owned()));
        let tool = tool.with_receipt_ref(NativeRuntimeReceiptRef("receipt:tool:1".to_owned()));

        assert!(tool.is_waiting_for_approval());
        assert_eq!(
            tool.receipt_refs,
            vec![NativeRuntimeReceiptRef("receipt:tool:1".to_owned())]
        );
        assert_eq!(
            tool.audit_event_ids,
            vec![NativeAuditEventId("audit:approval-requested".to_owned())]
        );
        assert!(tool.uses_reference_only_evidence());
    }

    #[test]
    fn native_tool_action_states_represent_terminal_and_blocked_paths() {
        let rejected = action(
            NativeToolActionState::Rejected("operator denied".to_owned()),
            NativeApprovalPolicy::RequiredBeforeRun,
        );
        let blocked = action(
            NativeToolActionState::Blocked("policy denied".to_owned()),
            NativeApprovalPolicy::Unsupported,
        );
        let completed = action(
            NativeToolActionState::Completed,
            NativeApprovalPolicy::NotRequired,
        );

        assert!(matches!(rejected.state, NativeToolActionState::Rejected(_)));
        assert!(matches!(blocked.state, NativeToolActionState::Blocked(_)));
        assert_eq!(completed.state, NativeToolActionState::Completed);
    }

    #[test]
    fn native_tool_action_rejects_raw_output_terms_in_summaries() {
        let mut tool = action(
            NativeToolActionState::Completed,
            NativeApprovalPolicy::NotRequired,
        );
        tool.summary = Some("contains raw_stdout".to_owned());

        assert!(!tool.uses_reference_only_evidence());
    }
}
