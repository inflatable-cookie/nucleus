use serde::{Deserialize, Serialize};

use crate::{
    PlanningProjectionImportActiveApplyDiagnosticBucket,
    PlanningProjectionImportActiveApplyDiagnostics,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlPlanningProjectionImportActiveApplyDiagnosticsDto {
    pub diagnostics_id: String,
    pub admission_record_count: usize,
    pub admitted_record_count: usize,
    pub duplicate_noop_record_count: usize,
    pub blocked_record_count: usize,
    pub operation_ref_count: usize,
    pub evidence_ref_count: usize,
    pub blocker_count: usize,
    pub stale_count: usize,
    pub conflict_count: usize,
    pub unsupported_count: usize,
    pub repair_required_count: usize,
    pub missing_ref_count: usize,
    pub record_status_buckets: Vec<ControlPlanningProjectionImportActiveApplyBucketDto>,
    pub blocker_buckets: Vec<ControlPlanningProjectionImportActiveApplyBucketDto>,
    pub active_planning_mutation_permitted: bool,
    pub executor_invocation_permitted: bool,
    pub task_creation_permitted: bool,
    pub task_promotion_permitted: bool,
    pub projection_write_permitted: bool,
    pub agent_scheduling_permitted: bool,
    pub provider_execution_permitted: bool,
    pub scm_mutation_permitted: bool,
    pub forge_mutation_permitted: bool,
    pub semantic_merge_permitted: bool,
    pub accepted_memory_mutation_permitted: bool,
    pub callback_permitted: bool,
    pub interruption_permitted: bool,
    pub recovery_permitted: bool,
    pub raw_payload_retained: bool,
    pub payload_body_included: bool,
    pub private_planning_body_exposed: bool,
    pub provider_payload_exposed: bool,
    pub source_body_exposed: bool,
    pub ui_apply_permitted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlPlanningProjectionImportActiveApplyBucketDto {
    pub label: String,
    pub count: usize,
}

impl From<&PlanningProjectionImportActiveApplyDiagnostics>
    for ControlPlanningProjectionImportActiveApplyDiagnosticsDto
{
    fn from(diagnostics: &PlanningProjectionImportActiveApplyDiagnostics) -> Self {
        Self {
            diagnostics_id: diagnostics.diagnostics_id.clone(),
            admission_record_count: diagnostics.admission_record_count,
            admitted_record_count: diagnostics.admitted_record_count,
            duplicate_noop_record_count: diagnostics.duplicate_noop_record_count,
            blocked_record_count: diagnostics.blocked_record_count,
            operation_ref_count: diagnostics.operation_ref_count,
            evidence_ref_count: diagnostics.evidence_ref_count,
            blocker_count: diagnostics.blocker_count,
            stale_count: diagnostics.stale_count,
            conflict_count: diagnostics.conflict_count,
            unsupported_count: diagnostics.unsupported_count,
            repair_required_count: diagnostics.repair_required_count,
            missing_ref_count: diagnostics.missing_ref_count,
            record_status_buckets: diagnostics
                .record_status_buckets
                .iter()
                .map(ControlPlanningProjectionImportActiveApplyBucketDto::from)
                .collect(),
            blocker_buckets: diagnostics
                .blocker_buckets
                .iter()
                .map(ControlPlanningProjectionImportActiveApplyBucketDto::from)
                .collect(),
            active_planning_mutation_permitted: diagnostics.active_planning_mutation_permitted,
            executor_invocation_permitted: diagnostics.executor_invocation_permitted,
            task_creation_permitted: diagnostics.task_creation_permitted,
            task_promotion_permitted: diagnostics.task_promotion_permitted,
            projection_write_permitted: diagnostics.projection_write_permitted,
            agent_scheduling_permitted: diagnostics.agent_scheduling_permitted,
            provider_execution_permitted: diagnostics.provider_execution_permitted,
            scm_mutation_permitted: diagnostics.scm_mutation_permitted,
            forge_mutation_permitted: diagnostics.forge_mutation_permitted,
            semantic_merge_permitted: diagnostics.semantic_merge_permitted,
            accepted_memory_mutation_permitted: diagnostics.accepted_memory_mutation_permitted,
            callback_permitted: diagnostics.callback_permitted,
            interruption_permitted: diagnostics.interruption_permitted,
            recovery_permitted: diagnostics.recovery_permitted,
            raw_payload_retained: diagnostics.raw_payload_retained,
            payload_body_included: diagnostics.payload_body_included,
            private_planning_body_exposed: diagnostics.private_planning_body_exposed,
            provider_payload_exposed: diagnostics.provider_payload_exposed,
            source_body_exposed: diagnostics.source_body_exposed,
            ui_apply_permitted: diagnostics.ui_apply_permitted,
        }
    }
}

impl From<&PlanningProjectionImportActiveApplyDiagnosticBucket>
    for ControlPlanningProjectionImportActiveApplyBucketDto
{
    fn from(bucket: &PlanningProjectionImportActiveApplyDiagnosticBucket) -> Self {
        Self {
            label: bucket.label.clone(),
            count: bucket.count,
        }
    }
}
