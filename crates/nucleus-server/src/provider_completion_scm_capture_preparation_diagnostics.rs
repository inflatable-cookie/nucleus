//! Read-only diagnostics for completion SCM capture preparation.

use serde::{Deserialize, Serialize};

use crate::{
    CompletionScmCaptureAdapterNeutralPlanRecord, CompletionScmCapturePlanStatus,
    CompletionScmCapturePreparationCandidatesRecord,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompletionScmCapturePreparationDiagnosticsInput {
    pub candidates: CompletionScmCapturePreparationCandidatesRecord,
    pub plan: CompletionScmCaptureAdapterNeutralPlanRecord,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CompletionScmCapturePreparationDiagnosticsRecord {
    pub diagnostics_id: String,
    pub candidate_count: usize,
    pub skipped_admission_count: usize,
    pub plan_count: usize,
    pub ready_plan_count: usize,
    pub unsupported_plan_count: usize,
    pub repair_required_plan_count: usize,
    pub blocker_count: usize,
    pub scm_capture_authority_granted: bool,
    pub scm_publish_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub raw_material_exposed: bool,
}

pub fn completion_scm_capture_preparation_diagnostics(
    input: CompletionScmCapturePreparationDiagnosticsInput,
) -> CompletionScmCapturePreparationDiagnosticsRecord {
    let ready_plan_count = input
        .plan
        .plans
        .iter()
        .filter(|plan| plan.status == CompletionScmCapturePlanStatus::Ready)
        .count();
    let unsupported_plan_count = input
        .plan
        .plans
        .iter()
        .filter(|plan| plan.status == CompletionScmCapturePlanStatus::Unsupported)
        .count();
    let repair_required_plan_count = input
        .plan
        .plans
        .iter()
        .filter(|plan| plan.status == CompletionScmCapturePlanStatus::RepairRequired)
        .count();
    let blocker_count = input
        .plan
        .plans
        .iter()
        .map(|plan| plan.blockers.len())
        .sum();

    CompletionScmCapturePreparationDiagnosticsRecord {
        diagnostics_id: "completion-scm-capture-preparation-diagnostics".to_owned(),
        candidate_count: input.candidates.candidates.len(),
        skipped_admission_count: input.candidates.skipped_admission_ids.len()
            + input.plan.skipped_admission_ids.len(),
        plan_count: input.plan.plans.len(),
        ready_plan_count,
        unsupported_plan_count,
        repair_required_plan_count,
        blocker_count,
        scm_capture_authority_granted: false,
        scm_publish_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        raw_material_exposed: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_scm_capture_preparation_diagnostics_summarize_preparation_state() {
        let diagnostics = completion_scm_capture_preparation_diagnostics(input());

        assert_eq!(diagnostics.candidate_count, 2);
        assert_eq!(diagnostics.skipped_admission_count, 2);
        assert_eq!(diagnostics.plan_count, 2);
        assert_eq!(diagnostics.ready_plan_count, 1);
        assert_eq!(diagnostics.unsupported_plan_count, 1);
        assert_eq!(diagnostics.blocker_count, 1);
        assert!(!diagnostics.scm_capture_authority_granted);
        assert!(!diagnostics.raw_material_exposed);
    }

    fn input() -> CompletionScmCapturePreparationDiagnosticsInput {
        CompletionScmCapturePreparationDiagnosticsInput {
            candidates: crate::CompletionScmCapturePreparationCandidatesRecord {
                projection_id: "candidates".to_owned(),
                candidates: vec![candidate("1"), candidate("2")],
                skipped_admission_ids: vec!["admission:skipped".to_owned()],
                scm_capture_authority_granted: false,
                scm_publish_authority_granted: false,
                forge_authority_granted: false,
                provider_authority_granted: false,
                raw_material_exposed: false,
            },
            plan: crate::CompletionScmCaptureAdapterNeutralPlanRecord {
                plan_id: "plan".to_owned(),
                plans: vec![
                    plan("1", CompletionScmCapturePlanStatus::Ready, Vec::new()),
                    plan(
                        "2",
                        CompletionScmCapturePlanStatus::Unsupported,
                        vec![crate::CompletionScmCapturePlanBlocker::CaptureUnsupported],
                    ),
                ],
                skipped_admission_ids: vec!["admission:plan-skipped".to_owned()],
                adapter_label: "adapter".to_owned(),
                workflow_label: "workflow".to_owned(),
                scm_capture_authority_granted: false,
                scm_publish_authority_granted: false,
                forge_authority_granted: false,
                provider_authority_granted: false,
                raw_material_exposed: false,
            },
        }
    }

    fn candidate(id: &str) -> crate::CompletionScmCapturePreparationCandidate {
        crate::CompletionScmCapturePreparationCandidate {
            preparation_candidate_id: format!("prep:{id}"),
            persisted_admission_id: format!("persisted:{id}"),
            admission_id: format!("admission:{id}"),
            readiness_id: format!("readiness:{id}"),
            candidate_id: format!("candidate:{id}"),
            task_id: "task:1".to_owned(),
            work_item_id: Some(format!("work:{id}")),
            completion_id: Some(format!("completion:{id}")),
            operator_ref: "operator:tom".to_owned(),
            evidence_refs: vec!["evidence:prep".to_owned()],
        }
    }

    fn plan(
        id: &str,
        status: CompletionScmCapturePlanStatus,
        blockers: Vec<crate::CompletionScmCapturePlanBlocker>,
    ) -> crate::CompletionScmCapturePlanItem {
        crate::CompletionScmCapturePlanItem {
            plan_item_id: format!("plan:{id}"),
            preparation_candidate_id: format!("prep:{id}"),
            task_id: "task:1".to_owned(),
            work_item_id: Some(format!("work:{id}")),
            completion_id: Some(format!("completion:{id}")),
            adapter_label: "adapter".to_owned(),
            workflow_label: "workflow".to_owned(),
            status,
            blockers,
        }
    }
}
