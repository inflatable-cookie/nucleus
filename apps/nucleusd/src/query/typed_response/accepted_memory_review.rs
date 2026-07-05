use nucleus_server::ControlAcceptedMemoryReviewReadinessDto;

pub(crate) fn accepted_memory_review_response_lines(
    label: &str,
    readiness: ControlAcceptedMemoryReviewReadinessDto,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("project_id={}", readiness.project_id),
        format!("records={}", readiness.records.len()),
        format!(
            "counts accepted_memories={} projectable={} projection_blocked={} projection_write_admitted={} projection_write_blocked={} import_candidates_ready={} import_candidates_blocked={} import_admitted={} import_blocked={} duplicate_noops={} conflicts={} apply_admitted={} approval_required={} apply_blocked={} blockers={} evidence_refs={}",
            readiness.counts.accepted_memories,
            readiness.counts.projectable,
            readiness.counts.projection_blocked,
            readiness.counts.projection_write_admitted,
            readiness.counts.projection_write_blocked,
            readiness.counts.import_candidates_ready,
            readiness.counts.import_candidates_blocked,
            readiness.counts.import_admitted,
            readiness.counts.import_blocked,
            readiness.counts.duplicate_noops,
            readiness.counts.conflicts,
            readiness.counts.apply_admitted,
            readiness.counts.approval_required,
            readiness.counts.apply_blocked,
            readiness.counts.blocker_count,
            readiness.counts.evidence_ref_count
        ),
        format!(
            "flags active_memory_apply_performed={} projection_write_performed={} scm_effect_performed={} embedding_available={} provider_sync_available={} automatic_extraction_performed={} task_mutation_performed={} agent_scheduling_performed={} ui_effect_performed={}",
            readiness.active_memory_apply_performed,
            readiness.projection_write_performed,
            readiness.scm_effect_performed,
            readiness.embedding_available,
            readiness.provider_sync_available,
            readiness.automatic_extraction_performed,
            readiness.task_mutation_performed,
            readiness.agent_scheduling_performed,
            readiness.ui_effect_performed
        ),
    ];

    lines.extend(readiness.records.into_iter().map(|record| {
        format!(
            "readiness source={} memory_id={} source_ref={} file_ref={} status={} blockers={} evidence_refs={} approval_required={}",
            record.source,
            record.memory_id.unwrap_or_else(|| "none".to_owned()),
            record.source_ref,
            record.file_ref.unwrap_or_else(|| "none".to_owned()),
            record.status,
            record.blocker_count,
            record.evidence_ref_count,
            record.approval_required
        )
    }));

    lines
}
