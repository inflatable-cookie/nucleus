//! Read-only accepted-memory projection import candidates and admission.
//!
//! This module validates projected `nucleus/memory/*.toml` payloads before an
//! active-memory apply path exists. It does not mutate accepted memory, call
//! SCM/forge providers, run embeddings, sync provider memory, mutate tasks, or
//! expose raw provider/runtime payloads.

use nucleus_projects::ProjectId;

use crate::accepted_memory_projection_import_duplicates::mark_duplicate_candidates;
pub use crate::accepted_memory_projection_import_records::*;
use crate::accepted_memory_projection_import_validation::{
    candidate_status, candidate_summary, decode_payload_or_blocker, file_ref_blockers,
    payload_blockers,
};

pub fn accepted_memory_projection_import_admissions(
    project_id: ProjectId,
    inputs: impl IntoIterator<Item = AcceptedMemoryProjectionImportInput>,
) -> AcceptedMemoryProjectionImportAdmissionSet {
    let raw_candidates: Vec<_> = inputs
        .into_iter()
        .map(|input| accepted_memory_projection_import_candidate(&project_id, input))
        .collect();
    let candidates = mark_duplicate_candidates(raw_candidates);
    let admissions: Vec<_> = candidates
        .iter()
        .map(accepted_memory_projection_import_admission)
        .collect();
    let counts = AcceptedMemoryProjectionImportAdmissionCounts::from_records(
        candidates.len(),
        &candidates,
        &admissions,
    );

    AcceptedMemoryProjectionImportAdmissionSet {
        project_id,
        candidates,
        admissions,
        counts,
        active_memory_apply_performed: false,
        scm_effect_performed: false,
        embedding_available: false,
        provider_sync_available: false,
        task_mutation_performed: false,
        ui_effect_performed: false,
    }
}

pub fn accepted_memory_projection_import_candidate(
    project_id: &ProjectId,
    input: AcceptedMemoryProjectionImportInput,
) -> AcceptedMemoryProjectionImportCandidateRecord {
    let mut blockers = file_ref_blockers(&input.file_ref);
    let decoded = decode_payload_or_blocker(&input.bytes);
    match decoded {
        Ok(payload) => {
            blockers.extend(payload_blockers(project_id, &input.file_ref, &payload));
            let status = candidate_status(&blockers);
            AcceptedMemoryProjectionImportCandidateRecord {
                candidate_ref: accepted_memory_projection_import_candidate_ref(&input.file_ref),
                memory_id: Some(payload.memory_id.clone()),
                file_ref: input.file_ref,
                status,
                summary: Some(candidate_summary(&payload)),
                payload: Some(payload),
                blockers,
                active_memory_apply_performed: false,
            }
        }
        Err(blocker) => {
            blockers.push(blocker);
            let status = candidate_status(&blockers);
            AcceptedMemoryProjectionImportCandidateRecord {
                candidate_ref: accepted_memory_projection_import_candidate_ref(&input.file_ref),
                memory_id: None,
                file_ref: input.file_ref,
                status,
                payload: None,
                summary: None,
                blockers,
                active_memory_apply_performed: false,
            }
        }
    }
}

pub fn accepted_memory_projection_import_candidate_ref(file_ref: &str) -> String {
    format!("accepted-memory-import-candidate:{file_ref}")
}

pub fn accepted_memory_projection_import_admission_ref(candidate_ref: &str) -> String {
    format!("accepted-memory-import-admission:{candidate_ref}")
}

fn accepted_memory_projection_import_admission(
    candidate: &AcceptedMemoryProjectionImportCandidateRecord,
) -> AcceptedMemoryProjectionImportAdmissionRecord {
    let blockers = import_admission_blockers(candidate);

    AcceptedMemoryProjectionImportAdmissionRecord {
        admission_ref: accepted_memory_projection_import_admission_ref(&candidate.candidate_ref),
        candidate_ref: candidate.candidate_ref.clone(),
        memory_id: candidate.memory_id.clone(),
        file_ref: candidate.file_ref.clone(),
        status: if blockers.is_empty() {
            AcceptedMemoryProjectionImportAdmissionStatus::Admitted
        } else {
            AcceptedMemoryProjectionImportAdmissionStatus::Blocked
        },
        payload: candidate.payload.clone(),
        blockers,
        active_memory_apply_performed: false,
        scm_effect_performed: false,
        embedding_available: false,
        provider_sync_available: false,
        task_mutation_performed: false,
        ui_effect_performed: false,
    }
}

fn import_admission_blockers(
    candidate: &AcceptedMemoryProjectionImportCandidateRecord,
) -> Vec<AcceptedMemoryProjectionImportAdmissionBlocker> {
    let mut blockers = Vec::new();

    if candidate.status != AcceptedMemoryProjectionImportCandidateStatus::Ready {
        blockers.push(AcceptedMemoryProjectionImportAdmissionBlocker::CandidateNotReady);
    }
    if !candidate.blockers.is_empty() {
        blockers.push(AcceptedMemoryProjectionImportAdmissionBlocker::CandidateBlockersPresent);
    }
    if candidate.blockers.iter().any(|blocker| {
        matches!(
            blocker,
            AcceptedMemoryProjectionImportCandidateBlocker::DuplicateFileRef
                | AcceptedMemoryProjectionImportCandidateBlocker::DuplicateMemoryId
        )
    }) {
        blockers.push(AcceptedMemoryProjectionImportAdmissionBlocker::DuplicateCandidate);
    }
    if candidate.payload.is_none() {
        blockers.push(AcceptedMemoryProjectionImportAdmissionBlocker::MissingDecodedPayload);
    }

    blockers
}
