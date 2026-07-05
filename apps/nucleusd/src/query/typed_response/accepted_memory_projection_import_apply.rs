use nucleus_server::{
    ControlAcceptedMemoryProjectionImportApplyBlockerDto,
    ControlAcceptedMemoryProjectionImportApplyDiagnosticsDto,
};

pub(crate) fn accepted_memory_projection_import_apply_response_lines(
    label: &str,
    diagnostics: ControlAcceptedMemoryProjectionImportApplyDiagnosticsDto,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("diagnostics_id={}", diagnostics.diagnostics_id),
        format!("project_id={}", diagnostics.project_id),
        format!("records={}", diagnostics.records.len()),
        format!(
            "counts source_records={} import_conflicts={} apply_admissions={} admitted={} duplicate_noops={} blocked={} blockers={} missing_ref_blockers={} conflict_blockers={} raw_payload_blockers={} effect_blockers={} provenance_refs={} evidence_refs={}",
            diagnostics.counts.source_records,
            diagnostics.counts.import_conflicts,
            diagnostics.counts.apply_admissions,
            diagnostics.counts.admitted,
            diagnostics.counts.duplicate_noops,
            diagnostics.counts.blocked,
            diagnostics.counts.blockers,
            diagnostics.counts.missing_ref_blockers,
            diagnostics.counts.conflict_blockers,
            diagnostics.counts.raw_payload_blockers,
            diagnostics.counts.effect_blockers,
            diagnostics.counts.provenance_refs,
            diagnostics.counts.evidence_refs
        ),
        format!(
            "flags active_memory_apply_performed={} projection_write_performed={} scm_effect_performed={} embedding_available={} provider_sync_available={} automatic_extraction_performed={} task_mutation_performed={} agent_scheduling_performed={} ui_effect_performed={}",
            diagnostics.active_memory_apply_performed,
            diagnostics.projection_write_performed,
            diagnostics.scm_effect_performed,
            diagnostics.embedding_available,
            diagnostics.provider_sync_available,
            diagnostics.automatic_extraction_performed,
            diagnostics.task_mutation_performed,
            diagnostics.agent_scheduling_performed,
            diagnostics.ui_effect_performed
        ),
    ];

    lines.extend(diagnostics.records.into_iter().map(|record| {
        format!(
            "apply_admission apply_admission_ref={} request_id={} import_admission_ref={} conflict_ref={} candidate_ref={} memory_id={} file_ref={} status={} provenance_refs={} evidence_refs={} blockers={}",
            record.apply_admission_ref,
            record.request_id,
            record.import_admission_ref,
            record.conflict_ref,
            record.candidate_ref,
            record.memory_id.unwrap_or_else(|| "none".to_owned()),
            record.file_ref,
            record.status,
            record.provenance_refs.len(),
            record.evidence_refs.len(),
            blocker_list(record.blockers)
        )
    }));

    lines
}

fn blocker_list(blockers: Vec<ControlAcceptedMemoryProjectionImportApplyBlockerDto>) -> String {
    if blockers.is_empty() {
        return "none".to_owned();
    }

    blockers
        .into_iter()
        .map(|blocker| match blocker.detail {
            Some(detail) if !detail.trim().is_empty() => {
                format!("{}:{detail}", blocker.kind)
            }
            _ => blocker.kind,
        })
        .collect::<Vec<_>>()
        .join(",")
}
