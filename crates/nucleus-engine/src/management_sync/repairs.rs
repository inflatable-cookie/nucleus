use crate::{
    ManagementProjectionFileRef, ManagementProjectionValidationReport,
    ManagementProjectionValidationStatus,
};

/// Stable id for a repair proposal generated from projection import evidence.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ManagementProjectionImportRepairProposalId(pub String);

/// Proposal generated from invalid, unsupported, or risky projection import
/// evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagementProjectionImportRepairProposal {
    pub proposal_id: ManagementProjectionImportRepairProposalId,
    pub file_ref: ManagementProjectionFileRef,
    pub record_ref: Option<String>,
    pub kind: ManagementProjectionImportRepairKind,
    pub review: ManagementProjectionImportRepairReview,
    pub issue_summaries: Vec<String>,
    pub preserves_incoming_record: bool,
}

impl ManagementProjectionImportRepairProposal {
    pub fn from_validation_report(
        proposal_id: ManagementProjectionImportRepairProposalId,
        report: &ManagementProjectionValidationReport,
    ) -> Option<Self> {
        let (kind, review, preserves_incoming_record) = match report.status {
            ManagementProjectionValidationStatus::Valid
            | ManagementProjectionValidationStatus::ValidWithWarnings => return None,
            ManagementProjectionValidationStatus::Invalid => (
                ManagementProjectionImportRepairKind::SchemaRepair,
                ManagementProjectionImportRepairReview::ProposalOnly,
                true,
            ),
            ManagementProjectionValidationStatus::UnsupportedSchema => (
                ManagementProjectionImportRepairKind::UnsupportedPreservation,
                ManagementProjectionImportRepairReview::NeedsHumanApproval,
                true,
            ),
        };

        Some(Self {
            proposal_id,
            file_ref: report.file_ref.clone(),
            record_ref: report
                .record_id
                .as_ref()
                .map(|record_id| record_id.0.clone()),
            kind,
            review,
            issue_summaries: report
                .issues
                .iter()
                .map(|issue| issue.summary.clone())
                .collect(),
            preserves_incoming_record,
        })
    }

    pub fn can_silently_overwrite_task_meaning(&self) -> bool {
        false
    }

    pub fn preserves_unsupported_record(&self) -> bool {
        self.kind == ManagementProjectionImportRepairKind::UnsupportedPreservation
            && self.preserves_incoming_record
    }
}

/// Import repair category.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ManagementProjectionImportRepairKind {
    SchemaRepair,
    SemanticReview,
    UnsupportedPreservation,
    ScmRetry,
    Custom(String),
}

/// Import repair review posture.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ManagementProjectionImportRepairReview {
    ProposalOnly,
    NeedsHumanApproval,
    Blocked(String),
    Rejected(String),
    AcceptedForLaterMutation,
}
