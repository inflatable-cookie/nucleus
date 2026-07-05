use nucleus_server::{
    ControlAcceptedMemoryProjectionWriteBlockerDto,
    ControlAcceptedMemoryProjectionWriteDiagnosticsDto,
};

pub(crate) fn accepted_memory_projection_writes_response_lines(
    label: &str,
    diagnostics: ControlAcceptedMemoryProjectionWriteDiagnosticsDto,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("project_id={}", diagnostics.project_id),
        format!("entries={}", diagnostics.entries.len()),
        format!(
            "counts accepted_records={} out_of_scope_accepted_records={} admitted_writes={} blocked_writes={} payload_ready_records={} payload_blocked_records={} materialized_files={} skipped_records={} skipped_proposal_records={} skipped_unsupported_records={} skipped_decode_errors={} policy_blockers={} export_blockers={} admission_blockers={} payload_blockers={} file_refs={}",
            diagnostics.counts.accepted_records,
            diagnostics.counts.out_of_scope_accepted_records,
            diagnostics.counts.admitted_writes,
            diagnostics.counts.blocked_writes,
            diagnostics.counts.payload_ready_records,
            diagnostics.counts.payload_blocked_records,
            diagnostics.counts.materialized_files,
            diagnostics.counts.skipped_records,
            diagnostics.counts.skipped_proposal_records,
            diagnostics.counts.skipped_unsupported_records,
            diagnostics.counts.skipped_decode_errors,
            diagnostics.counts.policy_blockers,
            diagnostics.counts.export_blockers,
            diagnostics.counts.admission_blockers,
            diagnostics.counts.payload_blockers,
            diagnostics.counts.file_refs
        ),
        format!(
            "flags projection_write_performed={} scm_effect_performed={} import_or_apply_performed={} embedding_available={} provider_sync_available={} task_mutation_performed={} ui_effect_performed={}",
            diagnostics.projection_write_performed,
            diagnostics.scm_effect_performed,
            diagnostics.import_or_apply_performed,
            diagnostics.embedding_available,
            diagnostics.provider_sync_available,
            diagnostics.task_mutation_performed,
            diagnostics.ui_effect_performed
        ),
    ];

    lines.extend(diagnostics.entries.into_iter().map(|entry| {
        format!(
            "entry memory_id={} plan_ref={} file_ref={} policy_status={} export_status={} admission_status={} payload_status={} materialization_status={} policy_blockers={} export_blockers={} admission_blockers={} payload_blockers={}",
            entry.memory_id,
            entry.plan_ref,
            entry.file_ref.unwrap_or_else(|| "none".to_owned()),
            entry.policy_status,
            entry.export_status,
            entry.admission_status,
            entry.payload_status,
            entry.materialization_status,
            blocker_list(entry.policy_blockers),
            blocker_list(entry.export_blockers),
            blocker_list(entry.admission_blockers),
            blocker_list(entry.payload_blockers)
        )
    }));

    lines
}

fn blocker_list(blockers: Vec<ControlAcceptedMemoryProjectionWriteBlockerDto>) -> String {
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
