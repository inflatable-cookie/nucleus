use crate::accepted_memory_projection_import_apply_admission::blockers::{
    apply_admission_blockers, sorted_unique_non_empty,
};
use crate::accepted_memory_projection_import_apply_admission::refs::accepted_memory_projection_import_apply_admission_ref;
use crate::accepted_memory_projection_import_apply_admission::types::{
    AcceptedMemoryProjectionImportApplyAdmissionBlocker,
    AcceptedMemoryProjectionImportApplyAdmissionInput,
    AcceptedMemoryProjectionImportApplyAdmissionRecord,
    AcceptedMemoryProjectionImportApplyAdmissionStatus,
};
use crate::accepted_memory_projection_import_conflicts::AcceptedMemoryProjectionImportConflictStatus;

pub(super) fn apply_admission_record(
    input: AcceptedMemoryProjectionImportApplyAdmissionInput,
) -> AcceptedMemoryProjectionImportApplyAdmissionRecord {
    let blockers = apply_admission_blockers(&input);
    let status = apply_admission_status(&input.conflict.status, &blockers);

    AcceptedMemoryProjectionImportApplyAdmissionRecord {
        apply_admission_ref: accepted_memory_projection_import_apply_admission_ref(
            &input.request_id,
        ),
        request_id: input.request_id,
        import_admission_ref: input.conflict.admission_ref,
        conflict_ref: input.conflict.conflict_ref,
        candidate_ref: input.conflict.candidate_ref,
        memory_id: input.conflict.memory_id,
        file_ref: input.conflict.file_ref,
        operator_ref: input.operator_ref,
        approval_ref: input.approval_ref,
        provenance_refs: sorted_unique_non_empty(input.provenance_refs),
        evidence_refs: sorted_unique_non_empty(input.evidence_refs),
        status,
        blockers,
        active_memory_apply_performed: false,
        projection_write_performed: false,
        scm_effect_performed: false,
        embedding_available: false,
        provider_sync_available: false,
        automatic_extraction_performed: false,
        task_mutation_performed: false,
        agent_scheduling_performed: false,
        ui_effect_performed: false,
    }
}

fn apply_admission_status(
    conflict_status: &AcceptedMemoryProjectionImportConflictStatus,
    blockers: &[AcceptedMemoryProjectionImportApplyAdmissionBlocker],
) -> AcceptedMemoryProjectionImportApplyAdmissionStatus {
    if blockers.is_empty() {
        return AcceptedMemoryProjectionImportApplyAdmissionStatus::Admitted;
    }
    if *conflict_status == AcceptedMemoryProjectionImportConflictStatus::DuplicateNoop
        && blockers.iter().all(|blocker| {
            *blocker == AcceptedMemoryProjectionImportApplyAdmissionBlocker::DuplicateNoop
        })
    {
        return AcceptedMemoryProjectionImportApplyAdmissionStatus::DuplicateNoop;
    }
    AcceptedMemoryProjectionImportApplyAdmissionStatus::Blocked
}
