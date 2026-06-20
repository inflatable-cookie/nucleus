//! SCM capture dry-run plan candidates derived from persisted preparation state.

use serde::{Deserialize, Serialize};

use crate::{
    CompletionScmCapturePlanStatus, CompletionScmCapturePreparationPersistenceRecord,
    CompletionScmCapturePreparationPersistenceStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmCaptureDryRunPlanCandidatesInput {
    pub preparations: Vec<CompletionScmCapturePreparationPersistenceRecord>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmCaptureDryRunPlanCandidatesRecord {
    pub projection_id: String,
    pub candidates: Vec<ScmCaptureDryRunPlanCandidate>,
    pub skipped_preparation_ids: Vec<String>,
    pub scm_dry_run_authority_granted: bool,
    pub scm_capture_authority_granted: bool,
    pub scm_publish_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub raw_material_exposed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmCaptureDryRunPlanCandidate {
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
}

pub fn scm_capture_dry_run_plan_candidates(
    input: ScmCaptureDryRunPlanCandidatesInput,
) -> ScmCaptureDryRunPlanCandidatesRecord {
    let mut candidates = Vec::new();
    let mut skipped_preparation_ids = Vec::new();

    for preparation in input.preparations {
        if is_candidate(&preparation) {
            candidates.push(candidate(preparation));
        } else {
            skipped_preparation_ids.push(preparation.persisted_preparation_id);
        }
    }

    candidates.sort_by(|left, right| left.dry_run_candidate_id.cmp(&right.dry_run_candidate_id));
    skipped_preparation_ids.sort();
    skipped_preparation_ids.dedup();

    ScmCaptureDryRunPlanCandidatesRecord {
        projection_id: "scm-capture-dry-run-plan-candidates".to_owned(),
        candidates,
        skipped_preparation_ids,
        scm_dry_run_authority_granted: false,
        scm_capture_authority_granted: false,
        scm_publish_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        raw_material_exposed: false,
    }
}

fn is_candidate(preparation: &CompletionScmCapturePreparationPersistenceRecord) -> bool {
    preparation.status == CompletionScmCapturePreparationPersistenceStatus::Persisted
        && preparation.plan_status == CompletionScmCapturePlanStatus::Ready
        && preparation.plan_blockers.is_empty()
        && preparation.blockers.is_empty()
        && !preparation.scm_capture_permitted
        && !preparation.scm_publish_permitted
        && !preparation.forge_change_request_permitted
        && !preparation.forge_merge_permitted
        && !preparation.provider_write_permitted
        && !preparation.callback_response_permitted
        && !preparation.interruption_permitted
        && !preparation.recovery_permitted
        && !preparation.raw_material_retained
}

fn candidate(
    preparation: CompletionScmCapturePreparationPersistenceRecord,
) -> ScmCaptureDryRunPlanCandidate {
    ScmCaptureDryRunPlanCandidate {
        dry_run_candidate_id: format!(
            "scm-capture-dry-run-candidate:{}",
            preparation.persisted_preparation_id
        ),
        persisted_preparation_id: preparation.persisted_preparation_id,
        plan_item_id: preparation.plan_item_id,
        admission_id: preparation.admission_id,
        readiness_id: preparation.readiness_id,
        capture_candidate_id: preparation.capture_candidate_id,
        task_id: preparation.task_id,
        work_item_id: preparation.work_item_id,
        completion_id: preparation.completion_id,
        operator_ref: preparation.operator_ref,
        evidence_refs: preparation.evidence_refs,
        adapter_label: preparation.adapter_label,
        workflow_label: preparation.workflow_label,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scm_capture_dry_run_plan_candidates_project_ready_preparations() {
        let record = scm_capture_dry_run_plan_candidates(ScmCaptureDryRunPlanCandidatesInput {
            preparations: vec![preparation("ready", CompletionScmCapturePlanStatus::Ready)],
        });

        assert_eq!(record.candidates.len(), 1);
        assert_eq!(
            record.candidates[0].dry_run_candidate_id,
            "scm-capture-dry-run-candidate:persisted:ready"
        );
        assert_eq!(record.candidates[0].adapter_label, "git");
        assert_eq!(record.candidates[0].workflow_label, "working-tree-preview");
        assert!(!record.scm_dry_run_authority_granted);
        assert!(!record.raw_material_exposed);
    }

    #[test]
    fn scm_capture_dry_run_plan_candidates_skip_non_ready_or_effectful_preparations() {
        let mut effectful = preparation("effectful", CompletionScmCapturePlanStatus::Ready);
        effectful.scm_capture_permitted = true;
        let record = scm_capture_dry_run_plan_candidates(ScmCaptureDryRunPlanCandidatesInput {
            preparations: vec![
                preparation("unsupported", CompletionScmCapturePlanStatus::Unsupported),
                preparation("repair", CompletionScmCapturePlanStatus::RepairRequired),
                blocked_preparation("blocked"),
                effectful,
            ],
        });

        assert!(record.candidates.is_empty());
        assert_eq!(
            record.skipped_preparation_ids,
            vec![
                "persisted:blocked".to_owned(),
                "persisted:effectful".to_owned(),
                "persisted:repair".to_owned(),
                "persisted:unsupported".to_owned(),
            ]
        );
        assert!(!record.scm_capture_authority_granted);
        assert!(!record.forge_authority_granted);
    }

    fn blocked_preparation(id: &str) -> CompletionScmCapturePreparationPersistenceRecord {
        CompletionScmCapturePreparationPersistenceRecord {
            status: CompletionScmCapturePreparationPersistenceStatus::Blocked,
            blockers: vec![
                crate::CompletionScmCapturePreparationPersistenceBlocker::ScmCaptureRequested,
            ],
            ..preparation(id, CompletionScmCapturePlanStatus::Ready)
        }
    }

    fn preparation(
        id: &str,
        plan_status: CompletionScmCapturePlanStatus,
    ) -> CompletionScmCapturePreparationPersistenceRecord {
        CompletionScmCapturePreparationPersistenceRecord {
            persisted_preparation_id: format!("persisted:{id}"),
            plan_item_id: format!("plan:{id}"),
            preparation_candidate_id: format!("prep:{id}"),
            admission_id: format!("admission:{id}"),
            readiness_id: format!("readiness:{id}"),
            capture_candidate_id: format!("capture:{id}"),
            task_id: "task:1".to_owned(),
            work_item_id: Some("work:1".to_owned()),
            completion_id: Some("completion:1".to_owned()),
            operator_ref: "operator:tom".to_owned(),
            evidence_refs: vec!["evidence:dry-run".to_owned()],
            adapter_label: "git".to_owned(),
            workflow_label: "working-tree-preview".to_owned(),
            plan_blockers: match plan_status {
                CompletionScmCapturePlanStatus::Ready => Vec::new(),
                CompletionScmCapturePlanStatus::Unsupported => {
                    vec![crate::CompletionScmCapturePlanBlocker::CaptureUnsupported]
                }
                CompletionScmCapturePlanStatus::RepairRequired => {
                    vec![crate::CompletionScmCapturePlanBlocker::AdapterUnavailable]
                }
            },
            plan_status,
            status: CompletionScmCapturePreparationPersistenceStatus::Persisted,
            blockers: Vec::new(),
            duplicate_preparation_detected: false,
            scm_capture_permitted: false,
            scm_publish_permitted: false,
            forge_change_request_permitted: false,
            forge_merge_permitted: false,
            provider_write_permitted: false,
            callback_response_permitted: false,
            interruption_permitted: false,
            recovery_permitted: false,
            raw_material_retained: false,
        }
    }
}
