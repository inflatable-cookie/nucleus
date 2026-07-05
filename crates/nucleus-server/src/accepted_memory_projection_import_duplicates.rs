//! Accepted-memory projection import duplicate detection.

use std::collections::{HashMap, HashSet};

use crate::accepted_memory_projection_import_records::{
    AcceptedMemoryProjectionImportCandidateBlocker, AcceptedMemoryProjectionImportCandidateRecord,
};
use crate::accepted_memory_projection_import_validation::candidate_status;

pub(super) fn mark_duplicate_candidates(
    candidates: Vec<AcceptedMemoryProjectionImportCandidateRecord>,
) -> Vec<AcceptedMemoryProjectionImportCandidateRecord> {
    let file_ref_counts = count_file_refs(&candidates);
    let memory_id_counts = count_memory_ids(&candidates);
    let mut seen_refs = HashSet::new();

    candidates
        .into_iter()
        .map(|mut candidate| {
            mark_candidate_duplicates(&mut candidate, &file_ref_counts, &memory_id_counts);
            if !seen_refs.insert(candidate.candidate_ref.clone()) {
                candidate.candidate_ref =
                    format!("{}:{}", candidate.candidate_ref, seen_refs.len());
            }
            candidate.status = candidate_status(&candidate.blockers);
            candidate
        })
        .collect()
}

fn count_file_refs(
    candidates: &[AcceptedMemoryProjectionImportCandidateRecord],
) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for candidate in candidates {
        *counts.entry(candidate.file_ref.clone()).or_insert(0) += 1;
    }
    counts
}

fn count_memory_ids(
    candidates: &[AcceptedMemoryProjectionImportCandidateRecord],
) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for candidate in candidates {
        if let Some(memory_id) = &candidate.memory_id {
            *counts.entry(memory_id.clone()).or_insert(0) += 1;
        }
    }
    counts
}

fn mark_candidate_duplicates(
    candidate: &mut AcceptedMemoryProjectionImportCandidateRecord,
    file_ref_counts: &HashMap<String, usize>,
    memory_id_counts: &HashMap<String, usize>,
) {
    let duplicate_file_ref = file_ref_counts
        .get(&candidate.file_ref)
        .copied()
        .unwrap_or(0)
        > 1;
    let duplicate_memory_id = candidate
        .memory_id
        .as_ref()
        .and_then(|memory_id| memory_id_counts.get(memory_id).copied())
        .unwrap_or(0)
        > 1;

    if duplicate_file_ref
        && !candidate
            .blockers
            .contains(&AcceptedMemoryProjectionImportCandidateBlocker::DuplicateFileRef)
    {
        candidate
            .blockers
            .push(AcceptedMemoryProjectionImportCandidateBlocker::DuplicateFileRef);
    }
    if duplicate_memory_id
        && !candidate
            .blockers
            .contains(&AcceptedMemoryProjectionImportCandidateBlocker::DuplicateMemoryId)
    {
        candidate
            .blockers
            .push(AcceptedMemoryProjectionImportCandidateBlocker::DuplicateMemoryId);
    }
}
