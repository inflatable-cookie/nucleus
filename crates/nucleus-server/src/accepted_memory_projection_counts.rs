//! Count helpers for accepted-memory projections.

use std::collections::BTreeMap;

use crate::accepted_memory_projection::{
    AcceptedMemoryConfidenceCount, AcceptedMemoryKindCount, AcceptedMemoryRetentionCount,
    AcceptedMemoryScopeCount, AcceptedMemorySensitivityCount, AcceptedMemorySourceCounts,
    AcceptedMemoryStatusCount, AcceptedMemorySummary,
};

impl AcceptedMemorySourceCounts {
    pub(crate) fn empty() -> Self {
        Self {
            accepted_records: 0,
            out_of_scope_accepted_records: 0,
            skipped_records: 0,
            skipped_proposal_records: 0,
            skipped_unsupported_records: 0,
            skipped_decode_errors: 0,
            source_refs: 0,
            link_refs: 0,
            evidence_refs: 0,
            supersession_refs: 0,
        }
    }

    pub(crate) fn add_summary(&mut self, summary: &AcceptedMemorySummary) {
        self.source_refs += summary.source_ref_count;
        self.link_refs += summary.link_ref_count;
        self.evidence_refs += summary.evidence_ref_count;
        self.supersession_refs += summary.supersedes_count + summary.superseded_by_count;
    }
}

pub(crate) fn status_counts(summaries: &[AcceptedMemorySummary]) -> Vec<AcceptedMemoryStatusCount> {
    counted(summaries.iter().map(|summary| summary.status.clone()))
        .into_iter()
        .map(|(status, count)| AcceptedMemoryStatusCount { status, count })
        .collect()
}

pub(crate) fn scope_counts(summaries: &[AcceptedMemorySummary]) -> Vec<AcceptedMemoryScopeCount> {
    counted(summaries.iter().map(|summary| summary.scope.clone()))
        .into_iter()
        .map(|(scope, count)| AcceptedMemoryScopeCount { scope, count })
        .collect()
}

pub(crate) fn kind_counts(summaries: &[AcceptedMemorySummary]) -> Vec<AcceptedMemoryKindCount> {
    counted(summaries.iter().map(|summary| summary.kind.clone()))
        .into_iter()
        .map(|(kind, count)| AcceptedMemoryKindCount { kind, count })
        .collect()
}

pub(crate) fn sensitivity_counts(
    summaries: &[AcceptedMemorySummary],
) -> Vec<AcceptedMemorySensitivityCount> {
    counted(summaries.iter().map(|summary| summary.sensitivity.clone()))
        .into_iter()
        .map(|(sensitivity, count)| AcceptedMemorySensitivityCount { sensitivity, count })
        .collect()
}

pub(crate) fn retention_counts(
    summaries: &[AcceptedMemorySummary],
) -> Vec<AcceptedMemoryRetentionCount> {
    counted(summaries.iter().map(|summary| summary.retention.clone()))
        .into_iter()
        .map(|(retention, count)| AcceptedMemoryRetentionCount { retention, count })
        .collect()
}

pub(crate) fn confidence_counts(
    summaries: &[AcceptedMemorySummary],
) -> Vec<AcceptedMemoryConfidenceCount> {
    counted(summaries.iter().map(|summary| summary.confidence.clone()))
        .into_iter()
        .map(|(confidence, count)| AcceptedMemoryConfidenceCount { confidence, count })
        .collect()
}

fn counted<T>(values: impl Iterator<Item = T>) -> BTreeMap<T, usize>
where
    T: Ord,
{
    let mut counts = BTreeMap::new();
    for value in values {
        *counts.entry(value).or_insert(0) += 1;
    }
    counts
}
