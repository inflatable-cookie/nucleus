use serde::{Deserialize, Serialize};

use nucleus_engine::{
    ManagementProjectionCapturePrepRecord, ManagementProjectionImportRepairProposal,
    ManagementProjectionSyncAssistanceRoute, ManagementProjectionSyncPlan,
};

use super::helpers::{source_status, source_summary};

/// Management sync diagnostics read model.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SyncDiagnosticsDto {
    pub plans: Vec<SyncPlanDiagnosticDto>,
    pub repairs: Vec<SyncRepairDiagnosticDto>,
    pub assistance_routes: Vec<SyncAssistanceDiagnosticDto>,
    pub capture_preps: Vec<SyncCapturePrepDiagnosticDto>,
    pub client_can_mutate_provider: bool,
    pub source_status: String,
    pub source_summary: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SyncPlanDiagnosticDto {
    pub plan_id: String,
    pub kind: String,
    pub status: String,
    pub file_refs: Vec<String>,
    pub receipt_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SyncRepairDiagnosticDto {
    pub proposal_id: String,
    pub kind: String,
    pub review: String,
    pub file_ref: String,
    pub preserves_incoming_record: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SyncAssistanceDiagnosticDto {
    pub conflict_id: String,
    pub kind: String,
    pub review: String,
    pub requires_human_approval: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SyncCapturePrepDiagnosticDto {
    pub prep_id: String,
    pub plan_id: String,
    pub status: String,
    pub file_refs: Vec<String>,
    pub receipt_ids: Vec<String>,
    pub execution_available: bool,
}

pub fn sync_diagnostics(
    plans: &[ManagementProjectionSyncPlan],
    repairs: &[ManagementProjectionImportRepairProposal],
    routes: &[ManagementProjectionSyncAssistanceRoute],
    capture_preps: &[ManagementProjectionCapturePrepRecord],
) -> SyncDiagnosticsDto {
    let record_count = plans.len() + repairs.len() + routes.len() + capture_preps.len();
    SyncDiagnosticsDto {
        plans: plans.iter().map(SyncPlanDiagnosticDto::from).collect(),
        repairs: repairs.iter().map(SyncRepairDiagnosticDto::from).collect(),
        assistance_routes: routes
            .iter()
            .map(SyncAssistanceDiagnosticDto::from)
            .collect(),
        capture_preps: capture_preps
            .iter()
            .map(SyncCapturePrepDiagnosticDto::from)
            .collect(),
        client_can_mutate_provider: false,
        source_status: source_status(record_count),
        source_summary: Some(source_summary(
            record_count,
            "management sync source records are not persisted yet",
            "management sync diagnostics loaded from source records",
        )),
    }
}

impl From<&ManagementProjectionSyncPlan> for SyncPlanDiagnosticDto {
    fn from(plan: &ManagementProjectionSyncPlan) -> Self {
        Self {
            plan_id: plan.plan_id.0.clone(),
            kind: format!("{:?}", plan.kind),
            status: format!("{:?}", plan.status),
            file_refs: plan.file_refs.iter().map(|file| file.0.clone()).collect(),
            receipt_ids: plan
                .receipt_ids
                .iter()
                .map(|receipt| receipt.0.clone())
                .collect(),
        }
    }
}

impl From<&ManagementProjectionImportRepairProposal> for SyncRepairDiagnosticDto {
    fn from(repair: &ManagementProjectionImportRepairProposal) -> Self {
        Self {
            proposal_id: repair.proposal_id.0.clone(),
            kind: format!("{:?}", repair.kind),
            review: format!("{:?}", repair.review),
            file_ref: repair.file_ref.0.clone(),
            preserves_incoming_record: repair.preserves_incoming_record,
        }
    }
}

impl From<&ManagementProjectionSyncAssistanceRoute> for SyncAssistanceDiagnosticDto {
    fn from(route: &ManagementProjectionSyncAssistanceRoute) -> Self {
        Self {
            conflict_id: route.conflict_id.clone(),
            kind: format!("{:?}", route.kind),
            review: format!("{:?}", route.review),
            requires_human_approval: route.requires_human_approval(),
        }
    }
}

impl From<&ManagementProjectionCapturePrepRecord> for SyncCapturePrepDiagnosticDto {
    fn from(prep: &ManagementProjectionCapturePrepRecord) -> Self {
        Self {
            prep_id: prep.prep_id.0.clone(),
            plan_id: prep.plan_id.0.clone(),
            status: format!("{:?}", prep.status),
            file_refs: prep.file_refs.iter().map(|file| file.0.clone()).collect(),
            receipt_ids: prep
                .receipt_ids
                .iter()
                .map(|receipt| receipt.0.clone())
                .collect(),
            execution_available: prep.is_execution(),
        }
    }
}
