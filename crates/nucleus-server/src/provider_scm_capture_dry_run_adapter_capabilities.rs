//! Adapter capability planning for SCM capture dry runs.

use serde::{Deserialize, Serialize};

use crate::ScmCaptureDryRunPlanCandidatesRecord;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmCaptureDryRunAdapterCapabilitiesInput {
    pub candidates: ScmCaptureDryRunPlanCandidatesRecord,
    pub adapter_label: String,
    pub workflow_label: String,
    pub adapter_available: bool,
    pub adapter_supports_capture: bool,
    pub adapter_supports_dry_run: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmCaptureDryRunAdapterCapabilitiesRecord {
    pub plan_id: String,
    pub plans: Vec<ScmCaptureDryRunPlanItem>,
    pub skipped_preparation_ids: Vec<String>,
    pub adapter_label: String,
    pub workflow_label: String,
    pub scm_dry_run_authority_granted: bool,
    pub scm_capture_authority_granted: bool,
    pub scm_publish_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub raw_material_exposed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmCaptureDryRunPlanItem {
    pub dry_run_plan_item_id: String,
    pub dry_run_candidate_id: String,
    pub persisted_preparation_id: String,
    pub plan_item_id: String,
    pub admission_id: String,
    pub readiness_id: String,
    pub capture_candidate_id: String,
    pub task_id: String,
    pub work_item_id: Option<String>,
    pub completion_id: Option<String>,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub adapter_label: String,
    pub workflow_label: String,
    pub status: ScmCaptureDryRunPlanStatus,
    pub blockers: Vec<ScmCaptureDryRunPlanBlocker>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmCaptureDryRunPlanStatus {
    Ready,
    Unsupported,
    RepairRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmCaptureDryRunPlanBlocker {
    AdapterUnavailable,
    CaptureUnsupported,
    DryRunUnsupported,
    AdapterLabelMissing,
    WorkflowLabelMissing,
}

pub fn scm_capture_dry_run_adapter_capabilities(
    input: ScmCaptureDryRunAdapterCapabilitiesInput,
) -> ScmCaptureDryRunAdapterCapabilitiesRecord {
    let blockers = blockers(&input);
    let status = status(&blockers);
    let mut plans = input
        .candidates
        .candidates
        .into_iter()
        .map(|candidate| ScmCaptureDryRunPlanItem {
            dry_run_plan_item_id: format!(
                "scm-capture-dry-run-plan:{}",
                candidate.dry_run_candidate_id
            ),
            dry_run_candidate_id: candidate.dry_run_candidate_id,
            persisted_preparation_id: candidate.persisted_preparation_id,
            plan_item_id: candidate.plan_item_id,
            admission_id: candidate.admission_id,
            readiness_id: candidate.readiness_id,
            capture_candidate_id: candidate.capture_candidate_id,
            task_id: candidate.task_id,
            work_item_id: candidate.work_item_id,
            completion_id: candidate.completion_id,
            operator_ref: candidate.operator_ref,
            evidence_refs: candidate.evidence_refs,
            adapter_label: input.adapter_label.clone(),
            workflow_label: input.workflow_label.clone(),
            status: status.clone(),
            blockers: blockers.clone(),
        })
        .collect::<Vec<_>>();
    plans.sort_by(|left, right| left.dry_run_plan_item_id.cmp(&right.dry_run_plan_item_id));

    ScmCaptureDryRunAdapterCapabilitiesRecord {
        plan_id: "scm-capture-dry-run-adapter-capabilities".to_owned(),
        plans,
        skipped_preparation_ids: input.candidates.skipped_preparation_ids,
        adapter_label: input.adapter_label,
        workflow_label: input.workflow_label,
        scm_dry_run_authority_granted: false,
        scm_capture_authority_granted: false,
        scm_publish_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        raw_material_exposed: false,
    }
}

fn blockers(input: &ScmCaptureDryRunAdapterCapabilitiesInput) -> Vec<ScmCaptureDryRunPlanBlocker> {
    let mut blockers = Vec::new();
    if !input.adapter_available {
        blockers.push(ScmCaptureDryRunPlanBlocker::AdapterUnavailable);
    }
    if !input.adapter_supports_capture {
        blockers.push(ScmCaptureDryRunPlanBlocker::CaptureUnsupported);
    }
    if !input.adapter_supports_dry_run {
        blockers.push(ScmCaptureDryRunPlanBlocker::DryRunUnsupported);
    }
    if input.adapter_label.trim().is_empty() {
        blockers.push(ScmCaptureDryRunPlanBlocker::AdapterLabelMissing);
    }
    if input.workflow_label.trim().is_empty() {
        blockers.push(ScmCaptureDryRunPlanBlocker::WorkflowLabelMissing);
    }
    blockers
}

fn status(blockers: &[ScmCaptureDryRunPlanBlocker]) -> ScmCaptureDryRunPlanStatus {
    if blockers.is_empty() {
        ScmCaptureDryRunPlanStatus::Ready
    } else if blockers
        .iter()
        .any(|blocker| blocker == &ScmCaptureDryRunPlanBlocker::AdapterUnavailable)
    {
        ScmCaptureDryRunPlanStatus::RepairRequired
    } else {
        ScmCaptureDryRunPlanStatus::Unsupported
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scm_capture_dry_run_adapter_capabilities_keeps_core_terms_provider_neutral() {
        let record = scm_capture_dry_run_adapter_capabilities(input(
            "git",
            "working-tree-preview",
            true,
            true,
            true,
        ));

        assert_eq!(record.plans.len(), 1);
        assert_eq!(record.plans[0].status, ScmCaptureDryRunPlanStatus::Ready);
        assert_eq!(record.plans[0].adapter_label, "git");
        assert_eq!(record.plans[0].workflow_label, "working-tree-preview");
        assert!(!record.scm_dry_run_authority_granted);
        assert!(!record.scm_capture_authority_granted);
    }

    #[test]
    fn scm_capture_dry_run_adapter_capabilities_allow_non_git_labels() {
        let record = scm_capture_dry_run_adapter_capabilities(input(
            "convergence",
            "snapshot-preview",
            true,
            true,
            true,
        ));

        assert_eq!(record.plans[0].adapter_label, "convergence");
        assert_eq!(record.plans[0].workflow_label, "snapshot-preview");
        assert_eq!(record.plans[0].status, ScmCaptureDryRunPlanStatus::Ready);
    }

    #[test]
    fn scm_capture_dry_run_adapter_capabilities_surface_unsupported_dry_run() {
        let record = scm_capture_dry_run_adapter_capabilities(input(
            "manual",
            "manual-review",
            true,
            true,
            false,
        ));

        assert_eq!(
            record.plans[0].status,
            ScmCaptureDryRunPlanStatus::Unsupported
        );
        assert!(record.plans[0]
            .blockers
            .contains(&ScmCaptureDryRunPlanBlocker::DryRunUnsupported));
        assert!(!record.forge_authority_granted);
    }

    #[test]
    fn scm_capture_dry_run_adapter_capabilities_require_available_adapter() {
        let record = scm_capture_dry_run_adapter_capabilities(input(
            "git",
            "working-tree-preview",
            false,
            true,
            true,
        ));

        assert_eq!(
            record.plans[0].status,
            ScmCaptureDryRunPlanStatus::RepairRequired
        );
        assert!(record.plans[0]
            .blockers
            .contains(&ScmCaptureDryRunPlanBlocker::AdapterUnavailable));
    }

    fn input(
        adapter_label: &str,
        workflow_label: &str,
        adapter_available: bool,
        adapter_supports_capture: bool,
        adapter_supports_dry_run: bool,
    ) -> ScmCaptureDryRunAdapterCapabilitiesInput {
        ScmCaptureDryRunAdapterCapabilitiesInput {
            candidates: crate::ScmCaptureDryRunPlanCandidatesRecord {
                projection_id: "candidates".to_owned(),
                candidates: vec![crate::ScmCaptureDryRunPlanCandidate {
                    dry_run_candidate_id: "candidate:1".to_owned(),
                    persisted_preparation_id: "persisted:1".to_owned(),
                    plan_item_id: "plan:1".to_owned(),
                    admission_id: "admission:1".to_owned(),
                    readiness_id: "readiness:1".to_owned(),
                    capture_candidate_id: "capture:1".to_owned(),
                    task_id: "task:1".to_owned(),
                    work_item_id: Some("work:1".to_owned()),
                    completion_id: Some("completion:1".to_owned()),
                    operator_ref: "operator:tom".to_owned(),
                    evidence_refs: vec!["evidence:dry-run".to_owned()],
                    adapter_label: adapter_label.to_owned(),
                    workflow_label: workflow_label.to_owned(),
                }],
                skipped_preparation_ids: vec!["persisted:skipped".to_owned()],
                scm_dry_run_authority_granted: false,
                scm_capture_authority_granted: false,
                scm_publish_authority_granted: false,
                forge_authority_granted: false,
                provider_authority_granted: false,
                raw_material_exposed: false,
            },
            adapter_label: adapter_label.to_owned(),
            workflow_label: workflow_label.to_owned(),
            adapter_available,
            adapter_supports_capture,
            adapter_supports_dry_run,
        }
    }
}
