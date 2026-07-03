use nucleus_server::ControlMemoryProposalReviewDiagnosticsDto;

pub(crate) fn memory_proposal_review_response_lines(
    label: &str,
    diagnostics: ControlMemoryProposalReviewDiagnosticsDto,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("project_id={}", diagnostics.project_id),
        format!("records={}", diagnostics.proposal_records),
        format!(
            "counts queued={} deferred={} rejected={} reviewed_for_promotion={} blocked={} needs_review={}",
            diagnostics.queued_count,
            diagnostics.deferred_count,
            diagnostics.rejected_count,
            diagnostics.reviewed_for_promotion_count,
            diagnostics.blocked_count,
            diagnostics.needs_review_count
        ),
        format!("client_can_mutate={}", diagnostics.client_can_mutate),
        format!(
            "accepted_memory_created={}",
            diagnostics.accepted_memory_created
        ),
        format!("projection_written={}", diagnostics.projection_written),
        format!("embedding_generated={}", diagnostics.embedding_generated),
        format!(
            "provider_native_memory_synced={}",
            diagnostics.provider_native_memory_synced
        ),
        format!(
            "automatic_extraction_run={}",
            diagnostics.automatic_extraction_run
        ),
        format!("raw_payload_exposed={}", diagnostics.raw_payload_exposed),
        format!("private_note_exposed={}", diagnostics.private_note_exposed),
    ];
    lines.extend(diagnostics.entries.into_iter().map(|entry| {
        format!(
            "proposal proposal_id={} scope_ref={} proposal_status={} review_status={} reviewer_ref_present={} note_present={} source_refs={} link_refs={}",
            entry.proposal_id,
            entry.scope_ref,
            entry.proposal_status,
            entry.review_status,
            entry.reviewer_ref_present,
            entry.note_present,
            entry.source_ref_count,
            entry.link_ref_count
        )
    }));
    lines
}
