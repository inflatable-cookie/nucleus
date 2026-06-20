//! Adapter-neutral plan metadata for completion SCM capture preparation.

use serde::{Deserialize, Serialize};

use crate::CompletionScmCapturePreparationCandidatesRecord;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompletionScmCaptureAdapterNeutralPlanInput {
    pub candidates: CompletionScmCapturePreparationCandidatesRecord,
    pub adapter_label: String,
    pub workflow_label: String,
    pub adapter_available: bool,
    pub adapter_supports_capture: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CompletionScmCaptureAdapterNeutralPlanRecord {
    pub plan_id: String,
    pub plans: Vec<CompletionScmCapturePlanItem>,
    pub skipped_admission_ids: Vec<String>,
    pub adapter_label: String,
    pub workflow_label: String,
    pub scm_capture_authority_granted: bool,
    pub scm_publish_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub raw_material_exposed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CompletionScmCapturePlanItem {
    pub plan_item_id: String,
    pub preparation_candidate_id: String,
    pub task_id: String,
    pub work_item_id: Option<String>,
    pub completion_id: Option<String>,
    pub adapter_label: String,
    pub workflow_label: String,
    pub status: CompletionScmCapturePlanStatus,
    pub blockers: Vec<CompletionScmCapturePlanBlocker>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletionScmCapturePlanStatus {
    Ready,
    Unsupported,
    RepairRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletionScmCapturePlanBlocker {
    AdapterUnavailable,
    CaptureUnsupported,
    AdapterLabelMissing,
    WorkflowLabelMissing,
}

pub fn completion_scm_capture_adapter_neutral_plan(
    input: CompletionScmCaptureAdapterNeutralPlanInput,
) -> CompletionScmCaptureAdapterNeutralPlanRecord {
    let blockers = blockers(&input);
    let status = status(&blockers);
    let mut plans = input
        .candidates
        .candidates
        .into_iter()
        .map(|candidate| CompletionScmCapturePlanItem {
            plan_item_id: format!(
                "completion-scm-capture-plan:{}",
                candidate.preparation_candidate_id
            ),
            preparation_candidate_id: candidate.preparation_candidate_id,
            task_id: candidate.task_id,
            work_item_id: candidate.work_item_id,
            completion_id: candidate.completion_id,
            adapter_label: input.adapter_label.clone(),
            workflow_label: input.workflow_label.clone(),
            status: status.clone(),
            blockers: blockers.clone(),
        })
        .collect::<Vec<_>>();
    plans.sort_by(|left, right| left.plan_item_id.cmp(&right.plan_item_id));

    CompletionScmCaptureAdapterNeutralPlanRecord {
        plan_id: "completion-scm-capture-adapter-neutral-plan".to_owned(),
        plans,
        skipped_admission_ids: input.candidates.skipped_admission_ids,
        adapter_label: input.adapter_label,
        workflow_label: input.workflow_label,
        scm_capture_authority_granted: false,
        scm_publish_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        raw_material_exposed: false,
    }
}

fn blockers(
    input: &CompletionScmCaptureAdapterNeutralPlanInput,
) -> Vec<CompletionScmCapturePlanBlocker> {
    let mut blockers = Vec::new();
    if !input.adapter_available {
        blockers.push(CompletionScmCapturePlanBlocker::AdapterUnavailable);
    }
    if !input.adapter_supports_capture {
        blockers.push(CompletionScmCapturePlanBlocker::CaptureUnsupported);
    }
    if input.adapter_label.trim().is_empty() {
        blockers.push(CompletionScmCapturePlanBlocker::AdapterLabelMissing);
    }
    if input.workflow_label.trim().is_empty() {
        blockers.push(CompletionScmCapturePlanBlocker::WorkflowLabelMissing);
    }
    blockers
}

fn status(blockers: &[CompletionScmCapturePlanBlocker]) -> CompletionScmCapturePlanStatus {
    if blockers.is_empty() {
        CompletionScmCapturePlanStatus::Ready
    } else if blockers
        .iter()
        .any(|blocker| blocker == &CompletionScmCapturePlanBlocker::AdapterUnavailable)
    {
        CompletionScmCapturePlanStatus::RepairRequired
    } else {
        CompletionScmCapturePlanStatus::Unsupported
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_scm_capture_adapter_neutral_plan_keeps_core_terms_provider_neutral() {
        let record = completion_scm_capture_adapter_neutral_plan(input(
            "git",
            "working-copy-capture",
            true,
            true,
        ));

        assert_eq!(record.plans.len(), 1);
        assert_eq!(
            record.plans[0].status,
            CompletionScmCapturePlanStatus::Ready
        );
        assert_eq!(record.plans[0].adapter_label, "git");
        assert_eq!(record.plans[0].workflow_label, "working-copy-capture");
        assert!(!record.scm_capture_authority_granted);
    }

    #[test]
    fn completion_scm_capture_adapter_neutral_plan_allows_non_git_labels() {
        let record = completion_scm_capture_adapter_neutral_plan(input(
            "convergence",
            "snapshot-capture",
            true,
            true,
        ));

        assert_eq!(record.plans[0].adapter_label, "convergence");
        assert_eq!(record.plans[0].workflow_label, "snapshot-capture");
        assert_eq!(
            record.plans[0].status,
            CompletionScmCapturePlanStatus::Ready
        );
    }

    #[test]
    fn completion_scm_capture_adapter_neutral_plan_surfaces_unsupported_state() {
        let record = completion_scm_capture_adapter_neutral_plan(input(
            "manual",
            "manual-copy",
            true,
            false,
        ));

        assert_eq!(
            record.plans[0].status,
            CompletionScmCapturePlanStatus::Unsupported
        );
        assert!(record.plans[0]
            .blockers
            .contains(&CompletionScmCapturePlanBlocker::CaptureUnsupported));
        assert!(!record.forge_authority_granted);
    }

    fn input(
        adapter_label: &str,
        workflow_label: &str,
        adapter_available: bool,
        adapter_supports_capture: bool,
    ) -> CompletionScmCaptureAdapterNeutralPlanInput {
        CompletionScmCaptureAdapterNeutralPlanInput {
            candidates: crate::CompletionScmCapturePreparationCandidatesRecord {
                projection_id: "candidates".to_owned(),
                candidates: vec![crate::CompletionScmCapturePreparationCandidate {
                    preparation_candidate_id: "prep:1".to_owned(),
                    persisted_admission_id: "persisted:1".to_owned(),
                    admission_id: "admission:1".to_owned(),
                    readiness_id: "readiness:1".to_owned(),
                    candidate_id: "candidate:1".to_owned(),
                    task_id: "task:1".to_owned(),
                    work_item_id: Some("work:1".to_owned()),
                    completion_id: Some("completion:1".to_owned()),
                    operator_ref: "operator:tom".to_owned(),
                    evidence_refs: vec!["evidence:prep".to_owned()],
                }],
                skipped_admission_ids: Vec::new(),
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
        }
    }
}
