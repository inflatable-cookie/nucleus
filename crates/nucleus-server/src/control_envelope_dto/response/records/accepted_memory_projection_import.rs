use serde::{Deserialize, Serialize};

use crate::accepted_memory_projection_import_admission::{
    AcceptedMemoryProjectionImportAdmissionRecord, AcceptedMemoryProjectionImportCandidateRecord,
    AcceptedMemoryProjectionImportCandidateSummary,
};
use crate::accepted_memory_projection_import_conflicts::AcceptedMemoryProjectionImportConflictRecord;
use crate::accepted_memory_projection_import_diagnostics::{
    AcceptedMemoryProjectionImportDiagnosticCounts, AcceptedMemoryProjectionImportDiagnostics,
};

use super::accepted_memory_projection_import_blockers::{
    admission_blocker, admission_status, candidate_blocker, candidate_status, conflict_blocker,
    conflict_status,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlAcceptedMemoryProjectionImportDiagnosticsDto {
    pub project_id: String,
    pub candidates: Vec<ControlAcceptedMemoryProjectionImportCandidateDto>,
    pub admissions: Vec<ControlAcceptedMemoryProjectionImportAdmissionDto>,
    pub conflicts: Vec<ControlAcceptedMemoryProjectionImportConflictDto>,
    pub counts: ControlAcceptedMemoryProjectionImportCountsDto,
    pub projected_file_read_performed: bool,
    pub active_memory_apply_performed: bool,
    pub scm_effect_performed: bool,
    pub embedding_available: bool,
    pub provider_sync_available: bool,
    pub task_mutation_performed: bool,
    pub ui_effect_performed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlAcceptedMemoryProjectionImportCandidateDto {
    pub candidate_ref: String,
    pub memory_id: Option<String>,
    pub file_ref: String,
    pub status: String,
    pub summary: Option<ControlAcceptedMemoryProjectionImportSummaryDto>,
    pub blockers: Vec<ControlAcceptedMemoryProjectionImportBlockerDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlAcceptedMemoryProjectionImportAdmissionDto {
    pub admission_ref: String,
    pub candidate_ref: String,
    pub memory_id: Option<String>,
    pub file_ref: String,
    pub status: String,
    pub blockers: Vec<ControlAcceptedMemoryProjectionImportBlockerDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlAcceptedMemoryProjectionImportConflictDto {
    pub conflict_ref: String,
    pub admission_ref: String,
    pub candidate_ref: String,
    pub memory_id: Option<String>,
    pub file_ref: String,
    pub status: String,
    pub summary: Option<ControlAcceptedMemoryProjectionImportSummaryDto>,
    pub blockers: Vec<ControlAcceptedMemoryProjectionImportBlockerDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlAcceptedMemoryProjectionImportSummaryDto {
    pub title: String,
    pub body_kind: String,
    pub body_summary: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlAcceptedMemoryProjectionImportBlockerDto {
    pub kind: String,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlAcceptedMemoryProjectionImportCountsDto {
    #[ts(as = "u32")]
    pub source_records: usize,
    #[ts(as = "u32")]
    pub accepted_records: usize,
    #[ts(as = "u32")]
    pub out_of_scope_accepted_records: usize,
    #[ts(as = "u32")]
    pub skipped_records: usize,
    #[ts(as = "u32")]
    pub skipped_proposal_records: usize,
    #[ts(as = "u32")]
    pub skipped_unsupported_records: usize,
    #[ts(as = "u32")]
    pub skipped_decode_errors: usize,
    #[ts(as = "u32")]
    pub skipped_encode_errors: usize,
    #[ts(as = "u32")]
    pub input_files: usize,
    #[ts(as = "u32")]
    pub candidates: usize,
    #[ts(as = "u32")]
    pub ready_candidates: usize,
    #[ts(as = "u32")]
    pub blocked_candidates: usize,
    #[ts(as = "u32")]
    pub admitted_imports: usize,
    #[ts(as = "u32")]
    pub blocked_imports: usize,
    #[ts(as = "u32")]
    pub no_conflicts: usize,
    #[ts(as = "u32")]
    pub duplicate_noops: usize,
    #[ts(as = "u32")]
    pub semantic_conflicts: usize,
    #[ts(as = "u32")]
    pub policy_conflicts: usize,
    #[ts(as = "u32")]
    pub blocked_conflicts: usize,
    #[ts(as = "u32")]
    pub candidate_blockers: usize,
    #[ts(as = "u32")]
    pub admission_blockers: usize,
    #[ts(as = "u32")]
    pub conflict_blockers: usize,
    #[ts(as = "u32")]
    pub file_refs: usize,
}

impl From<&AcceptedMemoryProjectionImportDiagnostics>
    for ControlAcceptedMemoryProjectionImportDiagnosticsDto
{
    fn from(diagnostics: &AcceptedMemoryProjectionImportDiagnostics) -> Self {
        Self {
            project_id: diagnostics.project_id.0.clone(),
            candidates: diagnostics
                .candidates
                .iter()
                .map(ControlAcceptedMemoryProjectionImportCandidateDto::from)
                .collect(),
            admissions: diagnostics
                .admissions
                .iter()
                .map(ControlAcceptedMemoryProjectionImportAdmissionDto::from)
                .collect(),
            conflicts: diagnostics
                .conflicts
                .iter()
                .map(ControlAcceptedMemoryProjectionImportConflictDto::from)
                .collect(),
            counts: ControlAcceptedMemoryProjectionImportCountsDto::from(&diagnostics.counts),
            projected_file_read_performed: diagnostics.projected_file_read_performed,
            active_memory_apply_performed: diagnostics.active_memory_apply_performed,
            scm_effect_performed: diagnostics.scm_effect_performed,
            embedding_available: diagnostics.embedding_available,
            provider_sync_available: diagnostics.provider_sync_available,
            task_mutation_performed: diagnostics.task_mutation_performed,
            ui_effect_performed: diagnostics.ui_effect_performed,
        }
    }
}

impl From<&AcceptedMemoryProjectionImportCandidateRecord>
    for ControlAcceptedMemoryProjectionImportCandidateDto
{
    fn from(candidate: &AcceptedMemoryProjectionImportCandidateRecord) -> Self {
        Self {
            candidate_ref: candidate.candidate_ref.clone(),
            memory_id: candidate.memory_id.clone(),
            file_ref: candidate.file_ref.clone(),
            status: candidate_status(&candidate.status),
            summary: candidate
                .summary
                .as_ref()
                .map(ControlAcceptedMemoryProjectionImportSummaryDto::from),
            blockers: candidate.blockers.iter().map(candidate_blocker).collect(),
        }
    }
}

impl From<&AcceptedMemoryProjectionImportAdmissionRecord>
    for ControlAcceptedMemoryProjectionImportAdmissionDto
{
    fn from(admission: &AcceptedMemoryProjectionImportAdmissionRecord) -> Self {
        Self {
            admission_ref: admission.admission_ref.clone(),
            candidate_ref: admission.candidate_ref.clone(),
            memory_id: admission.memory_id.clone(),
            file_ref: admission.file_ref.clone(),
            status: admission_status(&admission.status),
            blockers: admission.blockers.iter().map(admission_blocker).collect(),
        }
    }
}

impl From<&AcceptedMemoryProjectionImportConflictRecord>
    for ControlAcceptedMemoryProjectionImportConflictDto
{
    fn from(conflict: &AcceptedMemoryProjectionImportConflictRecord) -> Self {
        Self {
            conflict_ref: conflict.conflict_ref.clone(),
            admission_ref: conflict.admission_ref.clone(),
            candidate_ref: conflict.candidate_ref.clone(),
            memory_id: conflict.memory_id.clone(),
            file_ref: conflict.file_ref.clone(),
            status: conflict_status(&conflict.status),
            summary: conflict
                .summary
                .as_ref()
                .map(ControlAcceptedMemoryProjectionImportSummaryDto::from),
            blockers: conflict.blockers.iter().map(conflict_blocker).collect(),
        }
    }
}

impl From<&AcceptedMemoryProjectionImportCandidateSummary>
    for ControlAcceptedMemoryProjectionImportSummaryDto
{
    fn from(summary: &AcceptedMemoryProjectionImportCandidateSummary) -> Self {
        Self {
            title: summary.title.clone(),
            body_kind: summary.body_kind.clone(),
            body_summary: summary.body_summary.clone(),
        }
    }
}

impl From<&AcceptedMemoryProjectionImportDiagnosticCounts>
    for ControlAcceptedMemoryProjectionImportCountsDto
{
    fn from(counts: &AcceptedMemoryProjectionImportDiagnosticCounts) -> Self {
        Self {
            source_records: counts.source_records,
            accepted_records: counts.accepted_records,
            out_of_scope_accepted_records: counts.out_of_scope_accepted_records,
            skipped_records: counts.skipped_records,
            skipped_proposal_records: counts.skipped_proposal_records,
            skipped_unsupported_records: counts.skipped_unsupported_records,
            skipped_decode_errors: counts.skipped_decode_errors,
            skipped_encode_errors: counts.skipped_encode_errors,
            input_files: counts.input_files,
            candidates: counts.candidates,
            ready_candidates: counts.ready_candidates,
            blocked_candidates: counts.blocked_candidates,
            admitted_imports: counts.admitted_imports,
            blocked_imports: counts.blocked_imports,
            no_conflicts: counts.no_conflicts,
            duplicate_noops: counts.duplicate_noops,
            semantic_conflicts: counts.semantic_conflicts,
            policy_conflicts: counts.policy_conflicts,
            blocked_conflicts: counts.blocked_conflicts,
            candidate_blockers: counts.candidate_blockers,
            admission_blockers: counts.admission_blockers,
            conflict_blockers: counts.conflict_blockers,
            file_refs: counts.file_refs,
        }
    }
}
