use crate::{EngineRuntimeReceiptRecordId, ManagementProjectionFileRef};

use super::plans::{ManagementProjectionSyncPlan, ManagementProjectionSyncPlanId};

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
