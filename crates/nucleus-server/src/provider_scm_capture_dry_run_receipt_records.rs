//! Sanitized receipt records for SCM capture dry-run execution outcomes.

use serde::{Deserialize, Serialize};

use crate::{ScmCaptureDryRunExecutionCapabilityItem, ScmCaptureDryRunExecutionCapabilityStatus};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmCaptureDryRunReceiptInput {
    pub capability_item: ScmCaptureDryRunExecutionCapabilityItem,
    pub outcome: ScmCaptureDryRunReceiptStatus,
    pub evidence_refs: Vec<String>,
    pub changed_path_count: usize,
    pub summary_line_count: usize,
    pub scm_dry_run_executed: bool,
    pub raw_output_present: bool,
    pub scm_capture_requested: bool,
    pub scm_publish_requested: bool,
    pub forge_change_request_requested: bool,
    pub forge_merge_requested: bool,
    pub provider_write_requested: bool,
    pub callback_response_requested: bool,
    pub interruption_requested: bool,
    pub recovery_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmCaptureDryRunReceiptRecord {
    pub receipt_id: String,
    pub capability_item_id: String,
    pub admission_id: String,
    pub persisted_dry_run_plan_id: String,
    pub dry_run_plan_item_id: String,
    pub task_id: String,
    pub work_item_id: Option<String>,
    pub completion_id: Option<String>,
    pub operator_ref: String,
    pub adapter_label: String,
    pub workflow_label: String,
    pub outcome: ScmCaptureDryRunReceiptStatus,
    pub blockers: Vec<ScmCaptureDryRunReceiptBlocker>,
    pub evidence_refs: Vec<String>,
    pub changed_path_count: usize,
    pub summary_line_count: usize,
    pub scm_dry_run_executed: bool,
    pub scm_capture_executed: bool,
    pub scm_publish_executed: bool,
    pub forge_change_request_created: bool,
    pub forge_merge_executed: bool,
    pub provider_write_executed: bool,
    pub callback_response_executed: bool,
    pub interruption_executed: bool,
    pub recovery_executed: bool,
    pub raw_material_exposed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmCaptureDryRunReceiptStatus {
    Accepted,
    Completed,
    Failed,
    TimedOut,
    Blocked,
    RepairRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmCaptureDryRunReceiptBlocker {
    CapabilityNotReady,
    EvidenceRefsMissing,
    RawOutputPresent,
    CaptureRequested,
    PublishRequested,
    ForgeChangeRequestRequested,
    ForgeMergeRequested,
    ProviderWriteRequested,
    CallbackResponseRequested,
    InterruptionRequested,
    RecoveryRequested,
}

pub fn scm_capture_dry_run_receipt_record(
    input: ScmCaptureDryRunReceiptInput,
) -> ScmCaptureDryRunReceiptRecord {
    let blockers = blockers(&input);
    let outcome = if blockers.is_empty() {
        input.outcome
    } else {
        ScmCaptureDryRunReceiptStatus::Blocked
    };

    ScmCaptureDryRunReceiptRecord {
        receipt_id: format!(
            "scm-capture-dry-run-receipt:{}",
            input.capability_item.capability_item_id
        ),
        capability_item_id: input.capability_item.capability_item_id,
        admission_id: input.capability_item.admission_id,
        persisted_dry_run_plan_id: input.capability_item.persisted_dry_run_plan_id,
        dry_run_plan_item_id: input.capability_item.dry_run_plan_item_id,
        task_id: input.capability_item.task_id,
        work_item_id: input.capability_item.work_item_id,
        completion_id: input.capability_item.completion_id,
        operator_ref: input.capability_item.operator_ref,
        adapter_label: input.capability_item.adapter_label,
        workflow_label: input.capability_item.workflow_label,
        outcome,
        blockers,
        evidence_refs: unique_sorted(input.evidence_refs),
        changed_path_count: input.changed_path_count,
        summary_line_count: input.summary_line_count,
        scm_dry_run_executed: input.scm_dry_run_executed,
        scm_capture_executed: false,
        scm_publish_executed: false,
        forge_change_request_created: false,
        forge_merge_executed: false,
        provider_write_executed: false,
        callback_response_executed: false,
        interruption_executed: false,
        recovery_executed: false,
        raw_material_exposed: false,
    }
}

fn blockers(input: &ScmCaptureDryRunReceiptInput) -> Vec<ScmCaptureDryRunReceiptBlocker> {
    let mut blockers = Vec::new();
    if input.capability_item.status != ScmCaptureDryRunExecutionCapabilityStatus::Ready {
        blockers.push(ScmCaptureDryRunReceiptBlocker::CapabilityNotReady);
    }
    if input.evidence_refs.is_empty() {
        blockers.push(ScmCaptureDryRunReceiptBlocker::EvidenceRefsMissing);
    }
    if input.raw_output_present {
        blockers.push(ScmCaptureDryRunReceiptBlocker::RawOutputPresent);
    }
    if input.scm_capture_requested {
        blockers.push(ScmCaptureDryRunReceiptBlocker::CaptureRequested);
    }
    if input.scm_publish_requested {
        blockers.push(ScmCaptureDryRunReceiptBlocker::PublishRequested);
    }
    if input.forge_change_request_requested {
        blockers.push(ScmCaptureDryRunReceiptBlocker::ForgeChangeRequestRequested);
    }
    if input.forge_merge_requested {
        blockers.push(ScmCaptureDryRunReceiptBlocker::ForgeMergeRequested);
    }
    if input.provider_write_requested {
        blockers.push(ScmCaptureDryRunReceiptBlocker::ProviderWriteRequested);
    }
    if input.callback_response_requested {
        blockers.push(ScmCaptureDryRunReceiptBlocker::CallbackResponseRequested);
    }
    if input.interruption_requested {
        blockers.push(ScmCaptureDryRunReceiptBlocker::InterruptionRequested);
    }
    if input.recovery_requested {
        blockers.push(ScmCaptureDryRunReceiptBlocker::RecoveryRequested);
    }
    blockers
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scm_capture_dry_run_receipt_records_keep_sanitized_execution_outcome() {
        let record = scm_capture_dry_run_receipt_record(input(
            ScmCaptureDryRunReceiptStatus::Completed,
            true,
            false,
        ));

        assert_eq!(record.outcome, ScmCaptureDryRunReceiptStatus::Completed);
        assert!(record.scm_dry_run_executed);
        assert_eq!(record.changed_path_count, 2);
        assert_eq!(record.summary_line_count, 4);
        assert!(!record.scm_capture_executed);
        assert!(!record.scm_publish_executed);
        assert!(!record.raw_material_exposed);
    }

    #[test]
    fn scm_capture_dry_run_receipt_records_block_raw_or_external_requests() {
        let record = scm_capture_dry_run_receipt_record(input(
            ScmCaptureDryRunReceiptStatus::Completed,
            true,
            true,
        ));

        assert_eq!(record.outcome, ScmCaptureDryRunReceiptStatus::Blocked);
        assert!(record
            .blockers
            .contains(&ScmCaptureDryRunReceiptBlocker::RawOutputPresent));
        assert!(record
            .blockers
            .contains(&ScmCaptureDryRunReceiptBlocker::CaptureRequested));
        assert!(!record.scm_capture_executed);
        assert!(!record.raw_material_exposed);
    }

    fn input(
        outcome: ScmCaptureDryRunReceiptStatus,
        scm_dry_run_executed: bool,
        blocked: bool,
    ) -> ScmCaptureDryRunReceiptInput {
        ScmCaptureDryRunReceiptInput {
            capability_item: capability_item(),
            outcome,
            evidence_refs: vec!["evidence:dry-run".to_owned()],
            changed_path_count: 2,
            summary_line_count: 4,
            scm_dry_run_executed,
            raw_output_present: blocked,
            scm_capture_requested: blocked,
            scm_publish_requested: false,
            forge_change_request_requested: false,
            forge_merge_requested: false,
            provider_write_requested: false,
            callback_response_requested: false,
            interruption_requested: false,
            recovery_requested: false,
        }
    }

    fn capability_item() -> ScmCaptureDryRunExecutionCapabilityItem {
        ScmCaptureDryRunExecutionCapabilityItem {
            capability_item_id: "capability:1".to_owned(),
            admission_id: "admission:1".to_owned(),
            persisted_dry_run_plan_id: "persisted:1".to_owned(),
            dry_run_plan_item_id: "dry-run-plan:1".to_owned(),
            task_id: "task:1".to_owned(),
            work_item_id: Some("work:1".to_owned()),
            completion_id: Some("completion:1".to_owned()),
            operator_ref: "operator:tom".to_owned(),
            evidence_refs: vec!["evidence:capability".to_owned()],
            adapter_label: "git".to_owned(),
            workflow_label: "working-tree-preview".to_owned(),
            status: ScmCaptureDryRunExecutionCapabilityStatus::Ready,
            blockers: Vec::new(),
        }
    }
}
