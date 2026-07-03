use nucleus_server::ControlPlanningCapturePublicationDiagnosticsDto;

pub(crate) fn planning_capture_publication_response_lines(
    label: &str,
    diagnostics: ControlPlanningCapturePublicationDiagnosticsDto,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("diagnostics_id={}", diagnostics.diagnostics_id),
        format!("records={}", diagnostics.request_count),
        format!(
            "counts persisted={} duplicates={} blocked={} blockers={} evidence_refs={} file_refs={}",
            diagnostics.persisted_request_count,
            diagnostics.duplicate_request_count,
            diagnostics.blocked_request_count,
            diagnostics.blocker_count,
            diagnostics.evidence_ref_count,
            diagnostics.management_file_ref_count
        ),
        format!(
            "command_execution_permitted={}",
            diagnostics.command_execution_permitted
        ),
        format!(
            "runner_handoff_permitted={}",
            diagnostics.runner_handoff_permitted
        ),
        format!("commit_permitted={}", diagnostics.commit_permitted),
        format!("snapshot_permitted={}", diagnostics.snapshot_permitted),
        format!("publish_permitted={}", diagnostics.publish_permitted),
        format!("push_permitted={}", diagnostics.push_permitted),
        format!("forge_share_permitted={}", diagnostics.forge_share_permitted),
        format!(
            "provider_write_permitted={}",
            diagnostics.provider_write_permitted
        ),
        format!(
            "projection_import_permitted={}",
            diagnostics.projection_import_permitted
        ),
        format!(
            "task_promotion_permitted={}",
            diagnostics.task_promotion_permitted
        ),
        format!(
            "callback_response_permitted={}",
            diagnostics.callback_response_permitted
        ),
        format!(
            "interruption_permitted={}",
            diagnostics.interruption_permitted
        ),
        format!("recovery_permitted={}", diagnostics.recovery_permitted),
        format!("raw_payload_retained={}", diagnostics.raw_payload_retained),
        "payloads_exposed=false".to_owned(),
    ];

    lines.extend(
        diagnostics
            .adapter_family_buckets
            .into_iter()
            .map(|bucket| {
                format!(
                    "adapter_family label={} count={}",
                    bucket.label, bucket.count
                )
            }),
    );
    lines.extend(
        diagnostics
            .operation_buckets
            .into_iter()
            .map(|bucket| format!("operation label={} count={}", bucket.label, bucket.count)),
    );

    lines
}
