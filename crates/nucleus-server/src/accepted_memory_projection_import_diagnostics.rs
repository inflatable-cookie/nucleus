//! Read-only accepted-memory projection import diagnostics.
//!
//! Diagnostics compose projected-memory import candidates, stopped admission,
//! and conflict staging without reading or writing files, applying active
//! memory, calling SCM/forge providers, running embeddings, syncing provider
//! memory, mutating tasks, or exposing raw provider/runtime payloads.

use nucleus_memory::{AcceptedMemoryStorageRecord, MemoryProposalStorageScope};
use nucleus_projects::ProjectId;

use crate::accepted_memory_projection_export_plan::accepted_memory_projection_file_ref;
use crate::accepted_memory_projection_import_admission::{
    accepted_memory_projection_import_admissions, AcceptedMemoryProjectionImportAdmissionRecord,
    AcceptedMemoryProjectionImportAdmissionSet, AcceptedMemoryProjectionImportCandidateRecord,
    AcceptedMemoryProjectionImportInput,
};
use crate::accepted_memory_projection_import_conflicts::{
    accepted_memory_projection_import_conflicts, AcceptedMemoryProjectionImportConflictRecord,
    AcceptedMemoryProjectionImportConflictSet,
};
use crate::accepted_memory_projection_payload::{
    encode_accepted_memory_projection_payload, AcceptedMemoryProjectionPayload,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionImportDiagnostics {
    pub project_id: ProjectId,
    pub candidates: Vec<AcceptedMemoryProjectionImportCandidateRecord>,
    pub admissions: Vec<AcceptedMemoryProjectionImportAdmissionRecord>,
    pub conflicts: Vec<AcceptedMemoryProjectionImportConflictRecord>,
    pub counts: AcceptedMemoryProjectionImportDiagnosticCounts,
    pub projected_file_read_performed: bool,
    pub active_memory_apply_performed: bool,
    pub scm_effect_performed: bool,
    pub embedding_available: bool,
    pub provider_sync_available: bool,
    pub task_mutation_performed: bool,
    pub ui_effect_performed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionImportDiagnosticCounts {
    pub source_records: usize,
    pub accepted_records: usize,
    pub out_of_scope_accepted_records: usize,
    pub skipped_records: usize,
    pub skipped_proposal_records: usize,
    pub skipped_unsupported_records: usize,
    pub skipped_decode_errors: usize,
    pub skipped_encode_errors: usize,
    pub input_files: usize,
    pub candidates: usize,
    pub ready_candidates: usize,
    pub blocked_candidates: usize,
    pub admitted_imports: usize,
    pub blocked_imports: usize,
    pub no_conflicts: usize,
    pub duplicate_noops: usize,
    pub semantic_conflicts: usize,
    pub policy_conflicts: usize,
    pub blocked_conflicts: usize,
    pub candidate_blockers: usize,
    pub admission_blockers: usize,
    pub conflict_blockers: usize,
    pub file_refs: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryProjectionImportDiagnosticRecord {
    Accepted(AcceptedMemoryStorageRecord),
    ProposalRecordSkipped { record_id: String },
    UnsupportedRecordSkipped { record_id: String },
    DecodeFailedSkipped { record_id: String },
}

impl AcceptedMemoryProjectionImportDiagnostics {
    pub fn from_records(
        project_id: ProjectId,
        records: impl IntoIterator<Item = AcceptedMemoryProjectionImportDiagnosticRecord>,
    ) -> Self {
        let mut counts = AcceptedMemoryProjectionImportDiagnosticCounts::empty();
        let mut active_records = Vec::new();
        let mut inputs = Vec::new();

        for record in records {
            counts.source_records += 1;
            match record {
                AcceptedMemoryProjectionImportDiagnosticRecord::Accepted(record) => {
                    counts.accepted_records += 1;
                    if accepted_record_belongs_to_project(&record, &project_id) {
                        match projection_input_from_record(&record) {
                            Ok(input) => {
                                inputs.push(input);
                                active_records.push(record);
                            }
                            Err(ProjectionInputError::UnsupportedRecord) => {
                                counts.skipped_records += 1;
                                counts.skipped_unsupported_records += 1;
                            }
                            Err(ProjectionInputError::EncodeFailed) => {
                                counts.skipped_records += 1;
                                counts.skipped_encode_errors += 1;
                            }
                        }
                    } else {
                        counts.out_of_scope_accepted_records += 1;
                    }
                }
                AcceptedMemoryProjectionImportDiagnosticRecord::ProposalRecordSkipped {
                    ..
                } => {
                    counts.skipped_records += 1;
                    counts.skipped_proposal_records += 1;
                }
                AcceptedMemoryProjectionImportDiagnosticRecord::UnsupportedRecordSkipped {
                    ..
                } => {
                    counts.skipped_records += 1;
                    counts.skipped_unsupported_records += 1;
                }
                AcceptedMemoryProjectionImportDiagnosticRecord::DecodeFailedSkipped { .. } => {
                    counts.skipped_records += 1;
                    counts.skipped_decode_errors += 1;
                }
            }
        }

        let admission_set =
            accepted_memory_projection_import_admissions(project_id.clone(), inputs);
        let conflict_set =
            accepted_memory_projection_import_conflicts(&admission_set.admissions, &active_records);
        counts.add_import_state(&admission_set, &conflict_set);

        Self {
            project_id,
            candidates: admission_set.candidates,
            admissions: admission_set.admissions,
            conflicts: conflict_set.conflicts,
            counts,
            projected_file_read_performed: false,
            active_memory_apply_performed: false,
            scm_effect_performed: false,
            embedding_available: false,
            provider_sync_available: false,
            task_mutation_performed: false,
            ui_effect_performed: false,
        }
    }
}

impl AcceptedMemoryProjectionImportDiagnosticCounts {
    fn empty() -> Self {
        Self {
            source_records: 0,
            accepted_records: 0,
            out_of_scope_accepted_records: 0,
            skipped_records: 0,
            skipped_proposal_records: 0,
            skipped_unsupported_records: 0,
            skipped_decode_errors: 0,
            skipped_encode_errors: 0,
            input_files: 0,
            candidates: 0,
            ready_candidates: 0,
            blocked_candidates: 0,
            admitted_imports: 0,
            blocked_imports: 0,
            no_conflicts: 0,
            duplicate_noops: 0,
            semantic_conflicts: 0,
            policy_conflicts: 0,
            blocked_conflicts: 0,
            candidate_blockers: 0,
            admission_blockers: 0,
            conflict_blockers: 0,
            file_refs: 0,
        }
    }

    fn add_import_state(
        &mut self,
        admission_set: &AcceptedMemoryProjectionImportAdmissionSet,
        conflict_set: &AcceptedMemoryProjectionImportConflictSet,
    ) {
        self.input_files = admission_set.counts.inputs;
        self.candidates = admission_set.candidates.len();
        self.ready_candidates = admission_set.counts.ready_candidates;
        self.blocked_candidates = admission_set.counts.blocked_candidates;
        self.admitted_imports = admission_set.counts.admitted_imports;
        self.blocked_imports = admission_set.counts.blocked_imports;
        self.candidate_blockers = admission_set
            .candidates
            .iter()
            .map(|candidate| candidate.blockers.len())
            .sum();
        self.admission_blockers = admission_set.counts.admission_blockers;
        self.file_refs = admission_set
            .candidates
            .iter()
            .filter(|candidate| !candidate.file_ref.trim().is_empty())
            .count();
        self.no_conflicts = conflict_set.counts.no_conflicts;
        self.duplicate_noops = conflict_set.counts.duplicate_noops;
        self.semantic_conflicts = conflict_set.counts.semantic_conflicts;
        self.policy_conflicts = conflict_set.counts.policy_conflicts;
        self.blocked_conflicts = conflict_set.counts.blocked;
        self.conflict_blockers = conflict_set.counts.blockers;
    }
}

enum ProjectionInputError {
    UnsupportedRecord,
    EncodeFailed,
}

fn projection_input_from_record(
    record: &AcceptedMemoryStorageRecord,
) -> Result<AcceptedMemoryProjectionImportInput, ProjectionInputError> {
    let payload = AcceptedMemoryProjectionPayload::from_accepted_memory_record(record)
        .map_err(|_| ProjectionInputError::UnsupportedRecord)?;
    let file_ref = accepted_memory_projection_file_ref(&payload.memory_id)
        .map_err(|_| ProjectionInputError::UnsupportedRecord)?;
    let bytes = encode_accepted_memory_projection_payload(&payload)
        .map_err(|_| ProjectionInputError::EncodeFailed)?;

    Ok(AcceptedMemoryProjectionImportInput { file_ref, bytes })
}

fn accepted_record_belongs_to_project(
    record: &AcceptedMemoryStorageRecord,
    project_id: &ProjectId,
) -> bool {
    matches!(
        &record.scope,
        MemoryProposalStorageScope::Project { project_ref } if project_ref == &project_id.0
    )
}
