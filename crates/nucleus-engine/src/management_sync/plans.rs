use crate::{EngineRuntimeReceiptRecordId, ManagementProjectionFileRef};

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
