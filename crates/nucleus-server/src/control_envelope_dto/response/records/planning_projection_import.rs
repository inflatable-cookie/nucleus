use serde::{Deserialize, Serialize};

use crate::{PlanningProjectionImportDiagnosticBucket, PlanningProjectionImportDiagnostics};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlPlanningProjectionImportDiagnosticsDto {
    pub diagnostics_id: String,
    #[ts(as = "u32")]
    pub candidate_count: usize,
    #[ts(as = "u32")]
    pub ready_candidate_count: usize,
    #[ts(as = "u32")]
    pub blocked_candidate_count: usize,
    #[ts(as = "u32")]
    pub admission_count: usize,
    #[ts(as = "u32")]
    pub admitted_stopped_count: usize,
    #[ts(as = "u32")]
    pub duplicate_noop_count: usize,
    #[ts(as = "u32")]
    pub blocked_admission_count: usize,
    #[ts(as = "u32")]
    pub conflict_count: usize,
    #[ts(as = "u32")]
    pub blocker_count: usize,
    #[ts(as = "u32")]
    pub evidence_ref_count: usize,
    pub candidate_status_buckets: Vec<ControlPlanningProjectionImportBucketDto>,
    pub admission_status_buckets: Vec<ControlPlanningProjectionImportBucketDto>,
    pub conflict_kind_buckets: Vec<ControlPlanningProjectionImportBucketDto>,
    pub apply_blocked: bool,
    pub apply_permitted: bool,
    pub task_promotion_permitted: bool,
    pub provider_execution_permitted: bool,
    pub scm_mutation_permitted: bool,
    pub forge_mutation_permitted: bool,
    pub raw_payload_retained: bool,
    pub ui_apply_permitted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlPlanningProjectionImportBucketDto {
    pub label: String,
    #[ts(as = "u32")]
    pub count: usize,
}

impl From<&PlanningProjectionImportDiagnostics> for ControlPlanningProjectionImportDiagnosticsDto {
    fn from(diagnostics: &PlanningProjectionImportDiagnostics) -> Self {
        Self {
            diagnostics_id: diagnostics.diagnostics_id.clone(),
            candidate_count: diagnostics.candidate_count,
            ready_candidate_count: diagnostics.ready_candidate_count,
            blocked_candidate_count: diagnostics.blocked_candidate_count,
            admission_count: diagnostics.admission_count,
            admitted_stopped_count: diagnostics.admitted_stopped_count,
            duplicate_noop_count: diagnostics.duplicate_noop_count,
            blocked_admission_count: diagnostics.blocked_admission_count,
            conflict_count: diagnostics.conflict_count,
            blocker_count: diagnostics.blocker_count,
            evidence_ref_count: diagnostics.evidence_ref_count,
            candidate_status_buckets: diagnostics
                .candidate_status_buckets
                .iter()
                .map(ControlPlanningProjectionImportBucketDto::from)
                .collect(),
            admission_status_buckets: diagnostics
                .admission_status_buckets
                .iter()
                .map(ControlPlanningProjectionImportBucketDto::from)
                .collect(),
            conflict_kind_buckets: diagnostics
                .conflict_kind_buckets
                .iter()
                .map(ControlPlanningProjectionImportBucketDto::from)
                .collect(),
            apply_blocked: diagnostics.apply_blocked,
            apply_permitted: diagnostics.apply_permitted,
            task_promotion_permitted: diagnostics.task_promotion_permitted,
            provider_execution_permitted: diagnostics.provider_execution_permitted,
            scm_mutation_permitted: diagnostics.scm_mutation_permitted,
            forge_mutation_permitted: diagnostics.forge_mutation_permitted,
            raw_payload_retained: diagnostics.raw_payload_retained,
            ui_apply_permitted: diagnostics.ui_apply_permitted,
        }
    }
}

impl From<&PlanningProjectionImportDiagnosticBucket> for ControlPlanningProjectionImportBucketDto {
    fn from(bucket: &PlanningProjectionImportDiagnosticBucket) -> Self {
        Self {
            label: bucket.label.clone(),
            count: bucket.count,
        }
    }
}
