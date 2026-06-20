//! Adapter execution capability records for SCM capture dry runs.

use serde::{Deserialize, Serialize};

use crate::{ScmCaptureDryRunExecutionAdmissionSet, ScmCaptureDryRunExecutionAdmissionStatus};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmCaptureDryRunExecutionCapabilityInput {
    pub admissions: ScmCaptureDryRunExecutionAdmissionSet,
    pub adapter_label: String,
    pub workflow_label: String,
    pub adapter_available: bool,
    pub adapter_supports_dry_run_execution: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmCaptureDryRunExecutionCapabilityRecord {
    pub capability_id: String,
    pub items: Vec<ScmCaptureDryRunExecutionCapabilityItem>,
    pub skipped_dry_run_plan_ids: Vec<String>,
    pub adapter_label: String,
    pub workflow_label: String,
    pub scm_dry_run_executed: bool,
    pub scm_capture_executed: bool,
    pub scm_publish_executed: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub raw_material_exposed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmCaptureDryRunExecutionCapabilityItem {
    pub capability_item_id: String,
    pub admission_id: String,
    pub persisted_dry_run_plan_id: String,
    pub dry_run_plan_item_id: String,
    pub task_id: String,
    pub work_item_id: Option<String>,
    pub completion_id: Option<String>,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub adapter_label: String,
    pub workflow_label: String,
    pub status: ScmCaptureDryRunExecutionCapabilityStatus,
    pub blockers: Vec<ScmCaptureDryRunExecutionCapabilityBlocker>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmCaptureDryRunExecutionCapabilityStatus {
    Ready,
    Unsupported,
    RepairRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmCaptureDryRunExecutionCapabilityBlocker {
    AdmissionBlocked,
    AdapterUnavailable,
    DryRunExecutionUnsupported,
    AdapterLabelMissing,
    WorkflowLabelMissing,
}

pub fn scm_capture_dry_run_adapter_execution_capability(
    input: ScmCaptureDryRunExecutionCapabilityInput,
) -> ScmCaptureDryRunExecutionCapabilityRecord {
    let adapter_blockers = adapter_blockers(&input);
    let mut items = input
        .admissions
        .admissions
        .into_iter()
        .map(|admission| {
            let mut blockers = adapter_blockers.clone();
            if admission.status != ScmCaptureDryRunExecutionAdmissionStatus::Admitted {
                blockers.push(ScmCaptureDryRunExecutionCapabilityBlocker::AdmissionBlocked);
            }
            let status = status(&blockers);
            ScmCaptureDryRunExecutionCapabilityItem {
                capability_item_id: format!(
                    "scm-capture-dry-run-execution-capability:{}",
                    admission.admission_id
                ),
                admission_id: admission.admission_id,
                persisted_dry_run_plan_id: admission.persisted_dry_run_plan_id,
                dry_run_plan_item_id: admission.dry_run_plan_item_id,
                task_id: admission.task_id,
                work_item_id: admission.work_item_id,
                completion_id: admission.completion_id,
                operator_ref: admission.operator_ref,
                evidence_refs: admission.evidence_refs,
                adapter_label: input.adapter_label.clone(),
                workflow_label: input.workflow_label.clone(),
                status,
                blockers,
            }
        })
        .collect::<Vec<_>>();
    items.sort_by(|left, right| left.capability_item_id.cmp(&right.capability_item_id));

    ScmCaptureDryRunExecutionCapabilityRecord {
        capability_id: "scm-capture-dry-run-execution-capability".to_owned(),
        items,
        skipped_dry_run_plan_ids: input.admissions.skipped_dry_run_plan_ids,
        adapter_label: input.adapter_label,
        workflow_label: input.workflow_label,
        scm_dry_run_executed: false,
        scm_capture_executed: false,
        scm_publish_executed: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        raw_material_exposed: false,
    }
}

fn adapter_blockers(
    input: &ScmCaptureDryRunExecutionCapabilityInput,
) -> Vec<ScmCaptureDryRunExecutionCapabilityBlocker> {
    let mut blockers = Vec::new();
    if !input.adapter_available {
        blockers.push(ScmCaptureDryRunExecutionCapabilityBlocker::AdapterUnavailable);
    }
    if !input.adapter_supports_dry_run_execution {
        blockers.push(ScmCaptureDryRunExecutionCapabilityBlocker::DryRunExecutionUnsupported);
    }
    if input.adapter_label.trim().is_empty() {
        blockers.push(ScmCaptureDryRunExecutionCapabilityBlocker::AdapterLabelMissing);
    }
    if input.workflow_label.trim().is_empty() {
        blockers.push(ScmCaptureDryRunExecutionCapabilityBlocker::WorkflowLabelMissing);
    }
    blockers
}

fn status(
    blockers: &[ScmCaptureDryRunExecutionCapabilityBlocker],
) -> ScmCaptureDryRunExecutionCapabilityStatus {
    if blockers.is_empty() {
        ScmCaptureDryRunExecutionCapabilityStatus::Ready
    } else if blockers
        .iter()
        .any(|blocker| blocker == &ScmCaptureDryRunExecutionCapabilityBlocker::AdapterUnavailable)
    {
        ScmCaptureDryRunExecutionCapabilityStatus::RepairRequired
    } else {
        ScmCaptureDryRunExecutionCapabilityStatus::Unsupported
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scm_capture_dry_run_adapter_execution_capability_keeps_execution_separate() {
        let record = scm_capture_dry_run_adapter_execution_capability(input(true, true));

        assert_eq!(record.items.len(), 1);
        assert_eq!(
            record.items[0].status,
            ScmCaptureDryRunExecutionCapabilityStatus::Ready
        );
        assert_eq!(record.items[0].adapter_label, "git");
        assert!(!record.scm_dry_run_executed);
        assert!(!record.scm_capture_executed);
    }

    #[test]
    fn scm_capture_dry_run_adapter_execution_capability_surfaces_unsupported() {
        let record = scm_capture_dry_run_adapter_execution_capability(input(true, false));

        assert_eq!(
            record.items[0].status,
            ScmCaptureDryRunExecutionCapabilityStatus::Unsupported
        );
        assert!(record.items[0]
            .blockers
            .contains(&ScmCaptureDryRunExecutionCapabilityBlocker::DryRunExecutionUnsupported));
    }

    fn input(
        adapter_available: bool,
        adapter_supports_dry_run_execution: bool,
    ) -> ScmCaptureDryRunExecutionCapabilityInput {
        ScmCaptureDryRunExecutionCapabilityInput {
            admissions: crate::ScmCaptureDryRunExecutionAdmissionSet {
                admission_set_id: "admissions".to_owned(),
                admissions: vec![crate::ScmCaptureDryRunExecutionAdmissionRecord {
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
                }],
                skipped_dry_run_plan_ids: Vec::new(),
                scm_dry_run_executed: false,
                scm_capture_executed: false,
                scm_publish_executed: false,
                forge_authority_granted: false,
                provider_authority_granted: false,
                raw_material_exposed: false,
            },
            adapter_label: "git".to_owned(),
            workflow_label: "working-tree-preview".to_owned(),
            adapter_available,
            adapter_supports_dry_run_execution,
        }
    }
}
