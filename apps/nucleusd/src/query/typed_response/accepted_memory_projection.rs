use nucleus_server::{
    ControlAcceptedMemoryProjectionBlockerDto, ControlAcceptedMemoryProjectionDiagnosticsDto,
};

pub(crate) fn accepted_memory_projection_response_lines(
    label: &str,
    diagnostics: ControlAcceptedMemoryProjectionDiagnosticsDto,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("project_id={}", diagnostics.project_id),
        format!("entries={}", diagnostics.entries.len()),
        format!(
            "counts accepted_records={} out_of_scope_accepted_records={} projectable_records={} local_only_records={} blocked_records={} review_required_records={} skipped_records={} skipped_proposal_records={} skipped_unsupported_records={} skipped_decode_errors={} policy_blockers={} export_blockers={} file_refs={}",
            diagnostics.counts.accepted_records,
            diagnostics.counts.out_of_scope_accepted_records,
            diagnostics.counts.projectable_records,
            diagnostics.counts.local_only_records,
            diagnostics.counts.blocked_records,
            diagnostics.counts.review_required_records,
            diagnostics.counts.skipped_records,
            diagnostics.counts.skipped_proposal_records,
            diagnostics.counts.skipped_unsupported_records,
            diagnostics.counts.skipped_decode_errors,
            diagnostics.counts.policy_blockers,
            diagnostics.counts.export_blockers,
            diagnostics.counts.file_refs
        ),
        format!(
            "flags projection_write_performed={} scm_effect_performed={} import_or_apply_performed={} embedding_available={} provider_sync_available={}",
            diagnostics.projection_write_performed,
            diagnostics.scm_effect_performed,
            diagnostics.import_or_apply_performed,
            diagnostics.embedding_available,
            diagnostics.provider_sync_available
        ),
    ];

    lines.extend(diagnostics.entries.into_iter().map(|entry| {
        format!(
            "entry memory_id={} plan_ref={} file_ref={} export_status={} policy_status={} policy_blockers={} export_blockers={}",
            entry.memory_id,
            entry.plan_ref,
            entry.file_ref.unwrap_or_else(|| "none".to_owned()),
            entry.export_status,
            entry.policy_status,
            blocker_list(entry.policy_blockers),
            blocker_list(entry.export_blockers)
        )
    }));

    lines
}

fn blocker_list(blockers: Vec<ControlAcceptedMemoryProjectionBlockerDto>) -> String {
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
