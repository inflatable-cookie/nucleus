use serde::{Deserialize, Serialize};

use crate::{
    PlanningCapturePublicationStoppedRequestDiagnosticBucket,
    PlanningCapturePublicationStoppedRequestDiagnostics,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlPlanningCapturePublicationDiagnosticsDto {
    pub diagnostics_id: String,
    pub request_count: usize,
    pub persisted_request_count: usize,
    pub duplicate_request_count: usize,
    pub blocked_request_count: usize,
    pub blocker_count: usize,
    pub adapter_family_buckets: Vec<ControlPlanningCapturePublicationBucketDto>,
    pub operation_buckets: Vec<ControlPlanningCapturePublicationBucketDto>,
    pub evidence_ref_count: usize,
    pub management_file_ref_count: usize,
    pub command_execution_permitted: bool,
    pub runner_handoff_permitted: bool,
    pub commit_permitted: bool,
    pub snapshot_permitted: bool,
    pub publish_permitted: bool,
    pub push_permitted: bool,
    pub forge_share_permitted: bool,
    pub provider_write_permitted: bool,
    pub projection_import_permitted: bool,
    pub task_promotion_permitted: bool,
    pub callback_response_permitted: bool,
    pub interruption_permitted: bool,
    pub recovery_permitted: bool,
    pub raw_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlPlanningCapturePublicationBucketDto {
    pub label: String,
    pub count: usize,
}

impl From<&PlanningCapturePublicationStoppedRequestDiagnostics>
    for ControlPlanningCapturePublicationDiagnosticsDto
{
    fn from(diagnostics: &PlanningCapturePublicationStoppedRequestDiagnostics) -> Self {
        Self {
            diagnostics_id: diagnostics.diagnostics_id.clone(),
            request_count: diagnostics.request_count,
            persisted_request_count: diagnostics.persisted_request_count,
            duplicate_request_count: diagnostics.duplicate_request_count,
            blocked_request_count: diagnostics.blocked_request_count,
            blocker_count: diagnostics.blocker_count,
            adapter_family_buckets: diagnostics
                .adapter_family_buckets
                .iter()
                .map(ControlPlanningCapturePublicationBucketDto::from)
                .collect(),
            operation_buckets: diagnostics
                .operation_buckets
                .iter()
                .map(ControlPlanningCapturePublicationBucketDto::from)
                .collect(),
            evidence_ref_count: diagnostics.evidence_ref_count,
            management_file_ref_count: diagnostics.management_file_ref_count,
            command_execution_permitted: diagnostics.command_execution_permitted,
            runner_handoff_permitted: diagnostics.runner_handoff_permitted,
            commit_permitted: diagnostics.commit_permitted,
            snapshot_permitted: diagnostics.snapshot_permitted,
            publish_permitted: diagnostics.publish_permitted,
            push_permitted: diagnostics.push_permitted,
            forge_share_permitted: diagnostics.forge_share_permitted,
            provider_write_permitted: diagnostics.provider_write_permitted,
            projection_import_permitted: diagnostics.projection_import_permitted,
            task_promotion_permitted: diagnostics.task_promotion_permitted,
            callback_response_permitted: diagnostics.callback_response_permitted,
            interruption_permitted: diagnostics.interruption_permitted,
            recovery_permitted: diagnostics.recovery_permitted,
            raw_payload_retained: diagnostics.raw_payload_retained,
        }
    }
}

impl From<&PlanningCapturePublicationStoppedRequestDiagnosticBucket>
    for ControlPlanningCapturePublicationBucketDto
{
    fn from(bucket: &PlanningCapturePublicationStoppedRequestDiagnosticBucket) -> Self {
        Self {
            label: bucket.label.clone(),
            count: bucket.count,
        }
    }
}
