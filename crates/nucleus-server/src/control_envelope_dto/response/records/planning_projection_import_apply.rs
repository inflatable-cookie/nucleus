use serde::{Deserialize, Serialize};

use crate::{
    PlanningProjectionImportApplyDiagnosticBucket, PlanningProjectionImportApplyDiagnostics,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlPlanningProjectionImportApplyDiagnosticsDto {
    pub diagnostics_id: String,
    pub stopped_apply_record_count: usize,
    pub persisted_apply_record_count: usize,
    pub duplicate_noop_record_count: usize,
    pub blocked_apply_record_count: usize,
    pub planned_operation_count: usize,
    pub skipped_operation_count: usize,
    pub blocked_operation_count: usize,
    pub ready_count: usize,
    pub blocked_count: usize,
    pub conflict_count: usize,
    pub stale_count: usize,
    pub duplicate_noop_count: usize,
    pub repair_required_count: usize,
    pub blocker_count: usize,
    pub evidence_ref_count: usize,
    pub record_status_buckets: Vec<ControlPlanningProjectionImportApplyBucketDto>,
    pub blocker_buckets: Vec<ControlPlanningProjectionImportApplyBucketDto>,
    pub active_planning_mutation_permitted: bool,
    pub task_creation_permitted: bool,
    pub task_promotion_permitted: bool,
    pub projection_write_permitted: bool,
    pub agent_scheduling_permitted: bool,
    pub provider_execution_permitted: bool,
    pub scm_mutation_permitted: bool,
    pub forge_mutation_permitted: bool,
    pub semantic_merge_permitted: bool,
    pub raw_payload_retained: bool,
    pub payload_body_included: bool,
    pub private_planning_body_exposed: bool,
    pub provider_payload_exposed: bool,
    pub source_body_exposed: bool,
    pub ui_apply_permitted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlPlanningProjectionImportApplyBucketDto {
    pub label: String,
    pub count: usize,
}

impl From<&PlanningProjectionImportApplyDiagnostics>
    for ControlPlanningProjectionImportApplyDiagnosticsDto
{
    fn from(diagnostics: &PlanningProjectionImportApplyDiagnostics) -> Self {
        Self {
            diagnostics_id: diagnostics.diagnostics_id.clone(),
            stopped_apply_record_count: diagnostics.stopped_apply_record_count,
            persisted_apply_record_count: diagnostics.persisted_apply_record_count,
            duplicate_noop_record_count: diagnostics.duplicate_noop_record_count,
            blocked_apply_record_count: diagnostics.blocked_apply_record_count,
            planned_operation_count: diagnostics.planned_operation_count,
            skipped_operation_count: diagnostics.skipped_operation_count,
            blocked_operation_count: diagnostics.blocked_operation_count,
            ready_count: diagnostics.ready_count,
            blocked_count: diagnostics.blocked_count,
            conflict_count: diagnostics.conflict_count,
            stale_count: diagnostics.stale_count,
            duplicate_noop_count: diagnostics.duplicate_noop_count,
            repair_required_count: diagnostics.repair_required_count,
            blocker_count: diagnostics.blocker_count,
            evidence_ref_count: diagnostics.evidence_ref_count,
            record_status_buckets: diagnostics
                .record_status_buckets
                .iter()
                .map(ControlPlanningProjectionImportApplyBucketDto::from)
                .collect(),
            blocker_buckets: diagnostics
                .blocker_buckets
                .iter()
                .map(ControlPlanningProjectionImportApplyBucketDto::from)
                .collect(),
            active_planning_mutation_permitted: diagnostics.active_planning_mutation_permitted,
            task_creation_permitted: diagnostics.task_creation_permitted,
            task_promotion_permitted: diagnostics.task_promotion_permitted,
            projection_write_permitted: diagnostics.projection_write_permitted,
            agent_scheduling_permitted: diagnostics.agent_scheduling_permitted,
            provider_execution_permitted: diagnostics.provider_execution_permitted,
            scm_mutation_permitted: diagnostics.scm_mutation_permitted,
            forge_mutation_permitted: diagnostics.forge_mutation_permitted,
            semantic_merge_permitted: diagnostics.semantic_merge_permitted,
            raw_payload_retained: diagnostics.raw_payload_retained,
            payload_body_included: diagnostics.payload_body_included,
            private_planning_body_exposed: diagnostics.private_planning_body_exposed,
            provider_payload_exposed: diagnostics.provider_payload_exposed,
            source_body_exposed: diagnostics.source_body_exposed,
            ui_apply_permitted: diagnostics.ui_apply_permitted,
        }
    }
}

impl From<&PlanningProjectionImportApplyDiagnosticBucket>
    for ControlPlanningProjectionImportApplyBucketDto
{
    fn from(bucket: &PlanningProjectionImportApplyDiagnosticBucket) -> Self {
        Self {
            label: bucket.label.clone(),
            count: bucket.count,
        }
    }
}
