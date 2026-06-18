//! Engine-owned management projection sync runtime records.
//!
//! These records plan and route management projection sync work. They do not
//! import task state, overwrite meaning, create SCM captures, publish changes,
//! or call provider adapters.

use crate::{
    EngineRuntimeReceiptRecordId, ManagementProjectionConflictClass,
    ManagementProjectionConflictReport, ManagementProjectionFileRef,
    ManagementProjectionScmConflictKind, ManagementProjectionValidationReport,
    ManagementProjectionValidationStatus,
};

/// Stable id for one management sync plan.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ManagementProjectionSyncPlanId(pub String);

/// Planned management projection sync work.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagementProjectionSyncPlan {
    pub plan_id: ManagementProjectionSyncPlanId,
    pub kind: ManagementProjectionSyncPlanKind,
    pub status: ManagementProjectionSyncPlanStatus,
    pub file_refs: Vec<ManagementProjectionFileRef>,
    pub receipt_ids: Vec<EngineRuntimeReceiptRecordId>,
    pub validation_report_refs: Vec<String>,
    pub conflict_report_refs: Vec<String>,
    pub summary: Option<String>,
}

impl ManagementProjectionSyncPlan {
    pub fn export(
        plan_id: ManagementProjectionSyncPlanId,
        file_refs: Vec<ManagementProjectionFileRef>,
    ) -> Self {
        Self::new(plan_id, ManagementProjectionSyncPlanKind::Export, file_refs)
    }

    pub fn import(
        plan_id: ManagementProjectionSyncPlanId,
        file_refs: Vec<ManagementProjectionFileRef>,
    ) -> Self {
        Self::new(plan_id, ManagementProjectionSyncPlanKind::Import, file_refs)
    }

    pub fn repair(
        plan_id: ManagementProjectionSyncPlanId,
        proposal_refs: Vec<String>,
        file_refs: Vec<ManagementProjectionFileRef>,
    ) -> Self {
        let mut plan = Self::new(plan_id, ManagementProjectionSyncPlanKind::Repair, file_refs);
        plan.validation_report_refs = proposal_refs;
        plan
    }

    pub fn capture_preparation(
        plan_id: ManagementProjectionSyncPlanId,
        file_refs: Vec<ManagementProjectionFileRef>,
        receipt_ids: Vec<EngineRuntimeReceiptRecordId>,
    ) -> Self {
        let mut plan = Self::new(
            plan_id,
            ManagementProjectionSyncPlanKind::CapturePreparation,
            file_refs,
        );
        plan.receipt_ids = receipt_ids;
        plan
    }

    pub fn implies_provider_mutation(&self) -> bool {
        false
    }

    pub fn cites_projection_files(&self) -> bool {
        !self.file_refs.is_empty()
    }

    fn new(
        plan_id: ManagementProjectionSyncPlanId,
        kind: ManagementProjectionSyncPlanKind,
        file_refs: Vec<ManagementProjectionFileRef>,
    ) -> Self {
        Self {
            plan_id,
            kind,
            status: ManagementProjectionSyncPlanStatus::Draft,
            file_refs,
            receipt_ids: Vec::new(),
            validation_report_refs: Vec::new(),
            conflict_report_refs: Vec::new(),
            summary: None,
        }
    }
}

/// Sync plan kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ManagementProjectionSyncPlanKind {
    Export,
    Import,
    Validate,
    Repair,
    CapturePreparation,
}

/// Sync plan lifecycle.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ManagementProjectionSyncPlanStatus {
    Draft,
    Ready,
    Blocked(String),
    Completed,
    Superseded(String),
}

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

/// Stable id for management capture preparation.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ManagementProjectionCapturePrepId(pub String);

/// Provider-neutral management capture preparation record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagementProjectionCapturePrepRecord {
    pub prep_id: ManagementProjectionCapturePrepId,
    pub plan_id: ManagementProjectionSyncPlanId,
    pub status: ManagementProjectionCapturePrepStatus,
    pub scope: ManagementProjectionCaptureScope,
    pub file_refs: Vec<ManagementProjectionFileRef>,
    pub receipt_ids: Vec<EngineRuntimeReceiptRecordId>,
    pub assistance_refs: Vec<String>,
    pub summary: Option<String>,
}

impl ManagementProjectionCapturePrepRecord {
    pub fn from_sync_plan(
        prep_id: ManagementProjectionCapturePrepId,
        plan: &ManagementProjectionSyncPlan,
        assistance_refs: Vec<String>,
    ) -> Self {
        Self {
            prep_id,
            plan_id: plan.plan_id.clone(),
            status: ManagementProjectionCapturePrepStatus::Draft,
            scope: ManagementProjectionCaptureScope::ManagementProjection,
            file_refs: plan.file_refs.clone(),
            receipt_ids: plan.receipt_ids.clone(),
            assistance_refs,
            summary: plan.summary.clone(),
        }
    }

    pub fn is_execution(&self) -> bool {
        false
    }

    pub fn cites_projection_files_and_receipts(&self) -> bool {
        !self.file_refs.is_empty() && !self.receipt_ids.is_empty()
    }
}

/// Capture preparation status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ManagementProjectionCapturePrepStatus {
    Draft,
    ReadyForApproval,
    Blocked(String),
    Superseded(String),
}

/// Capture preparation scope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ManagementProjectionCaptureScope {
    ManagementProjection,
    TaskRecords,
    ProjectMetadata,
    DocsIndexes,
    Custom(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        validate_projection_envelope, ManagementProjectionExcludedStateMarker,
        ManagementProjectionRecordId, ManagementProjectionSchemaConflictKind,
        ManagementProjectionSchemaVersion, ManagementProjectionSemanticConflictKind,
        ManagementProjectionUnsupportedConflictKind,
    };
    use crate::{ManagementProjectionEnvelope, ManagementProjectionRecordKind};

    #[test]
    fn management_projection_sync_plans_separate_export_import_and_capture_prep() {
        let export = ManagementProjectionSyncPlan::export(
            ManagementProjectionSyncPlanId("sync-plan:export".to_owned()),
            vec![ManagementProjectionFileRef::project()],
        );
        let import = ManagementProjectionSyncPlan::import(
            ManagementProjectionSyncPlanId("sync-plan:import".to_owned()),
            vec![ManagementProjectionFileRef::task("task:1")],
        );
        let capture = ManagementProjectionSyncPlan::capture_preparation(
            ManagementProjectionSyncPlanId("sync-plan:capture".to_owned()),
            vec![ManagementProjectionFileRef::task("task:1")],
            vec![EngineRuntimeReceiptRecordId(
                "receipt:projection:1".to_owned(),
            )],
        );

        assert_eq!(export.kind, ManagementProjectionSyncPlanKind::Export);
        assert_eq!(import.kind, ManagementProjectionSyncPlanKind::Import);
        assert_eq!(
            capture.kind,
            ManagementProjectionSyncPlanKind::CapturePreparation
        );
        assert!(export.cites_projection_files());
        assert!(!export.implies_provider_mutation());
        assert!(!import.implies_provider_mutation());
        assert!(!capture.implies_provider_mutation());
    }

    #[test]
    fn management_projection_import_repair_preserves_invalid_and_unsupported_records() {
        let invalid = ManagementProjectionEnvelope {
            schema_version: ManagementProjectionSchemaVersion::current(),
            record_id: ManagementProjectionRecordId(String::new()),
            record_kind: ManagementProjectionRecordKind::Task,
            file_ref: ManagementProjectionFileRef("outside/task.toml".to_owned()),
        };
        let unsupported = ManagementProjectionEnvelope {
            schema_version: ManagementProjectionSchemaVersion("future".to_owned()),
            record_id: ManagementProjectionRecordId("task:future".to_owned()),
            record_kind: ManagementProjectionRecordKind::Task,
            file_ref: ManagementProjectionFileRef::task("task:future"),
        };

        let invalid_report = validate_projection_envelope(
            &invalid,
            &[ManagementProjectionExcludedStateMarker::PerProjectPanelLayout],
        );
        let unsupported_report = validate_projection_envelope(&unsupported, &[]);
        let invalid_proposal = ManagementProjectionImportRepairProposal::from_validation_report(
            ManagementProjectionImportRepairProposalId("repair:invalid".to_owned()),
            &invalid_report,
        )
        .expect("invalid proposal");
        let unsupported_proposal =
            ManagementProjectionImportRepairProposal::from_validation_report(
                ManagementProjectionImportRepairProposalId("repair:unsupported".to_owned()),
                &unsupported_report,
            )
            .expect("unsupported proposal");

        assert_eq!(
            invalid_proposal.kind,
            ManagementProjectionImportRepairKind::SchemaRepair
        );
        assert_eq!(
            unsupported_proposal.kind,
            ManagementProjectionImportRepairKind::UnsupportedPreservation
        );
        assert!(unsupported_proposal.preserves_unsupported_record());
        assert!(!invalid_proposal.can_silently_overwrite_task_meaning());
        assert!(!unsupported_proposal.can_silently_overwrite_task_meaning());
        assert!(invalid_proposal.issue_summaries.iter().any(|summary| {
            summary.contains("management projection files must live under nucleus/")
        }));
    }

    #[test]
    fn management_projection_conflict_routes_keep_mechanical_and_semantic_separate() {
        let schema = conflict_report(ManagementProjectionConflictClass::Schema(
            ManagementProjectionSchemaConflictKind::InvalidRecordShape,
        ));
        let semantic = conflict_report(ManagementProjectionConflictClass::Semantic(
            ManagementProjectionSemanticConflictKind::AcceptanceCriteriaRewrite,
        ));
        let unsupported = conflict_report(ManagementProjectionConflictClass::Unsupported(
            ManagementProjectionUnsupportedConflictKind::UnsupportedSchemaPreserved,
        ));
        let scm = conflict_report(ManagementProjectionConflictClass::Scm(
            ManagementProjectionScmConflictKind::FileChangedDuringImport,
        ));

        let schema_route = ManagementProjectionSyncAssistanceRoute::from_conflict_report(&schema);
        let semantic_route =
            ManagementProjectionSyncAssistanceRoute::from_conflict_report(&semantic);
        let unsupported_route =
            ManagementProjectionSyncAssistanceRoute::from_conflict_report(&unsupported);
        let scm_route = ManagementProjectionSyncAssistanceRoute::from_conflict_report(&scm);

        assert_eq!(
            schema_route.kind,
            ManagementProjectionSyncAssistanceKind::MechanicalConflictRepair
        );
        assert_eq!(
            semantic_route.kind,
            ManagementProjectionSyncAssistanceKind::SemanticConflictEscalation
        );
        assert_eq!(
            unsupported_route.kind,
            ManagementProjectionSyncAssistanceKind::UnsupportedRecordPreservation
        );
        assert_eq!(
            scm_route.kind,
            ManagementProjectionSyncAssistanceKind::ScmRetryOrRestage
        );
        assert!(!schema_route.hides_semantic_conflict());
        assert!(semantic_route.requires_human_approval());
        assert!(unsupported_route.requires_human_approval());
    }

    #[test]
    fn management_projection_capture_prep_is_not_provider_execution() {
        let mut plan = ManagementProjectionSyncPlan::capture_preparation(
            ManagementProjectionSyncPlanId("sync-plan:capture".to_owned()),
            vec![
                ManagementProjectionFileRef::project(),
                ManagementProjectionFileRef::task("task:1"),
            ],
            vec![EngineRuntimeReceiptRecordId(
                "receipt:projection:1".to_owned(),
            )],
        );
        plan.status = ManagementProjectionSyncPlanStatus::Ready;
        plan.summary = Some("prepare projection files for later SCM capture".to_owned());

        let prep = ManagementProjectionCapturePrepRecord::from_sync_plan(
            ManagementProjectionCapturePrepId("capture-prep:1".to_owned()),
            &plan,
            vec!["sync-assist:1".to_owned()],
        );

        assert!(!prep.is_execution());
        assert_eq!(prep.status, ManagementProjectionCapturePrepStatus::Draft);
        assert!(prep.cites_projection_files_and_receipts());
        assert_eq!(prep.plan_id, plan.plan_id);
        assert_eq!(prep.assistance_refs, vec!["sync-assist:1".to_owned()]);
    }

    fn conflict_report(
        class: ManagementProjectionConflictClass,
    ) -> ManagementProjectionConflictReport {
        ManagementProjectionConflictReport {
            conflict_id: "conflict:projection:1".to_owned(),
            file_ref: ManagementProjectionFileRef::task("task:1"),
            local_record_ref: Some(ManagementProjectionRecordId("task:1".to_owned())),
            incoming_record_ref: Some(ManagementProjectionRecordId("task:1".to_owned())),
            class,
            summary: "projection conflict evidence".to_owned(),
        }
    }

    #[test]
    fn management_projection_import_repair_ignores_valid_reports() {
        let envelope = ManagementProjectionEnvelope {
            schema_version: ManagementProjectionSchemaVersion::current(),
            record_id: ManagementProjectionRecordId("task:valid".to_owned()),
            record_kind: ManagementProjectionRecordKind::Task,
            file_ref: ManagementProjectionFileRef::task("task:valid"),
        };
        let report = validate_projection_envelope(&envelope, &[]);

        assert_eq!(report.status, ManagementProjectionValidationStatus::Valid);
        assert!(
            ManagementProjectionImportRepairProposal::from_validation_report(
                ManagementProjectionImportRepairProposalId("repair:none".to_owned()),
                &report,
            )
            .is_none()
        );
    }

    #[test]
    fn management_projection_sync_records_do_not_encode_provider_mutation_terms() {
        let plan = ManagementProjectionSyncPlan::capture_preparation(
            ManagementProjectionSyncPlanId("sync-plan:capture".to_owned()),
            vec![ManagementProjectionFileRef::task("task:1")],
            vec![EngineRuntimeReceiptRecordId(
                "receipt:projection:1".to_owned(),
            )],
        );
        let prep = ManagementProjectionCapturePrepRecord::from_sync_plan(
            ManagementProjectionCapturePrepId("capture-prep:1".to_owned()),
            &plan,
            vec!["sync-assist:1".to_owned()],
        );
        let debug = format!("{plan:?}{prep:?}");

        for forbidden in [
            "commit",
            "push",
            "publication_requested",
            "published",
            "provider credential",
            "raw_stdout",
            "raw_stderr",
        ] {
            assert!(
                !debug.to_lowercase().contains(forbidden),
                "sync records leaked {forbidden}"
            );
        }
    }
}
