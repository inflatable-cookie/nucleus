//! Native steward command records.
//!
//! These records describe requested and completed steward commands. They do
//! not execute tools, mutate project state, commit, push, publish, or call a
//! forge.

use crate::personas::{
    NativeActionApproval, NativePersonaId, NativePersonaPolicy, NativePrivilegedAction,
};
use crate::steward::{
    NativeStewardEvidenceRef, NativeStewardProposalId, NativeStewardSyncAssistanceId,
};
use crate::tools::{NativeRuntimeReceiptRef, NativeToolActionId};

/// Stable native steward command id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct NativeStewardCommandId(pub String);

/// Steward command requested through Nucleus-owned authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeStewardCommandRequest {
    pub id: NativeStewardCommandId,
    pub persona_id: NativePersonaId,
    pub kind: NativeStewardCommandKind,
    pub scope: NativeStewardCommandScope,
    pub target: NativeStewardCommandTarget,
    pub tool_action_id: Option<NativeToolActionId>,
    pub evidence_refs: Vec<NativeStewardEvidenceRef>,
    pub summary: Option<String>,
}

impl NativeStewardCommandRequest {
    pub fn is_record_only(&self) -> bool {
        true
    }

    pub fn is_read_only(&self) -> bool {
        self.scope == NativeStewardCommandScope::ReadOnly
    }

    pub fn requires_approval(&self) -> bool {
        matches!(
            self.scope,
            NativeStewardCommandScope::ApprovalRequired | NativeStewardCommandScope::Unsupported
        )
    }

    pub fn can_imply_provider_authority(&self) -> bool {
        false
    }

    pub fn uses_reference_only_evidence(&self) -> bool {
        self.summary
            .as_ref()
            .map(|summary| !contains_forbidden_steward_command_term(summary))
            .unwrap_or(true)
            && self
                .evidence_refs
                .iter()
                .all(NativeStewardEvidenceRef::uses_reference_only_evidence)
    }

    pub fn admit_with_policy(&self, policy: &NativePersonaPolicy) -> NativeStewardCommandAdmission {
        let approval = policy.approval_for_action(self.privileged_action());
        let status = match (&self.scope, approval.clone()) {
            (NativeStewardCommandScope::Unsupported, _) => {
                NativeStewardCommandAdmissionStatus::Rejected(
                    "unsupported command scope".to_owned(),
                )
            }
            (_, NativeActionApproval::BlockedByPolicy) => {
                NativeStewardCommandAdmissionStatus::Rejected(
                    "blocked by persona policy".to_owned(),
                )
            }
            (NativeStewardCommandScope::ApprovalRequired, NativeActionApproval::Required) => {
                NativeStewardCommandAdmissionStatus::RequiresApproval
            }
            (_, NativeActionApproval::Required) => {
                NativeStewardCommandAdmissionStatus::RequiresApproval
            }
            (NativeStewardCommandScope::Unknown, _) => {
                NativeStewardCommandAdmissionStatus::Blocked("unknown command authority".to_owned())
            }
            _ => NativeStewardCommandAdmissionStatus::Accepted,
        };

        NativeStewardCommandAdmission {
            command_id: self.id.clone(),
            status,
            approval,
            reason: None,
        }
    }

    fn privileged_action(&self) -> NativePrivilegedAction {
        match self.scope {
            NativeStewardCommandScope::ReadOnly => NativePrivilegedAction::ReadOnlyInspection,
            NativeStewardCommandScope::ProposalOnly => {
                NativePrivilegedAction::ProposeManagementStateEdit
            }
            NativeStewardCommandScope::ApprovalRequired => match self.kind {
                NativeStewardCommandKind::ManagementCapturePreparation => {
                    NativePrivilegedAction::PrepareManagementCapture
                }
                _ => NativePrivilegedAction::ProposeManagementStateEdit,
            },
            NativeStewardCommandScope::Unsupported | NativeStewardCommandScope::Unknown => {
                NativePrivilegedAction::ChangeSyncPolicy
            }
        }
    }
}

/// Admission result for a steward command request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeStewardCommandAdmission {
    pub command_id: NativeStewardCommandId,
    pub status: NativeStewardCommandAdmissionStatus,
    pub approval: NativeActionApproval,
    pub reason: Option<String>,
}

impl NativeStewardCommandAdmission {
    pub fn can_run_without_approval(&self) -> bool {
        self.status == NativeStewardCommandAdmissionStatus::Accepted
            && matches!(
                self.approval,
                NativeActionApproval::NotRequired | NativeActionApproval::AllowedByPolicy
            )
    }

    pub fn is_rejected_or_blocked(&self) -> bool {
        matches!(
            self.status,
            NativeStewardCommandAdmissionStatus::Rejected(_)
                | NativeStewardCommandAdmissionStatus::Blocked(_)
                | NativeStewardCommandAdmissionStatus::Unsupported
        )
    }
}

/// Admission status for a steward command request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeStewardCommandAdmissionStatus {
    Accepted,
    RequiresApproval,
    Rejected(String),
    Blocked(String),
    Unsupported,
}

/// Steward command result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeStewardCommandOutcome {
    pub command_id: NativeStewardCommandId,
    pub status: NativeStewardCommandStatus,
    pub proposal_refs: Vec<NativeStewardProposalId>,
    pub sync_assistance_refs: Vec<NativeStewardSyncAssistanceId>,
    pub tool_action_id: Option<NativeToolActionId>,
    pub receipt_refs: Vec<NativeRuntimeReceiptRef>,
    pub evidence_refs: Vec<NativeStewardEvidenceRef>,
    pub summary: Option<String>,
}

impl NativeStewardCommandOutcome {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self.status,
            NativeStewardCommandStatus::Rejected(_)
                | NativeStewardCommandStatus::Blocked(_)
                | NativeStewardCommandStatus::Completed
                | NativeStewardCommandStatus::CompletedWithWarnings
        )
    }

    pub fn is_distinct_from_mutation(&self) -> bool {
        true
    }

    pub fn can_imply_provider_authority(&self) -> bool {
        false
    }

    pub fn uses_reference_only_evidence(&self) -> bool {
        self.summary
            .as_ref()
            .map(|summary| !contains_forbidden_steward_command_term(summary))
            .unwrap_or(true)
            && self
                .receipt_refs
                .iter()
                .all(|receipt_ref| !contains_forbidden_steward_command_term(&receipt_ref.0))
            && self
                .evidence_refs
                .iter()
                .all(NativeStewardEvidenceRef::uses_reference_only_evidence)
    }

    pub fn with_receipt_link(mut self, link: &NativeStewardCommandReceiptLink) -> Self {
        for receipt_ref in &link.receipt_refs {
            if !self.receipt_refs.contains(receipt_ref) {
                self.receipt_refs.push(receipt_ref.clone());
            }
        }
        for evidence_ref in &link.evidence_refs {
            if !self.evidence_refs.contains(evidence_ref) {
                self.evidence_refs.push(evidence_ref.clone());
            }
        }
        if self.tool_action_id.is_none() {
            self.tool_action_id = link.tool_action_id.clone();
        }
        self
    }
}

/// Receipt and evidence linkage for a steward command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeStewardCommandReceiptLink {
    pub command_id: NativeStewardCommandId,
    pub tool_action_id: Option<NativeToolActionId>,
    pub receipt_refs: Vec<NativeRuntimeReceiptRef>,
    pub evidence_refs: Vec<NativeStewardEvidenceRef>,
    pub summary: Option<String>,
}

impl NativeStewardCommandReceiptLink {
    pub fn uses_reference_only_evidence(&self) -> bool {
        self.summary
            .as_ref()
            .map(|summary| !contains_forbidden_steward_command_term(summary))
            .unwrap_or(true)
            && self
                .receipt_refs
                .iter()
                .all(|receipt_ref| !contains_forbidden_steward_command_term(&receipt_ref.0))
            && self
                .evidence_refs
                .iter()
                .all(NativeStewardEvidenceRef::uses_reference_only_evidence)
    }

    pub fn links_command(&self, command_id: &NativeStewardCommandId) -> bool {
        &self.command_id == command_id
    }
}

/// Command class.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeStewardCommandKind {
    ReadOnlyInspection,
    ProposalDrafting,
    ManagementCapturePreparation,
    SyncAssistance,
    EffigyInspection,
    Custom(String),
}

/// Authority scope requested by a command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeStewardCommandScope {
    ReadOnly,
    ProposalOnly,
    ApprovalRequired,
    Unsupported,
    Unknown,
}

/// Command target.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeStewardCommandTarget {
    Project { project_ref: String },
    Task { task_ref: String },
    TaskSet { task_refs: Vec<String> },
    EffigyIntegration { integration_ref: String },
    ManagementProjection { projection_ref: String },
    ProjectionConflict { conflict_report_ref: String },
    ScmWorkSession { work_session_ref: String },
    ChangeRequestPrep { prep_ref: String },
    Custom(String),
}

/// Command lifecycle outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeStewardCommandStatus {
    Accepted,
    Rejected(String),
    Blocked(String),
    Completed,
    CompletedWithWarnings,
    Unknown,
}

fn contains_forbidden_steward_command_term(value: &str) -> bool {
    [
        "raw_stdout",
        "raw_stderr",
        "terminal stream",
        "provider payload",
        "model raw output",
        "secret",
        "credential",
        "token",
        "push",
        "publish",
        "forge credential",
    ]
    .iter()
    .any(|term| value.to_lowercase().contains(term))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::steward::{NativeStewardEvidenceRef, NativeStewardEvidenceSource};
    use crate::NativeSyncAuthority;

    fn command(kind: NativeStewardCommandKind) -> NativeStewardCommandRequest {
        NativeStewardCommandRequest {
            id: NativeStewardCommandId("steward-command:1".to_owned()),
            persona_id: NativePersonaId("persona:steward".to_owned()),
            kind,
            scope: NativeStewardCommandScope::ReadOnly,
            target: NativeStewardCommandTarget::Project {
                project_ref: "project:nucleus".to_owned(),
            },
            tool_action_id: Some(NativeToolActionId("tool:steward-command:1".to_owned())),
            evidence_refs: vec![NativeStewardEvidenceRef {
                source: NativeStewardEvidenceSource::Task,
                ref_id: "task:index".to_owned(),
            }],
            summary: Some("sanitized steward command request".to_owned()),
        }
    }

    #[test]
    fn steward_command_requests_cover_first_command_kinds() {
        let kinds = vec![
            NativeStewardCommandKind::ReadOnlyInspection,
            NativeStewardCommandKind::ProposalDrafting,
            NativeStewardCommandKind::ManagementCapturePreparation,
            NativeStewardCommandKind::SyncAssistance,
            NativeStewardCommandKind::EffigyInspection,
        ];

        for kind in kinds {
            let command = command(kind);
            assert!(command.is_record_only());
            assert!(command.is_read_only());
            assert!(!command.can_imply_provider_authority());
            assert!(command.uses_reference_only_evidence());
        }
    }

    #[test]
    fn steward_command_outcomes_are_distinct_from_mutations() {
        let outcome = NativeStewardCommandOutcome {
            command_id: NativeStewardCommandId("steward-command:1".to_owned()),
            status: NativeStewardCommandStatus::Completed,
            proposal_refs: vec![NativeStewardProposalId("proposal:1".to_owned())],
            sync_assistance_refs: vec![NativeStewardSyncAssistanceId("sync-assist:1".to_owned())],
            tool_action_id: Some(NativeToolActionId("tool:steward-command:1".to_owned())),
            receipt_refs: vec![NativeRuntimeReceiptRef(
                "receipt:steward-command:1".to_owned(),
            )],
            evidence_refs: vec![NativeStewardEvidenceRef {
                source: NativeStewardEvidenceSource::RuntimeReceipt,
                ref_id: "receipt:steward-command:1".to_owned(),
            }],
            summary: Some("completed command with proposal refs".to_owned()),
        };

        assert!(outcome.is_terminal());
        assert!(outcome.is_distinct_from_mutation());
        assert!(!outcome.can_imply_provider_authority());
        assert!(outcome.uses_reference_only_evidence());
    }

    #[test]
    fn steward_command_statuses_cover_admission_and_terminal_paths() {
        let statuses = vec![
            NativeStewardCommandStatus::Accepted,
            NativeStewardCommandStatus::Rejected("unsupported".to_owned()),
            NativeStewardCommandStatus::Blocked("policy".to_owned()),
            NativeStewardCommandStatus::Completed,
            NativeStewardCommandStatus::CompletedWithWarnings,
            NativeStewardCommandStatus::Unknown,
        ];

        assert_eq!(statuses.len(), 6);
        assert!(statuses.contains(&NativeStewardCommandStatus::Accepted));
        assert!(statuses.contains(&NativeStewardCommandStatus::Completed));
        assert!(statuses.contains(&NativeStewardCommandStatus::Unknown));
    }

    #[test]
    fn steward_command_records_reject_provider_authority_terms() {
        let mut command = command(NativeStewardCommandKind::SyncAssistance);
        command.summary = Some("prepare push to remote".to_owned());

        assert!(!command.uses_reference_only_evidence());
        assert!(!command.can_imply_provider_authority());
    }

    #[test]
    fn steward_command_receipt_link_attaches_receipts_without_payloads() {
        let outcome = NativeStewardCommandOutcome {
            command_id: NativeStewardCommandId("steward-command:1".to_owned()),
            status: NativeStewardCommandStatus::Completed,
            proposal_refs: Vec::new(),
            sync_assistance_refs: Vec::new(),
            tool_action_id: None,
            receipt_refs: Vec::new(),
            evidence_refs: Vec::new(),
            summary: Some("completed command".to_owned()),
        };
        let link = NativeStewardCommandReceiptLink {
            command_id: NativeStewardCommandId("steward-command:1".to_owned()),
            tool_action_id: Some(NativeToolActionId("tool:steward-command:1".to_owned())),
            receipt_refs: vec![NativeRuntimeReceiptRef("receipt:command:1".to_owned())],
            evidence_refs: vec![NativeStewardEvidenceRef {
                source: NativeStewardEvidenceSource::RuntimeReceipt,
                ref_id: "receipt:command:1".to_owned(),
            }],
            summary: Some("sanitized receipt link".to_owned()),
        };

        let linked = outcome.with_receipt_link(&link);

        assert!(link.links_command(&NativeStewardCommandId("steward-command:1".to_owned())));
        assert_eq!(linked.receipt_refs.len(), 1);
        assert_eq!(linked.evidence_refs.len(), 1);
        assert!(linked.uses_reference_only_evidence());
        assert!(link.uses_reference_only_evidence());
    }

    #[test]
    fn steward_command_receipt_link_rejects_raw_payload_terms() {
        let link = NativeStewardCommandReceiptLink {
            command_id: NativeStewardCommandId("steward-command:1".to_owned()),
            tool_action_id: None,
            receipt_refs: vec![NativeRuntimeReceiptRef("raw_stdout:command".to_owned())],
            evidence_refs: Vec::new(),
            summary: None,
        };

        assert!(!link.uses_reference_only_evidence());
    }

    #[test]
    fn steward_command_admission_accepts_read_only_without_approval() {
        let policy =
            NativePersonaPolicy::project_steward(NativeSyncAuthority::ProposeOnly, true, false);
        let command = command(NativeStewardCommandKind::ReadOnlyInspection);

        let admission = command.admit_with_policy(&policy);

        assert_eq!(
            admission.status,
            NativeStewardCommandAdmissionStatus::Accepted
        );
        assert!(admission.can_run_without_approval());
    }

    #[test]
    fn steward_command_admission_requires_approval_for_capture_prep() {
        let policy = NativePersonaPolicy::project_steward(
            NativeSyncAuthority::PrepareManagementCapture,
            true,
            false,
        );
        let mut command = command(NativeStewardCommandKind::ManagementCapturePreparation);
        command.scope = NativeStewardCommandScope::ApprovalRequired;

        let admission = command.admit_with_policy(&policy);

        assert_eq!(
            admission.status,
            NativeStewardCommandAdmissionStatus::RequiresApproval
        );
        assert_eq!(admission.approval, NativeActionApproval::Required);
    }

    #[test]
    fn steward_command_admission_rejects_unsupported_escalation() {
        let policy = NativePersonaPolicy::project_steward(NativeSyncAuthority::None, true, false);
        let mut command = command(NativeStewardCommandKind::SyncAssistance);
        command.scope = NativeStewardCommandScope::Unsupported;

        let admission = command.admit_with_policy(&policy);

        assert!(admission.is_rejected_or_blocked());
        assert!(matches!(
            admission.status,
            NativeStewardCommandAdmissionStatus::Rejected(_)
        ));
    }

    #[test]
    fn steward_command_admission_blocks_proposal_when_policy_has_no_sync_authority() {
        let policy = NativePersonaPolicy::project_steward(NativeSyncAuthority::None, true, false);
        let mut command = command(NativeStewardCommandKind::ProposalDrafting);
        command.scope = NativeStewardCommandScope::ProposalOnly;

        let admission = command.admit_with_policy(&policy);

        assert!(admission.is_rejected_or_blocked());
        assert_eq!(admission.approval, NativeActionApproval::BlockedByPolicy);
    }
}
