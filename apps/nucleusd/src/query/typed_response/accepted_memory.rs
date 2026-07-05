use nucleus_server::{
    ControlAcceptedMemoryConfidenceCountDto, ControlAcceptedMemoryKindCountDto,
    ControlAcceptedMemoryRetentionCountDto, ControlAcceptedMemoryScopeCountDto,
    ControlAcceptedMemorySensitivityCountDto, ControlAcceptedMemorySourceCountsDto,
    ControlAcceptedMemoryStatusCountDto, ControlAcceptedMemorySummaryDto,
};

pub(crate) fn accepted_memory_response_lines(
    label: &str,
    project_id: String,
    memories: Vec<ControlAcceptedMemorySummaryDto>,
    status_counts: Vec<ControlAcceptedMemoryStatusCountDto>,
    scope_counts: Vec<ControlAcceptedMemoryScopeCountDto>,
    kind_counts: Vec<ControlAcceptedMemoryKindCountDto>,
    sensitivity_counts: Vec<ControlAcceptedMemorySensitivityCountDto>,
    retention_counts: Vec<ControlAcceptedMemoryRetentionCountDto>,
    confidence_counts: Vec<ControlAcceptedMemoryConfidenceCountDto>,
    source_counts: ControlAcceptedMemorySourceCountsDto,
    client_can_mutate: bool,
    projection_written: bool,
    embedding_available: bool,
    provider_sync_available: bool,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("project_id={project_id}"),
        format!("memories={}", memories.len()),
        format!(
            "source_counts accepted_records={} out_of_scope_accepted_records={} skipped_records={} skipped_proposal_records={} skipped_unsupported_records={} skipped_decode_errors={} source_refs={} link_refs={} evidence_refs={} supersession_refs={}",
            source_counts.accepted_records,
            source_counts.out_of_scope_accepted_records,
            source_counts.skipped_records,
            source_counts.skipped_proposal_records,
            source_counts.skipped_unsupported_records,
            source_counts.skipped_decode_errors,
            source_counts.source_refs,
            source_counts.link_refs,
            source_counts.evidence_refs,
            source_counts.supersession_refs
        ),
        format!("client_can_mutate={client_can_mutate}"),
        format!("projection_written={projection_written}"),
        format!("embedding_available={embedding_available}"),
        format!("provider_sync_available={provider_sync_available}"),
    ];
    lines.extend(
        status_counts
            .into_iter()
            .map(|count| format!("status state={} count={}", count.status, count.count)),
    );
    lines.extend(
        scope_counts
            .into_iter()
            .map(|count| format!("scope name={} count={}", count.scope, count.count)),
    );
    lines.extend(
        kind_counts
            .into_iter()
            .map(|count| format!("kind name={} count={}", count.kind, count.count)),
    );
    lines.extend(sensitivity_counts.into_iter().map(|count| {
        format!(
            "sensitivity name={} count={}",
            count.sensitivity, count.count
        )
    }));
    lines.extend(
        retention_counts
            .into_iter()
            .map(|count| format!("retention name={} count={}", count.retention, count.count)),
    );
    lines.extend(
        confidence_counts
            .into_iter()
            .map(|count| format!("confidence name={} count={}", count.confidence, count.count)),
    );
    lines.extend(memories.into_iter().map(|memory| {
        format!(
            "memory memory_id={} source_proposal_id={} scope={} kind={} status={} sensitivity={} retention={} confidence={} created_by_ref={} accepted_by_ref={} reviewer_ref={} source_refs={} link_refs={} evidence_refs={} supersedes={} superseded_by={}",
            memory.memory_id,
            memory.source_proposal_id.unwrap_or_else(|| "none".to_owned()),
            memory.scope,
            memory.kind,
            memory.status,
            memory.sensitivity,
            memory.retention,
            memory.confidence,
            memory.created_by_ref,
            memory.accepted_by_ref,
            memory.reviewer_ref,
            memory.source_ref_count,
            memory.link_ref_count,
            memory.evidence_ref_count,
            memory.supersedes_count,
            memory.superseded_by_count
        )
    }));
    lines
}
