//! Native steward command records.
//!
//! These records describe requested and completed steward commands. They do
//! not execute tools, mutate project state, commit, push, publish, or call a
//! forge.

use crate::personas::NativePersonaId;
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
}
