use serde::{Deserialize, Serialize};

use nucleus_engine::{
    EngineRuntimeReceiptRecord, ManagementProjectionConflictClass,
    ManagementProjectionConflictReport, ManagementProjectionImportRepairProposal,
};

use crate::management_projection_state::{
    ManagementProjectionAppliedRecord, ManagementProjectionApplyBlock,
    ManagementProjectionImportApplyReport, ManagementProjectionImportStagingReport,
    ManagementProjectionStagedFile, ManagementProjectionStagingIssue,
};

use super::helpers::{source_status, source_summary};
use super::sync::SyncRepairDiagnosticDto;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SyncReviewModelDto {
    pub staged_records: Vec<SyncStagedRecordReviewDto>,
    pub invalid_records: Vec<SyncStagedRecordReviewDto>,
    pub unsupported_records: Vec<SyncStagedRecordReviewDto>,
    pub applied_records: Vec<SyncAppliedRecordReviewDto>,
    pub blocked_records: Vec<SyncApplyBlockReviewDto>,
    pub conflicts: Vec<SyncConflictReviewDto>,
    pub repairs: Vec<SyncRepairDiagnosticDto>,
    pub receipts: Vec<SyncReceiptReviewDto>,
    pub client_can_mutate: bool,
    pub client_can_mutate_provider: bool,
    pub source_status: String,
    pub source_summary: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SyncStagedRecordReviewDto {
    pub record_id: Option<String>,
    pub file_ref: String,
    pub validation_status: String,
    pub issue_summaries: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SyncAppliedRecordReviewDto {
    pub record_id: String,
    pub file_ref: String,
    pub revision_id: String,
    pub receipt_id: String,
    pub summary: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SyncApplyBlockReviewDto {
    pub record_id: Option<String>,
    pub file_ref: String,
    pub kind: String,
    pub summary: String,
    pub receipt_id: Option<String>,
    pub conflict_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SyncConflictReviewDto {
    pub conflict_id: String,
    pub file_ref: String,
    pub local_record_ref: Option<String>,
    pub incoming_record_ref: Option<String>,
    pub class: String,
    pub kind: String,
    pub summary: String,
    pub requires_human_review: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SyncReceiptReviewDto {
    pub receipt_id: String,
    pub family: String,
    pub status: String,
    pub evidence_refs: Vec<String>,
    pub artifact_refs: Vec<String>,
    pub summary: Option<String>,
}

pub fn management_sync_review_model(
    staging: Option<&ManagementProjectionImportStagingReport>,
    apply: Option<&ManagementProjectionImportApplyReport>,
    conflicts: &[ManagementProjectionConflictReport],
    repairs: &[ManagementProjectionImportRepairProposal],
    receipts: &[EngineRuntimeReceiptRecord],
) -> SyncReviewModelDto {
    let mut receipt_records = receipts
        .iter()
        .map(SyncReceiptReviewDto::from)
        .collect::<Vec<_>>();
    if let Some(apply) = apply {
        receipt_records.extend(apply.receipts.iter().map(SyncReceiptReviewDto::from));
    }

    let staged_records: Vec<SyncStagedRecordReviewDto> = staging
        .map(|report| {
            report
                .staged
                .iter()
                .map(SyncStagedRecordReviewDto::from)
                .collect()
        })
        .unwrap_or_default();
    let invalid_records: Vec<SyncStagedRecordReviewDto> = staging
        .map(|report| {
            report
                .invalid
                .iter()
                .map(|issue| issue_to_review_record(issue, "Invalid"))
                .collect()
        })
        .unwrap_or_default();
    let unsupported_records: Vec<SyncStagedRecordReviewDto> = staging
        .map(|report| {
            report
                .unsupported
                .iter()
                .map(|issue| issue_to_review_record(issue, "UnsupportedSchema"))
                .collect()
        })
        .unwrap_or_default();
    let applied_records: Vec<SyncAppliedRecordReviewDto> = apply
        .map(|report| {
            report
                .applied
                .iter()
                .map(SyncAppliedRecordReviewDto::from)
                .collect()
        })
        .unwrap_or_default();
    let blocked_records: Vec<SyncApplyBlockReviewDto> = apply
        .map(|report| {
            report
                .blocked
                .iter()
                .map(SyncApplyBlockReviewDto::from)
                .collect()
        })
        .unwrap_or_default();
    let conflicts = conflicts
        .iter()
        .map(SyncConflictReviewDto::from)
        .collect::<Vec<_>>();
    let repairs = repairs.iter().map(SyncRepairDiagnosticDto::from).collect();
    let record_count = staged_records.len()
        + invalid_records.len()
        + unsupported_records.len()
        + applied_records.len()
        + blocked_records.len()
        + conflicts.len()
        + receipt_records.len();

    SyncReviewModelDto {
        staged_records,
        invalid_records,
        unsupported_records,
        applied_records,
        blocked_records,
        conflicts,
        repairs,
        receipts: receipt_records,
        client_can_mutate: false,
        client_can_mutate_provider: false,
        source_status: source_status(record_count),
        source_summary: Some(source_summary(
            record_count,
            "management sync review state is empty",
            "management sync review state loaded from staged/apply records",
        )),
    }
}

impl From<&ManagementProjectionStagedFile> for SyncStagedRecordReviewDto {
    fn from(staged: &ManagementProjectionStagedFile) -> Self {
        Self {
            record_id: staged
                .validation
                .record_id
                .as_ref()
                .map(|record| record.0.clone()),
            file_ref: staged.file_ref.0.clone(),
            validation_status: format!("{:?}", staged.validation.status),
            issue_summaries: staged
                .validation
                .issues
                .iter()
                .map(|issue| issue.summary.clone())
                .collect(),
        }
    }
}

impl From<&ManagementProjectionAppliedRecord> for SyncAppliedRecordReviewDto {
    fn from(applied: &ManagementProjectionAppliedRecord) -> Self {
        Self {
            record_id: applied.record_id.0.clone(),
            file_ref: applied.file_ref.0.clone(),
            revision_id: applied.revision_id.0.clone(),
            receipt_id: applied.receipt_id.0.clone(),
            summary: applied.summary.clone(),
        }
    }
}

impl From<&ManagementProjectionApplyBlock> for SyncApplyBlockReviewDto {
    fn from(block: &ManagementProjectionApplyBlock) -> Self {
        Self {
            record_id: block.record_id.as_ref().map(|record| record.0.clone()),
            file_ref: block.file_ref.0.clone(),
            kind: format!("{:?}", block.kind),
            summary: block.summary.clone(),
            receipt_id: block.receipt_id.as_ref().map(|receipt| receipt.0.clone()),
            conflict_id: block
                .conflict
                .as_ref()
                .map(|conflict| conflict.conflict_id.clone()),
        }
    }
}

impl From<&ManagementProjectionConflictReport> for SyncConflictReviewDto {
    fn from(conflict: &ManagementProjectionConflictReport) -> Self {
        let (class, kind, requires_human_review) = conflict_class(&conflict.class);
        Self {
            conflict_id: conflict.conflict_id.clone(),
            file_ref: conflict.file_ref.0.clone(),
            local_record_ref: conflict
                .local_record_ref
                .as_ref()
                .map(|record| record.0.clone()),
            incoming_record_ref: conflict
                .incoming_record_ref
                .as_ref()
                .map(|record| record.0.clone()),
            class,
            kind,
            summary: conflict.summary.clone(),
            requires_human_review,
        }
    }
}

impl From<&EngineRuntimeReceiptRecord> for SyncReceiptReviewDto {
    fn from(receipt: &EngineRuntimeReceiptRecord) -> Self {
        Self {
            receipt_id: receipt.receipt_id.0.clone(),
            family: format!("{:?}", receipt.family),
            status: format!("{:?}", receipt.status),
            evidence_refs: receipt
                .evidence_refs
                .iter()
                .map(|reference| format!("{:?}", reference))
                .collect(),
            artifact_refs: receipt
                .artifact_refs
                .iter()
                .map(|reference| format!("{:?}", reference))
                .collect(),
            summary: receipt.summary.clone(),
        }
    }
}

fn issue_to_review_record(
    issue: &ManagementProjectionStagingIssue,
    validation_status: &str,
) -> SyncStagedRecordReviewDto {
    SyncStagedRecordReviewDto {
        record_id: None,
        file_ref: issue.file_ref.0.clone(),
        validation_status: validation_status.to_owned(),
        issue_summaries: vec![issue.summary.clone()],
    }
}

fn conflict_class(class: &ManagementProjectionConflictClass) -> (String, String, bool) {
    match class {
        ManagementProjectionConflictClass::Schema(kind) => {
            ("schema".to_owned(), format!("{kind:?}"), false)
        }
        ManagementProjectionConflictClass::Semantic(kind) => {
            ("semantic".to_owned(), format!("{kind:?}"), true)
        }
        ManagementProjectionConflictClass::Unsupported(kind) => {
            ("unsupported".to_owned(), format!("{kind:?}"), true)
        }
        ManagementProjectionConflictClass::Scm(kind) => {
            ("scm".to_owned(), format!("{kind:?}"), false)
        }
    }
}
