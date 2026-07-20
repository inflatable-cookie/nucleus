use crate::provider_no_effects::MemoryApplyNoEffects;
use serde::{Deserialize, Serialize};

use crate::accepted_memory_import_apply_review_command::{
    AcceptedMemoryImportApplyReviewBlocker, AcceptedMemoryImportApplyReviewCounts,
    AcceptedMemoryImportApplyReviewDecision, AcceptedMemoryImportApplyReviewReceipt,
    AcceptedMemoryImportApplyReviewStatus,
};
use crate::accepted_memory_import_apply_review_diagnostics::AcceptedMemoryImportApplyReviewDiagnostics;
use crate::accepted_memory_projection_import_apply_admission::{
    AcceptedMemoryProjectionImportApplyAdmissionBlocker,
    AcceptedMemoryProjectionImportApplyAdmissionStatus,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlAcceptedMemoryImportApplyReviewDiagnosticsDto {
    pub diagnostics_id: String,
    pub project_id: String,
    pub receipts: Vec<ControlAcceptedMemoryImportApplyReviewReceiptDto>,
    pub counts: ControlAcceptedMemoryImportApplyReviewCountsDto,
    pub review_receipts_persisted: bool,
    #[serde(flatten)]
    pub no_effects: MemoryApplyNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlAcceptedMemoryImportApplyReviewReceiptDto {
    pub review_receipt_ref: String,
    pub command_id: String,
    pub apply_admission_ref: String,
    pub import_admission_ref: String,
    pub conflict_ref: String,
    pub candidate_ref: String,
    pub memory_id: Option<String>,
    pub file_ref: String,
    pub operator_ref: String,
    pub approval_ref: String,
    pub decision_reason_ref: String,
    pub admission_status: String,
    pub admission_blockers: Vec<ControlAcceptedMemoryImportApplyReviewBlockerDto>,
    pub decision: String,
    pub status: String,
    pub blockers: Vec<ControlAcceptedMemoryImportApplyReviewBlockerDto>,
    pub provenance_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlAcceptedMemoryImportApplyReviewBlockerDto {
    pub kind: String,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlAcceptedMemoryImportApplyReviewCountsDto {
    #[ts(as = "u32")]
    pub inputs: usize,
    #[ts(as = "u32")]
    pub approved: usize,
    #[ts(as = "u32")]
    pub deferred: usize,
    #[ts(as = "u32")]
    pub rejected: usize,
    #[ts(as = "u32")]
    pub blocked: usize,
    #[ts(as = "u32")]
    pub duplicate_noops: usize,
    #[ts(as = "u32")]
    pub conflicts: usize,
    #[ts(as = "u32")]
    pub approval_required: usize,
    #[ts(as = "u32")]
    pub blockers: usize,
    #[ts(as = "u32")]
    pub missing_ref_blockers: usize,
    #[ts(as = "u32")]
    pub admission_blockers: usize,
    #[ts(as = "u32")]
    pub raw_payload_blockers: usize,
    #[ts(as = "u32")]
    pub effect_blockers: usize,
    #[ts(as = "u32")]
    pub provenance_refs: usize,
    #[ts(as = "u32")]
    pub evidence_refs: usize,
}

impl From<&AcceptedMemoryImportApplyReviewDiagnostics>
    for ControlAcceptedMemoryImportApplyReviewDiagnosticsDto
{
    fn from(diagnostics: &AcceptedMemoryImportApplyReviewDiagnostics) -> Self {
        Self {
            diagnostics_id: diagnostics.diagnostics_id.clone(),
            project_id: diagnostics.project_id.0.clone(),
            receipts: diagnostics
                .review_set
                .receipts
                .iter()
                .map(ControlAcceptedMemoryImportApplyReviewReceiptDto::from)
                .collect(),
            counts: ControlAcceptedMemoryImportApplyReviewCountsDto::from(
                &diagnostics.review_set.counts,
            ),
            review_receipts_persisted: diagnostics.review_receipts_persisted,
            no_effects: diagnostics.no_effects,
        }
    }
}

impl From<&AcceptedMemoryImportApplyReviewReceipt>
    for ControlAcceptedMemoryImportApplyReviewReceiptDto
{
    fn from(receipt: &AcceptedMemoryImportApplyReviewReceipt) -> Self {
        Self {
            review_receipt_ref: receipt.review_receipt_ref.clone(),
            command_id: receipt.command_id.clone(),
            apply_admission_ref: receipt.apply_admission_ref.clone(),
            import_admission_ref: receipt.import_admission_ref.clone(),
            conflict_ref: receipt.conflict_ref.clone(),
            candidate_ref: receipt.candidate_ref.clone(),
            memory_id: receipt.memory_id.clone(),
            file_ref: receipt.file_ref.clone(),
            operator_ref: receipt.operator_ref.clone(),
            approval_ref: receipt.approval_ref.clone(),
            decision_reason_ref: receipt.decision_reason_ref.clone(),
            admission_status: admission_status(&receipt.admission_status),
            admission_blockers: receipt
                .admission_blockers
                .iter()
                .map(admission_blocker)
                .collect(),
            decision: decision(&receipt.decision),
            status: status(&receipt.status),
            blockers: receipt.blockers.iter().map(review_blocker).collect(),
            provenance_refs: receipt.provenance_refs.clone(),
            evidence_refs: receipt.evidence_refs.clone(),
        }
    }
}

impl From<&AcceptedMemoryImportApplyReviewCounts>
    for ControlAcceptedMemoryImportApplyReviewCountsDto
{
    fn from(counts: &AcceptedMemoryImportApplyReviewCounts) -> Self {
        Self {
            inputs: counts.inputs,
            approved: counts.approved,
            deferred: counts.deferred,
            rejected: counts.rejected,
            blocked: counts.blocked,
            duplicate_noops: counts.duplicate_noops,
            conflicts: counts.conflicts,
            approval_required: counts.approval_required,
            blockers: counts.blockers,
            missing_ref_blockers: counts.missing_ref_blockers,
            admission_blockers: counts.admission_blockers,
            raw_payload_blockers: counts.raw_payload_blockers,
            effect_blockers: counts.effect_blockers,
            provenance_refs: counts.provenance_refs,
            evidence_refs: counts.evidence_refs,
        }
    }
}

fn decision(value: &AcceptedMemoryImportApplyReviewDecision) -> String {
    match value {
        AcceptedMemoryImportApplyReviewDecision::Approve => "approve",
        AcceptedMemoryImportApplyReviewDecision::Defer => "defer",
        AcceptedMemoryImportApplyReviewDecision::Reject => "reject",
    }
    .to_owned()
}

fn status(value: &AcceptedMemoryImportApplyReviewStatus) -> String {
    match value {
        AcceptedMemoryImportApplyReviewStatus::Approved => "approved",
        AcceptedMemoryImportApplyReviewStatus::Deferred => "deferred",
        AcceptedMemoryImportApplyReviewStatus::Rejected => "rejected",
        AcceptedMemoryImportApplyReviewStatus::Blocked => "blocked",
    }
    .to_owned()
}

fn admission_status(value: &AcceptedMemoryProjectionImportApplyAdmissionStatus) -> String {
    match value {
        AcceptedMemoryProjectionImportApplyAdmissionStatus::Admitted => "admitted",
        AcceptedMemoryProjectionImportApplyAdmissionStatus::DuplicateNoop => "duplicate_noop",
        AcceptedMemoryProjectionImportApplyAdmissionStatus::Blocked => "blocked",
    }
    .to_owned()
}

fn admission_blocker(
    value: &AcceptedMemoryProjectionImportApplyAdmissionBlocker,
) -> ControlAcceptedMemoryImportApplyReviewBlockerDto {
    ControlAcceptedMemoryImportApplyReviewBlockerDto {
        kind: match value {
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
            AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingMemoryId => {
                "missing_memory_id"
            }
            AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingFileRef => {
                "missing_file_ref"
            }
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
        }
        .to_owned(),
        detail: None,
    }
}

fn review_blocker(
    value: &AcceptedMemoryImportApplyReviewBlocker,
) -> ControlAcceptedMemoryImportApplyReviewBlockerDto {
    ControlAcceptedMemoryImportApplyReviewBlockerDto {
        kind: match value {
            AcceptedMemoryImportApplyReviewBlocker::MissingCommandId => "missing_command_id",
            AcceptedMemoryImportApplyReviewBlocker::MissingOperatorRef => "missing_operator_ref",
            AcceptedMemoryImportApplyReviewBlocker::MissingApprovalRef => "missing_approval_ref",
            AcceptedMemoryImportApplyReviewBlocker::MissingDecisionReasonRef => {
                "missing_decision_reason_ref"
            }
            AcceptedMemoryImportApplyReviewBlocker::MissingProvenanceRefs => {
                "missing_provenance_refs"
            }
            AcceptedMemoryImportApplyReviewBlocker::MissingEvidenceRefs => "missing_evidence_refs",
            AcceptedMemoryImportApplyReviewBlocker::MissingApplyAdmissionRef => {
                "missing_apply_admission_ref"
            }
            AcceptedMemoryImportApplyReviewBlocker::MissingImportAdmissionRef => {
                "missing_import_admission_ref"
            }
            AcceptedMemoryImportApplyReviewBlocker::MissingConflictRef => "missing_conflict_ref",
            AcceptedMemoryImportApplyReviewBlocker::MissingCandidateRef => "missing_candidate_ref",
            AcceptedMemoryImportApplyReviewBlocker::MissingMemoryId => "missing_memory_id",
            AcceptedMemoryImportApplyReviewBlocker::MissingFileRef => "missing_file_ref",
            AcceptedMemoryImportApplyReviewBlocker::AdmissionNotAdmitted => {
                "admission_not_admitted"
            }
            AcceptedMemoryImportApplyReviewBlocker::AdmissionDuplicateNoop => {
                "admission_duplicate_noop"
            }
            AcceptedMemoryImportApplyReviewBlocker::AdmissionBlocked => "admission_blocked",
            AcceptedMemoryImportApplyReviewBlocker::AdmissionBlockersPresent => {
                "admission_blockers_present"
            }
            AcceptedMemoryImportApplyReviewBlocker::RawPayloadPresent => "raw_payload_present",
            AcceptedMemoryImportApplyReviewBlocker::ActiveMemoryMutationRequested => {
                "active_memory_mutation_requested"
            }
            AcceptedMemoryImportApplyReviewBlocker::ProjectionWriteRequested => {
                "projection_write_requested"
            }
            AcceptedMemoryImportApplyReviewBlocker::ScmEffectRequested => "scm_effect_requested",
            AcceptedMemoryImportApplyReviewBlocker::EmbeddingRequested => "embedding_requested",
            AcceptedMemoryImportApplyReviewBlocker::ProviderSyncRequested => {
                "provider_sync_requested"
            }
            AcceptedMemoryImportApplyReviewBlocker::AutomaticExtractionRequested => {
                "automatic_extraction_requested"
            }
            AcceptedMemoryImportApplyReviewBlocker::TaskMutationRequested => {
                "task_mutation_requested"
            }
            AcceptedMemoryImportApplyReviewBlocker::AgentSchedulingRequested => {
                "agent_scheduling_requested"
            }
            AcceptedMemoryImportApplyReviewBlocker::UiEffectRequested => "ui_effect_requested",
        }
        .to_owned(),
        detail: None,
    }
}
