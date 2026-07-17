use crate::provider_no_effects::{MemoryApplyNoEffects};
use serde::{Deserialize, Serialize};

use crate::accepted_memory_projection_import_apply_admission::{
    AcceptedMemoryProjectionImportApplyAdmissionBlocker,
    AcceptedMemoryProjectionImportApplyAdmissionRecord,
    AcceptedMemoryProjectionImportApplyAdmissionStatus,
};
use crate::accepted_memory_projection_import_apply_diagnostics::{
    AcceptedMemoryProjectionImportApplyDiagnosticCounts,
    AcceptedMemoryProjectionImportApplyDiagnostics,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlAcceptedMemoryProjectionImportApplyDiagnosticsDto {
    pub diagnostics_id: String,
    pub project_id: String,
    pub records: Vec<ControlAcceptedMemoryProjectionImportApplyRecordDto>,
    pub counts: ControlAcceptedMemoryProjectionImportApplyCountsDto,
    #[serde(flatten)]
    pub no_effects: MemoryApplyNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlAcceptedMemoryProjectionImportApplyRecordDto {
    pub apply_admission_ref: String,
    pub request_id: String,
    pub import_admission_ref: String,
    pub conflict_ref: String,
    pub candidate_ref: String,
    pub memory_id: Option<String>,
    pub file_ref: String,
    pub operator_ref: String,
    pub approval_ref: String,
    pub provenance_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub status: String,
    pub blockers: Vec<ControlAcceptedMemoryProjectionImportApplyBlockerDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlAcceptedMemoryProjectionImportApplyBlockerDto {
    pub kind: String,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlAcceptedMemoryProjectionImportApplyCountsDto {
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

impl From<&AcceptedMemoryProjectionImportApplyDiagnostics>
    for ControlAcceptedMemoryProjectionImportApplyDiagnosticsDto
{
    fn from(diagnostics: &AcceptedMemoryProjectionImportApplyDiagnostics) -> Self {
        Self {
            diagnostics_id: diagnostics.diagnostics_id.clone(),
            project_id: diagnostics.project_id.0.clone(),
            records: diagnostics
                .records
                .iter()
                .map(ControlAcceptedMemoryProjectionImportApplyRecordDto::from)
                .collect(),
            counts: ControlAcceptedMemoryProjectionImportApplyCountsDto::from(&diagnostics.counts),
        no_effects: diagnostics.no_effects,
        }
    }
}

impl From<&AcceptedMemoryProjectionImportApplyAdmissionRecord>
    for ControlAcceptedMemoryProjectionImportApplyRecordDto
{
    fn from(record: &AcceptedMemoryProjectionImportApplyAdmissionRecord) -> Self {
        Self {
            apply_admission_ref: record.apply_admission_ref.clone(),
            request_id: record.request_id.clone(),
            import_admission_ref: record.import_admission_ref.clone(),
            conflict_ref: record.conflict_ref.clone(),
            candidate_ref: record.candidate_ref.clone(),
            memory_id: record.memory_id.clone(),
            file_ref: record.file_ref.clone(),
            operator_ref: record.operator_ref.clone(),
            approval_ref: record.approval_ref.clone(),
            provenance_refs: record.provenance_refs.clone(),
            evidence_refs: record.evidence_refs.clone(),
            status: apply_admission_status(&record.status),
            blockers: record
                .blockers
                .iter()
                .map(apply_admission_blocker)
                .collect(),
        }
    }
}

impl From<&AcceptedMemoryProjectionImportApplyDiagnosticCounts>
    for ControlAcceptedMemoryProjectionImportApplyCountsDto
{
    fn from(counts: &AcceptedMemoryProjectionImportApplyDiagnosticCounts) -> Self {
        Self {
            source_records: counts.source_records,
            import_conflicts: counts.import_conflicts,
            apply_admissions: counts.apply_admissions,
            admitted: counts.admitted,
            duplicate_noops: counts.duplicate_noops,
            blocked: counts.blocked,
            blockers: counts.blockers,
            missing_ref_blockers: counts.missing_ref_blockers,
            conflict_blockers: counts.conflict_blockers,
            raw_payload_blockers: counts.raw_payload_blockers,
            effect_blockers: counts.effect_blockers,
            provenance_refs: counts.provenance_refs,
            evidence_refs: counts.evidence_refs,
        }
    }
}

fn apply_admission_status(status: &AcceptedMemoryProjectionImportApplyAdmissionStatus) -> String {
    match status {
        AcceptedMemoryProjectionImportApplyAdmissionStatus::Admitted => "admitted",
        AcceptedMemoryProjectionImportApplyAdmissionStatus::DuplicateNoop => "duplicate_noop",
        AcceptedMemoryProjectionImportApplyAdmissionStatus::Blocked => "blocked",
    }
    .to_owned()
}

fn apply_admission_blocker(
    blocker_value: &AcceptedMemoryProjectionImportApplyAdmissionBlocker,
) -> ControlAcceptedMemoryProjectionImportApplyBlockerDto {
    let kind = match blocker_value {
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingRequestId => {
            "missing_request_id"
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingOperatorRef => {
            "missing_operator_ref"
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingApprovalRef => {
            "missing_approval_ref"
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingProvenanceRefs => {
            "missing_provenance_refs"
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingEvidenceRefs => {
            "missing_evidence_refs"
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingImportAdmissionRef => {
            "missing_import_admission_ref"
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingConflictRef => {
            "missing_conflict_ref"
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingCandidateRef => {
            "missing_candidate_ref"
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingMemoryId => "missing_memory_id",
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingFileRef => "missing_file_ref",
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::DuplicateNoop => "duplicate_noop",
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::UnresolvedSemanticConflict => {
            "unresolved_semantic_conflict"
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::UnresolvedPolicyConflict => {
            "unresolved_policy_conflict"
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::ImportConflictBlocked => {
            "import_conflict_blocked"
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::RawPayloadPresent => {
            "raw_payload_present"
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::ActiveMemoryMutationRequested => {
            "active_memory_mutation_requested"
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::ProjectionWriteRequested => {
            "projection_write_requested"
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::ScmEffectRequested => {
            "scm_effect_requested"
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::EmbeddingRequested => {
            "embedding_requested"
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::ProviderSyncRequested => {
            "provider_sync_requested"
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::AutomaticExtractionRequested => {
            "automatic_extraction_requested"
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::TaskMutationRequested => {
            "task_mutation_requested"
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::AgentSchedulingRequested => {
            "agent_scheduling_requested"
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::UiEffectRequested => {
            "ui_effect_requested"
        }
    };

    ControlAcceptedMemoryProjectionImportApplyBlockerDto {
        kind: kind.to_owned(),
        detail: None,
    }
}
