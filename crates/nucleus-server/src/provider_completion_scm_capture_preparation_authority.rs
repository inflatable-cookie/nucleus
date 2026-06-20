//! Authority proof for completion SCM capture preparation records.

use serde::{Deserialize, Serialize};

use crate::{
    CompletionScmCaptureAdapterNeutralPlanRecord, CompletionScmCapturePreparationCandidatesRecord,
    CompletionScmCapturePreparationDiagnosticsRecord,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompletionScmCapturePreparationAuthorityInput {
    pub candidates: CompletionScmCapturePreparationCandidatesRecord,
    pub plan: CompletionScmCaptureAdapterNeutralPlanRecord,
    pub diagnostics: CompletionScmCapturePreparationDiagnosticsRecord,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CompletionScmCapturePreparationAuthorityRecord {
    pub authority_id: String,
    pub candidate_count: usize,
    pub plan_count: usize,
    pub ready_plan_count: usize,
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

pub fn completion_scm_capture_preparation_authority(
    input: CompletionScmCapturePreparationAuthorityInput,
) -> CompletionScmCapturePreparationAuthorityRecord {
    CompletionScmCapturePreparationAuthorityRecord {
        authority_id: "completion-scm-capture-preparation-authority".to_owned(),
        candidate_count: input.candidates.candidates.len(),
        plan_count: input.plan.plans.len(),
        ready_plan_count: input.diagnostics.ready_plan_count,
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
    fn completion_scm_capture_preparation_authority_blocks_external_effects() {
        let record = completion_scm_capture_preparation_authority(input());

        assert_eq!(record.candidate_count, 1);
        assert_eq!(record.plan_count, 1);
        assert_eq!(record.ready_plan_count, 1);
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

    fn input() -> CompletionScmCapturePreparationAuthorityInput {
        CompletionScmCapturePreparationAuthorityInput {
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
            plan: crate::CompletionScmCaptureAdapterNeutralPlanRecord {
                plan_id: "plan".to_owned(),
                plans: vec![crate::CompletionScmCapturePlanItem {
                    plan_item_id: "plan:1".to_owned(),
                    preparation_candidate_id: "prep:1".to_owned(),
                    task_id: "task:1".to_owned(),
                    work_item_id: Some("work:1".to_owned()),
                    completion_id: Some("completion:1".to_owned()),
                    adapter_label: "adapter".to_owned(),
                    workflow_label: "workflow".to_owned(),
                    status: crate::CompletionScmCapturePlanStatus::Ready,
                    blockers: Vec::new(),
                }],
                skipped_admission_ids: Vec::new(),
                adapter_label: "adapter".to_owned(),
                workflow_label: "workflow".to_owned(),
                scm_capture_authority_granted: false,
                scm_publish_authority_granted: false,
                forge_authority_granted: false,
                provider_authority_granted: false,
                raw_material_exposed: false,
            },
            diagnostics: crate::CompletionScmCapturePreparationDiagnosticsRecord {
                diagnostics_id: "diagnostics".to_owned(),
                candidate_count: 1,
                skipped_admission_count: 0,
                plan_count: 1,
                ready_plan_count: 1,
                unsupported_plan_count: 0,
                repair_required_plan_count: 0,
                blocker_count: 0,
                scm_capture_authority_granted: false,
                scm_publish_authority_granted: false,
                forge_authority_granted: false,
                provider_authority_granted: false,
                raw_material_exposed: false,
            },
        }
    }
}
