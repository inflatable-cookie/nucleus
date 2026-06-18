use crate::{
    ManagementProjectionConflictClass, ManagementProjectionConflictReport,
    ManagementProjectionFileRef, ManagementProjectionScmConflictKind,
};

use super::repairs::ManagementProjectionImportRepairReview;

/// Routed projection conflict assistance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagementProjectionSyncAssistanceRoute {
    pub conflict_id: String,
    pub file_ref: ManagementProjectionFileRef,
    pub kind: ManagementProjectionSyncAssistanceKind,
    pub review: ManagementProjectionImportRepairReview,
    pub summary: Option<String>,
}

impl ManagementProjectionSyncAssistanceRoute {
    pub fn from_conflict_report(report: &ManagementProjectionConflictReport) -> Self {
        let (kind, review) = match &report.class {
            ManagementProjectionConflictClass::Schema(_) => (
                ManagementProjectionSyncAssistanceKind::MechanicalConflictRepair,
                ManagementProjectionImportRepairReview::ProposalOnly,
            ),
            ManagementProjectionConflictClass::Semantic(_) => (
                ManagementProjectionSyncAssistanceKind::SemanticConflictEscalation,
                ManagementProjectionImportRepairReview::NeedsHumanApproval,
            ),
            ManagementProjectionConflictClass::Unsupported(_) => (
                ManagementProjectionSyncAssistanceKind::UnsupportedRecordPreservation,
                ManagementProjectionImportRepairReview::NeedsHumanApproval,
            ),
            ManagementProjectionConflictClass::Scm(kind) => (
                scm_assistance_kind(kind),
                ManagementProjectionImportRepairReview::ProposalOnly,
            ),
        };

        Self {
            conflict_id: report.conflict_id.clone(),
            file_ref: report.file_ref.clone(),
            kind,
            review,
            summary: Some(report.summary.clone()),
        }
    }

    pub fn hides_semantic_conflict(&self) -> bool {
        false
    }

    pub fn requires_human_approval(&self) -> bool {
        self.review == ManagementProjectionImportRepairReview::NeedsHumanApproval
    }
}

fn scm_assistance_kind(
    kind: &ManagementProjectionScmConflictKind,
) -> ManagementProjectionSyncAssistanceKind {
    match kind {
        ManagementProjectionScmConflictKind::WorkingCopyDirty
        | ManagementProjectionScmConflictKind::FileChangedDuringExport
        | ManagementProjectionScmConflictKind::FileChangedDuringImport
        | ManagementProjectionScmConflictKind::ProjectionPathConflict
        | ManagementProjectionScmConflictKind::SyncBaseUnknown
        | ManagementProjectionScmConflictKind::AdapterConflict(_) => {
            ManagementProjectionSyncAssistanceKind::ScmRetryOrRestage
        }
    }
}

/// Assistance route kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ManagementProjectionSyncAssistanceKind {
    MechanicalConflictRepair,
    SemanticConflictEscalation,
    UnsupportedRecordPreservation,
    ScmRetryOrRestage,
}
