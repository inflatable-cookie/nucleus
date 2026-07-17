//! Read-only stopped apply/admission diagnostics for accepted-memory imports.
//!
//! Diagnostics compose existing import validation and conflict staging, then
//! build stopped apply/admission records without granting operator approval or
//! active mutation authority.

use crate::provider_no_effects::{MemoryApplyNoEffects};
use nucleus_projects::ProjectId;

use crate::accepted_memory_projection_import_apply_admission::{
    accepted_memory_projection_import_apply_admissions,
    AcceptedMemoryProjectionImportApplyAdmissionInput,
    AcceptedMemoryProjectionImportApplyAdmissionRecord,
};
use crate::accepted_memory_projection_import_diagnostics::{
    AcceptedMemoryProjectionImportDiagnosticRecord, AcceptedMemoryProjectionImportDiagnostics,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionImportApplyDiagnostics {
    pub diagnostics_id: String,
    pub project_id: ProjectId,
    pub records: Vec<AcceptedMemoryProjectionImportApplyAdmissionRecord>,
    pub counts: AcceptedMemoryProjectionImportApplyDiagnosticCounts,
    pub no_effects: MemoryApplyNoEffects,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionImportApplyDiagnosticCounts {
    pub source_records: usize,
    pub import_conflicts: usize,
    pub apply_admissions: usize,
    pub admitted: usize,
    pub duplicate_noops: usize,
    pub blocked: usize,
    pub blockers: usize,
    pub missing_ref_blockers: usize,
    pub conflict_blockers: usize,
    pub raw_payload_blockers: usize,
    pub effect_blockers: usize,
    pub provenance_refs: usize,
    pub evidence_refs: usize,
}

impl AcceptedMemoryProjectionImportApplyDiagnostics {
    pub fn from_records(
        project_id: ProjectId,
        records: impl IntoIterator<Item = AcceptedMemoryProjectionImportDiagnosticRecord>,
    ) -> Self {
        let import_diagnostics =
            AcceptedMemoryProjectionImportDiagnostics::from_records(project_id.clone(), records);
        Self::from_import_diagnostics(import_diagnostics)
    }

    pub fn from_import_diagnostics(
        import_diagnostics: AcceptedMemoryProjectionImportDiagnostics,
    ) -> Self {
        let inputs: Vec<_> = import_diagnostics
            .conflicts
            .iter()
            .map(apply_input_from_import_conflict)
            .collect();
        let apply_set = accepted_memory_projection_import_apply_admissions(inputs);
        let counts = AcceptedMemoryProjectionImportApplyDiagnosticCounts::from_parts(
            &import_diagnostics,
            &apply_set,
        );

        Self {
            diagnostics_id: "accepted-memory-import-apply-diagnostics".to_owned(),
            project_id: import_diagnostics.project_id,
            records: apply_set.records,
            counts,
        no_effects: MemoryApplyNoEffects::none(),
        }
    }
}

impl AcceptedMemoryProjectionImportApplyDiagnosticCounts {
    fn from_parts(
        import_diagnostics: &AcceptedMemoryProjectionImportDiagnostics,
        apply_set: &crate::AcceptedMemoryProjectionImportApplyAdmissionSet,
    ) -> Self {
        Self {
            source_records: import_diagnostics.counts.source_records,
            import_conflicts: import_diagnostics.conflicts.len(),
            apply_admissions: apply_set.records.len(),
            admitted: apply_set.counts.admitted,
            duplicate_noops: apply_set.counts.duplicate_noops,
            blocked: apply_set.counts.blocked,
            blockers: apply_set.counts.blockers,
            missing_ref_blockers: apply_set.counts.missing_ref_blockers,
            conflict_blockers: apply_set.counts.conflict_blockers,
            raw_payload_blockers: apply_set.counts.raw_payload_blockers,
            effect_blockers: apply_set.counts.effect_blockers,
            provenance_refs: apply_set
                .records
                .iter()
                .map(|record| record.provenance_refs.len())
                .sum(),
            evidence_refs: apply_set
                .records
                .iter()
                .map(|record| record.evidence_refs.len())
                .sum(),
        }
    }
}

fn apply_input_from_import_conflict(
    conflict: &crate::AcceptedMemoryProjectionImportConflictRecord,
) -> AcceptedMemoryProjectionImportApplyAdmissionInput {
    AcceptedMemoryProjectionImportApplyAdmissionInput {
        request_id: format!(
            "accepted-memory-import-apply-diagnostic-request:{}",
            conflict.conflict_ref
        ),
        operator_ref: String::new(),
        approval_ref: String::new(),
        provenance_refs: vec![conflict.file_ref.clone()],
        evidence_refs: vec![
            conflict.candidate_ref.clone(),
            conflict.admission_ref.clone(),
        ],
        conflict: conflict.clone(),
        raw_payload_present: false,
        active_memory_mutation_requested: false,
        projection_write_requested: false,
        scm_effect_requested: false,
        embedding_requested: false,
        provider_sync_requested: false,
        automatic_extraction_requested: false,
        task_mutation_requested: false,
        agent_scheduling_requested: false,
        ui_effect_requested: false,
    }
}
