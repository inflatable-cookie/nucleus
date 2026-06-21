use crate::{CompletionScmCapturePlanStatus, CompletionScmCapturePreparationDiagnosticsRecord};

use super::types::CompletionScmCapturePreparationPersistenceRecord;

pub fn completion_scm_capture_preparation_diagnostics_from_persisted_records(
    records: Vec<CompletionScmCapturePreparationPersistenceRecord>,
) -> CompletionScmCapturePreparationDiagnosticsRecord {
    let plan_count = records.len();
    let ready_plan_count = records
        .iter()
        .filter(|record| record.plan_status == CompletionScmCapturePlanStatus::Ready)
        .count();
    let unsupported_plan_count = records
        .iter()
        .filter(|record| record.plan_status == CompletionScmCapturePlanStatus::Unsupported)
        .count();
    let repair_required_plan_count = records
        .iter()
        .filter(|record| record.plan_status == CompletionScmCapturePlanStatus::RepairRequired)
        .count();
    let blocker_count = records
        .iter()
        .map(|record| record.plan_blockers.len() + record.blockers.len())
        .sum();

    CompletionScmCapturePreparationDiagnosticsRecord {
        diagnostics_id: "completion-scm-capture-preparation-diagnostics-from-persistence"
            .to_owned(),
        candidate_count: records.len(),
        skipped_admission_count: 0,
        plan_count,
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
