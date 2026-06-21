use super::types::ScmCaptureDryRunPersistenceRecord;
use crate::ScmCaptureDryRunPlanStatus;

pub fn scm_capture_dry_run_diagnostics_from_persisted_records(
    records: Vec<ScmCaptureDryRunPersistenceRecord>,
) -> crate::ScmCaptureDryRunDiagnosticsRecord {
    let plan_count = records.len();
    let ready_plan_count = records
        .iter()
        .filter(|record| record.plan_status == ScmCaptureDryRunPlanStatus::Ready)
        .count();
    let unsupported_plan_count = records
        .iter()
        .filter(|record| record.plan_status == ScmCaptureDryRunPlanStatus::Unsupported)
        .count();
    let repair_required_plan_count = records
        .iter()
        .filter(|record| record.plan_status == ScmCaptureDryRunPlanStatus::RepairRequired)
        .count();
    let blocker_count = records
        .iter()
        .map(|record| record.plan_blockers.len() + record.blockers.len())
        .sum();

    crate::ScmCaptureDryRunDiagnosticsRecord {
        diagnostics_id: "scm-capture-dry-run-diagnostics-from-persistence".to_owned(),
        candidate_count: records.len(),
        skipped_preparation_count: 0,
        plan_count,
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
