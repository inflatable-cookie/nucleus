use super::types::CompletionScmCaptureAdmissionPersistenceRecord;
use crate::{
    CompletionScmCaptureAdmissionDiagnosticsInput, CompletionScmCaptureAdmissionRecord,
    CompletionScmCaptureAdmissionStatus,
};

pub fn completion_scm_capture_diagnostics_from_persisted_admissions(
    records: Vec<CompletionScmCaptureAdmissionPersistenceRecord>,
) -> crate::CompletionScmCaptureAdmissionDiagnosticsRecord {
    let admissions = records.into_iter().map(admission_from_record).collect();
    crate::completion_scm_capture_admission_diagnostics(
        CompletionScmCaptureAdmissionDiagnosticsInput { admissions },
    )
}

fn admission_from_record(
    record: CompletionScmCaptureAdmissionPersistenceRecord,
) -> CompletionScmCaptureAdmissionRecord {
    CompletionScmCaptureAdmissionRecord {
        admission_id: record.admission_id,
        request_id: record.request_id,
        readiness_id: record.readiness_id,
        candidate_id: record.candidate_id,
        task_id: record.task_id,
        work_item_id: record.work_item_id,
        completion_id: record.completion_id,
        operator_ref: record.operator_ref,
        evidence_refs: record.evidence_refs,
        status: record.admission_status.clone(),
        blockers: record.admission_blockers,
        capture_admitted: record.admission_status == CompletionScmCaptureAdmissionStatus::Admitted,
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
