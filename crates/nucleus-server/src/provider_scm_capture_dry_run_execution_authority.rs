//! Authority proof for SCM capture dry-run execution records.

use serde::{Deserialize, Serialize};

use crate::{
    ScmCaptureDryRunExecutionAdmissionSet, ScmCaptureDryRunExecutionCapabilityRecord,
    ScmCaptureDryRunReceiptRecord,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmCaptureDryRunExecutionAuthorityInput {
    pub admissions: ScmCaptureDryRunExecutionAdmissionSet,
    pub capability: ScmCaptureDryRunExecutionCapabilityRecord,
    pub receipts: Vec<ScmCaptureDryRunReceiptRecord>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmCaptureDryRunExecutionAuthorityRecord {
    pub authority_id: String,
    pub admission_count: usize,
    pub capability_count: usize,
    pub receipt_count: usize,
    pub dry_run_executed_count: usize,
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

pub fn scm_capture_dry_run_execution_authority(
    input: ScmCaptureDryRunExecutionAuthorityInput,
) -> ScmCaptureDryRunExecutionAuthorityRecord {
    ScmCaptureDryRunExecutionAuthorityRecord {
        authority_id: "scm-capture-dry-run-execution-authority".to_owned(),
        admission_count: input.admissions.admissions.len(),
        capability_count: input.capability.items.len(),
        receipt_count: input.receipts.len(),
        dry_run_executed_count: input
            .receipts
            .iter()
            .filter(|receipt| receipt.scm_dry_run_executed)
            .count(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scm_capture_dry_run_execution_authority_keeps_capture_and_forge_blocked() {
        let record = scm_capture_dry_run_execution_authority(input());

        assert_eq!(record.admission_count, 1);
        assert_eq!(record.capability_count, 1);
        assert_eq!(record.receipt_count, 1);
        assert_eq!(record.dry_run_executed_count, 1);
        assert!(!record.scm_capture_executed);
        assert!(!record.scm_publish_executed);
        assert!(!record.forge_change_request_created);
        assert!(!record.forge_merge_executed);
        assert!(!record.provider_write_executed);
        assert!(!record.callback_response_executed);
        assert!(!record.interruption_executed);
        assert!(!record.recovery_executed);
        assert!(!record.raw_material_exposed);
    }

    fn input() -> ScmCaptureDryRunExecutionAuthorityInput {
        let admission = crate::ScmCaptureDryRunExecutionAdmissionRecord {
            admission_id: "admission:1".to_owned(),
            persisted_dry_run_plan_id: "persisted:1".to_owned(),
            dry_run_plan_item_id: "dry-run-plan:1".to_owned(),
            dry_run_candidate_id: "dry-run-candidate:1".to_owned(),
            persisted_preparation_id: "persisted-preparation:1".to_owned(),
            task_id: "task:1".to_owned(),
            work_item_id: Some("work:1".to_owned()),
            completion_id: Some("completion:1".to_owned()),
            operator_ref: "operator:tom".to_owned(),
            evidence_refs: vec!["evidence:dry-run".to_owned()],
            adapter_label: "git".to_owned(),
            workflow_label: "working-tree-preview".to_owned(),
            status: crate::ScmCaptureDryRunExecutionAdmissionStatus::Admitted,
            blockers: Vec::new(),
            dry_run_execution_admitted: true,
            scm_dry_run_executed: false,
            scm_capture_executed: false,
            scm_publish_executed: false,
            forge_authority_granted: false,
            provider_authority_granted: false,
            raw_material_exposed: false,
        };
        let capability = crate::ScmCaptureDryRunExecutionCapabilityItem {
            capability_item_id: "capability:1".to_owned(),
            admission_id: admission.admission_id.clone(),
            persisted_dry_run_plan_id: admission.persisted_dry_run_plan_id.clone(),
            dry_run_plan_item_id: admission.dry_run_plan_item_id.clone(),
            task_id: admission.task_id.clone(),
            work_item_id: admission.work_item_id.clone(),
            completion_id: admission.completion_id.clone(),
            operator_ref: admission.operator_ref.clone(),
            evidence_refs: admission.evidence_refs.clone(),
            adapter_label: "git".to_owned(),
            workflow_label: "working-tree-preview".to_owned(),
            status: crate::ScmCaptureDryRunExecutionCapabilityStatus::Ready,
            blockers: Vec::new(),
        };
        ScmCaptureDryRunExecutionAuthorityInput {
            admissions: crate::ScmCaptureDryRunExecutionAdmissionSet {
                admission_set_id: "admissions".to_owned(),
                admissions: vec![admission],
                skipped_dry_run_plan_ids: Vec::new(),
                scm_dry_run_executed: false,
                scm_capture_executed: false,
                scm_publish_executed: false,
                forge_authority_granted: false,
                provider_authority_granted: false,
                raw_material_exposed: false,
            },
            capability: crate::ScmCaptureDryRunExecutionCapabilityRecord {
                capability_id: "capability".to_owned(),
                items: vec![capability.clone()],
                skipped_dry_run_plan_ids: Vec::new(),
                adapter_label: "git".to_owned(),
                workflow_label: "working-tree-preview".to_owned(),
                scm_dry_run_executed: false,
                scm_capture_executed: false,
                scm_publish_executed: false,
                forge_authority_granted: false,
                provider_authority_granted: false,
                raw_material_exposed: false,
            },
            receipts: vec![crate::ScmCaptureDryRunReceiptRecord {
                receipt_id: "receipt:1".to_owned(),
                capability_item_id: capability.capability_item_id,
                admission_id: capability.admission_id,
                persisted_dry_run_plan_id: capability.persisted_dry_run_plan_id,
                dry_run_plan_item_id: capability.dry_run_plan_item_id,
                task_id: capability.task_id,
                work_item_id: capability.work_item_id,
                completion_id: capability.completion_id,
                operator_ref: capability.operator_ref,
                adapter_label: capability.adapter_label,
                workflow_label: capability.workflow_label,
                outcome: crate::ScmCaptureDryRunReceiptStatus::Completed,
                blockers: Vec::new(),
                evidence_refs: vec!["evidence:receipt".to_owned()],
                changed_path_count: 1,
                summary_line_count: 2,
                scm_dry_run_executed: true,
                scm_capture_executed: false,
                scm_publish_executed: false,
                forge_change_request_created: false,
                forge_merge_executed: false,
                provider_write_executed: false,
                callback_response_executed: false,
                interruption_executed: false,
                recovery_executed: false,
                raw_material_exposed: false,
            }],
        }
    }
}
