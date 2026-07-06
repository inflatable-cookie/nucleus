use nucleus_server::ControlAcceptedMemoryReviewReceiptStorageDiagnosticsDto;

pub(crate) fn accepted_memory_review_receipt_storage_response_lines(
    label: &str,
    diagnostics: ControlAcceptedMemoryReviewReceiptStorageDiagnosticsDto,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("diagnostics_id={}", diagnostics.diagnostics_id),
        format!("project_id={}", diagnostics.project_id),
        format!("receipts={}", diagnostics.receipts.len()),
        format!(
            "counts records={} approved={} deferred={} rejected={} blocked={} admitted={} duplicate_noops={} admission_blocked={} blockers={} admission_blockers={} provenance_refs={} evidence_refs={} unsupported_records_skipped={} other_project_records_skipped={} decode_failed_records={}",
            diagnostics.counts.records,
            diagnostics.counts.approved,
            diagnostics.counts.deferred,
            diagnostics.counts.rejected,
            diagnostics.counts.blocked,
            diagnostics.counts.admitted,
            diagnostics.counts.duplicate_noops,
            diagnostics.counts.admission_blocked,
            diagnostics.counts.blockers,
            diagnostics.counts.admission_blockers,
            diagnostics.counts.provenance_refs,
            diagnostics.counts.evidence_refs,
            diagnostics.counts.unsupported_records_skipped,
            diagnostics.counts.other_project_records_skipped,
            diagnostics.counts.decode_failed_records
        ),
        format!(
            "review_receipts_persisted={}",
            diagnostics.review_receipts_persisted
        ),
        format!(
            "active_memory_apply_performed={}",
            diagnostics.active_memory_apply_performed
        ),
        format!(
            "projection_write_performed={}",
            diagnostics.projection_write_performed
        ),
        format!("scm_effect_performed={}", diagnostics.scm_effect_performed),
        format!("embedding_available={}", diagnostics.embedding_available),
        format!(
            "provider_sync_available={}",
            diagnostics.provider_sync_available
        ),
        format!(
            "automatic_extraction_performed={}",
            diagnostics.automatic_extraction_performed
        ),
        format!(
            "task_mutation_performed={}",
            diagnostics.task_mutation_performed
        ),
        format!(
            "agent_scheduling_performed={}",
            diagnostics.agent_scheduling_performed
        ),
        format!("ui_effect_performed={}", diagnostics.ui_effect_performed),
    ];
    lines.extend(diagnostics.receipts.into_iter().map(|receipt| {
        format!(
            "receipt receipt_id={} command_id={} apply_admission_ref={} import_admission_ref={} conflict_ref={} candidate_ref={} memory_id={} file_ref={} decision={} status={} admission_status={} blockers={} admission_blockers={} provenance_refs={} evidence_refs={}",
            receipt.review_receipt_id,
            receipt.command_id,
            receipt.apply_admission_ref,
            receipt.import_admission_ref,
            receipt.conflict_ref,
            receipt.candidate_ref,
            receipt.memory_id,
            receipt.file_ref,
            receipt.decision,
            receipt.status,
            receipt.admission_status,
            receipt.blockers.len(),
            receipt.admission_blockers.len(),
            receipt.provenance_refs.len(),
            receipt.evidence_refs.len()
        )
    }));
    lines
}
