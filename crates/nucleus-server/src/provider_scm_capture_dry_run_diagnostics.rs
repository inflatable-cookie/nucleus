//! Read-only diagnostics for SCM capture dry-run planning.

use serde::{Deserialize, Serialize};

use crate::{
    ScmCaptureDryRunAdapterCapabilitiesRecord, ScmCaptureDryRunPlanCandidatesRecord,
    ScmCaptureDryRunPlanStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmCaptureDryRunDiagnosticsInput {
    pub candidates: ScmCaptureDryRunPlanCandidatesRecord,
    pub plan: ScmCaptureDryRunAdapterCapabilitiesRecord,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmCaptureDryRunDiagnosticsRecord {
    pub diagnostics_id: String,
    pub candidate_count: usize,
    pub skipped_preparation_count: usize,
    pub plan_count: usize,
    pub ready_plan_count: usize,
    pub unsupported_plan_count: usize,
    pub repair_required_plan_count: usize,
    pub blocker_count: usize,
    pub scm_dry_run_authority_granted: bool,
    pub scm_capture_authority_granted: bool,
    pub scm_publish_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub raw_material_exposed: bool,
}

pub fn scm_capture_dry_run_diagnostics(
    input: ScmCaptureDryRunDiagnosticsInput,
) -> ScmCaptureDryRunDiagnosticsRecord {
    let ready_plan_count = input
        .plan
        .plans
        .iter()
        .filter(|plan| plan.status == ScmCaptureDryRunPlanStatus::Ready)
        .count();
    let unsupported_plan_count = input
        .plan
        .plans
        .iter()
        .filter(|plan| plan.status == ScmCaptureDryRunPlanStatus::Unsupported)
        .count();
    let repair_required_plan_count = input
        .plan
        .plans
        .iter()
        .filter(|plan| plan.status == ScmCaptureDryRunPlanStatus::RepairRequired)
        .count();
    let blocker_count = input
        .plan
        .plans
        .iter()
        .map(|plan| plan.blockers.len())
        .sum();

    ScmCaptureDryRunDiagnosticsRecord {
        diagnostics_id: "scm-capture-dry-run-diagnostics".to_owned(),
        candidate_count: input.candidates.candidates.len(),
        skipped_preparation_count: input.candidates.skipped_preparation_ids.len()
            + input.plan.skipped_preparation_ids.len(),
        plan_count: input.plan.plans.len(),
        ready_plan_count,
        unsupported_plan_count,
        repair_required_plan_count,
        blocker_count,
        scm_dry_run_authority_granted: false,
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
    fn scm_capture_dry_run_diagnostics_summarize_planning_state() {
        let diagnostics = scm_capture_dry_run_diagnostics(input());

        assert_eq!(diagnostics.candidate_count, 2);
        assert_eq!(diagnostics.skipped_preparation_count, 2);
        assert_eq!(diagnostics.plan_count, 2);
        assert_eq!(diagnostics.ready_plan_count, 1);
        assert_eq!(diagnostics.unsupported_plan_count, 1);
        assert_eq!(diagnostics.repair_required_plan_count, 0);
        assert_eq!(diagnostics.blocker_count, 1);
        assert!(!diagnostics.scm_dry_run_authority_granted);
        assert!(!diagnostics.raw_material_exposed);
    }

    fn input() -> ScmCaptureDryRunDiagnosticsInput {
        ScmCaptureDryRunDiagnosticsInput {
            candidates: crate::ScmCaptureDryRunPlanCandidatesRecord {
                projection_id: "candidates".to_owned(),
                candidates: vec![candidate("1"), candidate("2")],
                skipped_preparation_ids: vec!["prep:skipped".to_owned()],
                scm_dry_run_authority_granted: false,
                scm_capture_authority_granted: false,
                scm_publish_authority_granted: false,
                forge_authority_granted: false,
                provider_authority_granted: false,
                raw_material_exposed: false,
            },
            plan: crate::ScmCaptureDryRunAdapterCapabilitiesRecord {
                plan_id: "plan".to_owned(),
                plans: vec![
                    plan("1", ScmCaptureDryRunPlanStatus::Ready, Vec::new()),
                    plan(
                        "2",
                        ScmCaptureDryRunPlanStatus::Unsupported,
                        vec![crate::ScmCaptureDryRunPlanBlocker::DryRunUnsupported],
                    ),
                ],
                skipped_preparation_ids: vec!["prep:plan-skipped".to_owned()],
                adapter_label: "adapter".to_owned(),
                workflow_label: "workflow".to_owned(),
                scm_dry_run_authority_granted: false,
                scm_capture_authority_granted: false,
                scm_publish_authority_granted: false,
                forge_authority_granted: false,
                provider_authority_granted: false,
                raw_material_exposed: false,
            },
        }
    }

    fn candidate(id: &str) -> crate::ScmCaptureDryRunPlanCandidate {
        crate::ScmCaptureDryRunPlanCandidate {
            dry_run_candidate_id: format!("candidate:{id}"),
            persisted_preparation_id: format!("persisted:{id}"),
            plan_item_id: format!("plan:{id}"),
            admission_id: format!("admission:{id}"),
            readiness_id: format!("readiness:{id}"),
            capture_candidate_id: format!("capture:{id}"),
            task_id: "task:1".to_owned(),
            work_item_id: Some(format!("work:{id}")),
            completion_id: Some(format!("completion:{id}")),
            operator_ref: "operator:tom".to_owned(),
            evidence_refs: vec!["evidence:dry-run".to_owned()],
            adapter_label: "adapter".to_owned(),
            workflow_label: "workflow".to_owned(),
        }
    }

    fn plan(
        id: &str,
        status: ScmCaptureDryRunPlanStatus,
        blockers: Vec<crate::ScmCaptureDryRunPlanBlocker>,
    ) -> crate::ScmCaptureDryRunPlanItem {
        crate::ScmCaptureDryRunPlanItem {
            dry_run_plan_item_id: format!("dry-run-plan:{id}"),
            dry_run_candidate_id: format!("candidate:{id}"),
            persisted_preparation_id: format!("persisted:{id}"),
            plan_item_id: format!("plan:{id}"),
            admission_id: format!("admission:{id}"),
            readiness_id: format!("readiness:{id}"),
            capture_candidate_id: format!("capture:{id}"),
            task_id: "task:1".to_owned(),
            work_item_id: Some(format!("work:{id}")),
            completion_id: Some(format!("completion:{id}")),
            operator_ref: "operator:tom".to_owned(),
            evidence_refs: vec!["evidence:dry-run".to_owned()],
            adapter_label: "adapter".to_owned(),
            workflow_label: "workflow".to_owned(),
            status,
            blockers,
        }
    }
}
