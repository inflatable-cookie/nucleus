//! Admission records for SCM capture dry-run execution eligibility.

use serde::{Deserialize, Serialize};

use crate::{
    ScmCaptureDryRunPersistenceRecord, ScmCaptureDryRunPersistenceStatus,
    ScmCaptureDryRunPlanStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmCaptureDryRunExecutionAdmissionInput {
    pub records: Vec<ScmCaptureDryRunPersistenceRecord>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmCaptureDryRunExecutionAdmissionSet {
    pub admission_set_id: String,
    pub admissions: Vec<ScmCaptureDryRunExecutionAdmissionRecord>,
    pub skipped_dry_run_plan_ids: Vec<String>,
    pub scm_dry_run_executed: bool,
    pub scm_capture_executed: bool,
    pub scm_publish_executed: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub raw_material_exposed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmCaptureDryRunExecutionAdmissionRecord {
    pub admission_id: String,
    pub persisted_dry_run_plan_id: String,
    pub dry_run_plan_item_id: String,
    pub dry_run_candidate_id: String,
    pub persisted_preparation_id: String,
    pub task_id: String,
    pub work_item_id: Option<String>,
    pub completion_id: Option<String>,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub adapter_label: String,
    pub workflow_label: String,
    pub status: ScmCaptureDryRunExecutionAdmissionStatus,
    pub blockers: Vec<ScmCaptureDryRunExecutionAdmissionBlocker>,
    pub dry_run_execution_admitted: bool,
    pub scm_dry_run_executed: bool,
    pub scm_capture_executed: bool,
    pub scm_publish_executed: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub raw_material_exposed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmCaptureDryRunExecutionAdmissionStatus {
    Admitted,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmCaptureDryRunExecutionAdmissionBlocker {
    DryRunPlanNotPersisted,
    PlanUnsupported,
    PlanRepairRequired,
    PlanBlockersPresent,
    PersistenceBlockersPresent,
    DryRunAlreadyPermitted,
    CaptureAuthorityPresent,
    PublishAuthorityPresent,
    ForgeAuthorityPresent,
    ProviderAuthorityPresent,
    CallbackAuthorityPresent,
    InterruptionAuthorityPresent,
    RecoveryAuthorityPresent,
    RawMaterialRetained,
}

pub fn scm_capture_dry_run_execution_admission(
    input: ScmCaptureDryRunExecutionAdmissionInput,
) -> ScmCaptureDryRunExecutionAdmissionSet {
    let mut admissions = Vec::new();
    let mut skipped_dry_run_plan_ids = Vec::new();

    for record in input.records {
        let blockers = blockers(&record);
        if blockers.is_empty() {
            admissions.push(admission(record, blockers));
        } else {
            skipped_dry_run_plan_ids.push(record.persisted_dry_run_plan_id.clone());
            admissions.push(admission(record, blockers));
        }
    }

    admissions.sort_by(|left, right| left.admission_id.cmp(&right.admission_id));
    skipped_dry_run_plan_ids.sort();
    skipped_dry_run_plan_ids.dedup();

    ScmCaptureDryRunExecutionAdmissionSet {
        admission_set_id: "scm-capture-dry-run-execution-admissions".to_owned(),
        admissions,
        skipped_dry_run_plan_ids,
        scm_dry_run_executed: false,
        scm_capture_executed: false,
        scm_publish_executed: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        raw_material_exposed: false,
    }
}

fn blockers(
    record: &ScmCaptureDryRunPersistenceRecord,
) -> Vec<ScmCaptureDryRunExecutionAdmissionBlocker> {
    let mut blockers = Vec::new();
    if record.status != ScmCaptureDryRunPersistenceStatus::Persisted {
        blockers.push(ScmCaptureDryRunExecutionAdmissionBlocker::DryRunPlanNotPersisted);
    }
    match record.plan_status {
        ScmCaptureDryRunPlanStatus::Ready => {}
        ScmCaptureDryRunPlanStatus::Unsupported => {
            blockers.push(ScmCaptureDryRunExecutionAdmissionBlocker::PlanUnsupported);
        }
        ScmCaptureDryRunPlanStatus::RepairRequired => {
            blockers.push(ScmCaptureDryRunExecutionAdmissionBlocker::PlanRepairRequired);
        }
    }
    if !record.plan_blockers.is_empty() {
        blockers.push(ScmCaptureDryRunExecutionAdmissionBlocker::PlanBlockersPresent);
    }
    if !record.blockers.is_empty() {
        blockers.push(ScmCaptureDryRunExecutionAdmissionBlocker::PersistenceBlockersPresent);
    }
    if record.scm_dry_run_permitted {
        blockers.push(ScmCaptureDryRunExecutionAdmissionBlocker::DryRunAlreadyPermitted);
    }
    if record.scm_capture_permitted {
        blockers.push(ScmCaptureDryRunExecutionAdmissionBlocker::CaptureAuthorityPresent);
    }
    if record.scm_publish_permitted {
        blockers.push(ScmCaptureDryRunExecutionAdmissionBlocker::PublishAuthorityPresent);
    }
    if record.forge_change_request_permitted || record.forge_merge_permitted {
        blockers.push(ScmCaptureDryRunExecutionAdmissionBlocker::ForgeAuthorityPresent);
    }
    if record.provider_write_permitted {
        blockers.push(ScmCaptureDryRunExecutionAdmissionBlocker::ProviderAuthorityPresent);
    }
    if record.callback_response_permitted {
        blockers.push(ScmCaptureDryRunExecutionAdmissionBlocker::CallbackAuthorityPresent);
    }
    if record.interruption_permitted {
        blockers.push(ScmCaptureDryRunExecutionAdmissionBlocker::InterruptionAuthorityPresent);
    }
    if record.recovery_permitted {
        blockers.push(ScmCaptureDryRunExecutionAdmissionBlocker::RecoveryAuthorityPresent);
    }
    if record.raw_material_retained {
        blockers.push(ScmCaptureDryRunExecutionAdmissionBlocker::RawMaterialRetained);
    }
    blockers
}

fn admission(
    record: ScmCaptureDryRunPersistenceRecord,
    blockers: Vec<ScmCaptureDryRunExecutionAdmissionBlocker>,
) -> ScmCaptureDryRunExecutionAdmissionRecord {
    let status = if blockers.is_empty() {
        ScmCaptureDryRunExecutionAdmissionStatus::Admitted
    } else {
        ScmCaptureDryRunExecutionAdmissionStatus::Blocked
    };
    let dry_run_execution_admitted = status == ScmCaptureDryRunExecutionAdmissionStatus::Admitted;

    ScmCaptureDryRunExecutionAdmissionRecord {
        admission_id: format!(
            "scm-capture-dry-run-execution-admission:{}",
            record.persisted_dry_run_plan_id
        ),
        persisted_dry_run_plan_id: record.persisted_dry_run_plan_id,
        dry_run_plan_item_id: record.dry_run_plan_item_id,
        dry_run_candidate_id: record.dry_run_candidate_id,
        persisted_preparation_id: record.persisted_preparation_id,
        task_id: record.task_id,
        work_item_id: record.work_item_id,
        completion_id: record.completion_id,
        operator_ref: record.operator_ref,
        evidence_refs: record.evidence_refs,
        adapter_label: record.adapter_label,
        workflow_label: record.workflow_label,
        status,
        blockers,
        dry_run_execution_admitted,
        scm_dry_run_executed: false,
        scm_capture_executed: false,
        scm_publish_executed: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        raw_material_exposed: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scm_capture_dry_run_execution_admission_admits_ready_records() {
        let set =
            scm_capture_dry_run_execution_admission(ScmCaptureDryRunExecutionAdmissionInput {
                records: vec![record("ready", ScmCaptureDryRunPlanStatus::Ready)],
            });

        assert_eq!(set.admissions.len(), 1);
        assert_eq!(
            set.admissions[0].status,
            ScmCaptureDryRunExecutionAdmissionStatus::Admitted
        );
        assert!(set.admissions[0].dry_run_execution_admitted);
        assert!(!set.scm_dry_run_executed);
        assert!(!set.scm_capture_executed);
        assert!(!set.raw_material_exposed);
    }

    #[test]
    fn scm_capture_dry_run_execution_admission_blocks_non_ready_records() {
        let mut effectful = record("effectful", ScmCaptureDryRunPlanStatus::Ready);
        effectful.scm_capture_permitted = true;
        let set =
            scm_capture_dry_run_execution_admission(ScmCaptureDryRunExecutionAdmissionInput {
                records: vec![
                    record("unsupported", ScmCaptureDryRunPlanStatus::Unsupported),
                    record("repair", ScmCaptureDryRunPlanStatus::RepairRequired),
                    blocked_record("blocked"),
                    effectful,
                ],
            });

        assert_eq!(set.admissions.len(), 4);
        assert_eq!(set.skipped_dry_run_plan_ids.len(), 4);
        assert!(
            set.admissions
                .iter()
                .all(|admission| admission.status
                    == ScmCaptureDryRunExecutionAdmissionStatus::Blocked)
        );
        assert!(set.admissions.iter().any(|admission| admission
            .blockers
            .contains(&ScmCaptureDryRunExecutionAdmissionBlocker::CaptureAuthorityPresent)));
        assert!(!set.scm_capture_executed);
    }

    fn blocked_record(id: &str) -> ScmCaptureDryRunPersistenceRecord {
        ScmCaptureDryRunPersistenceRecord {
            status: ScmCaptureDryRunPersistenceStatus::Blocked,
            blockers: vec![crate::ScmCaptureDryRunPersistenceBlocker::ScmDryRunRequested],
            ..record(id, ScmCaptureDryRunPlanStatus::Ready)
        }
    }

    fn record(
        id: &str,
        plan_status: ScmCaptureDryRunPlanStatus,
    ) -> ScmCaptureDryRunPersistenceRecord {
        ScmCaptureDryRunPersistenceRecord {
            persisted_dry_run_plan_id: format!("persisted:{id}"),
            dry_run_plan_item_id: format!("dry-run-plan:{id}"),
            dry_run_candidate_id: format!("dry-run-candidate:{id}"),
            persisted_preparation_id: format!("persisted-preparation:{id}"),
            plan_item_id: format!("plan:{id}"),
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
                ScmCaptureDryRunPlanStatus::Ready => Vec::new(),
                ScmCaptureDryRunPlanStatus::Unsupported => {
                    vec![crate::ScmCaptureDryRunPlanBlocker::DryRunUnsupported]
                }
                ScmCaptureDryRunPlanStatus::RepairRequired => {
                    vec![crate::ScmCaptureDryRunPlanBlocker::AdapterUnavailable]
                }
            },
            plan_status,
            status: ScmCaptureDryRunPersistenceStatus::Persisted,
            blockers: Vec::new(),
            duplicate_dry_run_plan_detected: false,
            scm_dry_run_permitted: false,
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
