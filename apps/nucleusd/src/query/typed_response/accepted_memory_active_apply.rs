use nucleus_server::ControlAcceptedMemoryActiveApplyDiagnosticsDto;

pub(crate) fn accepted_memory_active_apply_response_lines(
    label: &str,
    diagnostics: ControlAcceptedMemoryActiveApplyDiagnosticsDto,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("diagnostics_id={}", diagnostics.diagnostics_id),
        format!("project_id={}", diagnostics.project_id),
        format!("records={}", diagnostics.records.len()),
        format!(
            "counts source_records={} admitted={} duplicate_noops={} blocked={} blockers={} missing_ref_blockers={} review_state_blockers={} stale_ref_blockers={} raw_payload_blockers={} effect_blockers={} unsupported_records_skipped={} other_project_records_skipped={} decode_failed_records={}",
            diagnostics.counts.source_records,
            diagnostics.counts.admitted,
            diagnostics.counts.duplicate_noops,
            diagnostics.counts.blocked,
            diagnostics.counts.blockers,
            diagnostics.counts.missing_ref_blockers,
            diagnostics.counts.review_state_blockers,
            diagnostics.counts.stale_ref_blockers,
            diagnostics.counts.raw_payload_blockers,
            diagnostics.counts.effect_blockers,
            diagnostics.counts.unsupported_records_skipped,
            diagnostics.counts.other_project_records_skipped,
            diagnostics.counts.decode_failed_records
        ),
        format!(
            "active_memory_apply_performed={}",
            diagnostics.no_effects.active_memory_apply_performed
        ),
        format!(
            "projection_write_performed={}",
            diagnostics.no_effects.projection_write_performed
        ),
        format!("scm_effect_performed={}", diagnostics.no_effects.scm_effect_performed),
        format!("embedding_available={}", diagnostics.no_effects.embedding_available),
        format!(
            "provider_sync_available={}",
            diagnostics.no_effects.provider_sync_available
        ),
        format!(
            "automatic_extraction_performed={}",
            diagnostics.no_effects.automatic_extraction_performed
        ),
        format!(
            "task_mutation_performed={}",
            diagnostics.no_effects.task_mutation_performed
        ),
        format!(
            "agent_scheduling_performed={}",
            diagnostics.no_effects.agent_scheduling_performed
        ),
        format!("ui_effect_performed={}", diagnostics.no_effects.ui_effect_performed),
    ];
    lines.extend(diagnostics.records.into_iter().map(|record| {
        format!(
            "record active_apply_admission_ref={} review_receipt_id={} apply_admission_ref={} import_admission_ref={} conflict_ref={} candidate_ref={} memory_id={} file_ref={} status={} blockers={} provenance_refs={} evidence_refs={}",
            record.active_apply_admission_ref,
            record.review_receipt_id,
            record.apply_admission_ref,
            record.import_admission_ref,
            record.conflict_ref,
            record.candidate_ref,
            record.memory_id,
            record.file_ref,
            record.status,
            record.blockers.len(),
            record.provenance_refs.len(),
            record.evidence_refs.len()
        )
    }));
    lines
}
