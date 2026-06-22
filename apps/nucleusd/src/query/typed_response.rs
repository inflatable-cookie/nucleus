use nucleus_server::{
    ControlCommandEvidenceRecordDto, ControlProviderLiveReadExecutorDiagnosticsDto,
    ControlProviderLiveReadSmokeEvidenceDiagnosticsDto, ControlProviderReadIntentEntryDto,
    ControlProviderReadIntentQueryResultDto, ControlProviderReadinessOverviewDto,
    ControlResponseBodyDto, ControlResponseEnvelopeDto,
};

pub(super) fn print_typed_dto_response(
    label: &str,
    dto: ControlResponseEnvelopeDto,
) -> Result<(), String> {
    if dto.status != nucleus_server::ControlResponseStatusDto::Complete {
        return Err(format!("{label} query returned status {:?}", dto.status));
    }

    match dto.body {
        ControlResponseBodyDto::CommandEvidenceRecords { records } => {
            print_lines(command_evidence_response_lines(label, records));
            Ok(())
        }
        ControlResponseBodyDto::ProviderReadIntent { result } => {
            print_lines(provider_read_intent_response_lines(label, result));
            Ok(())
        }
        ControlResponseBodyDto::ProviderReadinessOverview { overview } => {
            print_lines(provider_readiness_overview_response_lines(label, overview));
            Ok(())
        }
        ControlResponseBodyDto::ProviderLiveReadExecutorDiagnostics { diagnostics } => {
            print_lines(provider_live_read_executor_response_lines(
                label,
                diagnostics,
            ));
            Ok(())
        }
        ControlResponseBodyDto::ProviderLiveReadSmokeEvidenceDiagnostics { diagnostics } => {
            print_lines(provider_live_read_smoke_evidence_response_lines(
                label,
                diagnostics,
            ));
            Ok(())
        }
        ControlResponseBodyDto::Error { kind, reason } => {
            Err(format!("{label} query failed: {kind}: {reason}"))
        }
        body => Err(format!(
            "{label} query returned unexpected DTO response: {body:?}"
        )),
    }
}

pub(super) fn provider_live_read_smoke_evidence_response_lines(
    label: &str,
    diagnostics: ControlProviderLiveReadSmokeEvidenceDiagnosticsDto,
) -> Vec<String> {
    vec![
        format!("domain={label}"),
        format!("diagnostics_id={}", diagnostics.diagnostics_id),
        format!("records={}", diagnostics.evidence_count),
        format!(
            "counts promoted={} repair_required={} blocked={} duplicate={} provider_network_reads={} blockers={}",
            diagnostics.promoted_count,
            diagnostics.repair_required_count,
            diagnostics.blocked_count,
            diagnostics.duplicate_count,
            diagnostics.provider_network_read_performed_count,
            diagnostics.blocker_count
        ),
        format!(
            "provider_write_executed={}",
            diagnostics.provider_write_executed
        ),
        format!(
            "callback_effect_executed={}",
            diagnostics.callback_effect_executed
        ),
        format!(
            "interruption_effect_executed={}",
            diagnostics.interruption_effect_executed
        ),
        format!(
            "recovery_effect_executed={}",
            diagnostics.recovery_effect_executed
        ),
        format!("task_mutation_executed={}", diagnostics.task_mutation_executed),
        format!(
            "raw_provider_payload_retained={}",
            diagnostics.raw_provider_payload_retained
        ),
    ]
}

pub(super) fn provider_live_read_executor_response_lines(
    label: &str,
    diagnostics: ControlProviderLiveReadExecutorDiagnosticsDto,
) -> Vec<String> {
    vec![
        format!("domain={label}"),
        format!("diagnostics_id={}", diagnostics.diagnostics_id),
        format!("records={}", diagnostics.request_count),
        format!(
            "counts ready={} blocked={} descriptors_ready={} sanitized_outputs={} parse_errors={} receipts={} provider_network_reads={} blockers={}",
            diagnostics.ready_request_count,
            diagnostics.blocked_request_count,
            diagnostics.descriptor_ready_count,
            diagnostics.sanitized_output_count,
            diagnostics.parse_error_count,
            diagnostics.receipt_count,
            diagnostics.provider_network_read_performed_count,
            diagnostics.blocker_count
        ),
        format!(
            "provider_write_executed={}",
            diagnostics.provider_write_executed
        ),
        format!(
            "callback_effect_executed={}",
            diagnostics.callback_effect_executed
        ),
        format!(
            "interruption_effect_executed={}",
            diagnostics.interruption_effect_executed
        ),
        format!(
            "recovery_effect_executed={}",
            diagnostics.recovery_effect_executed
        ),
        format!("task_mutation_executed={}", diagnostics.task_mutation_executed),
        format!(
            "raw_provider_payload_retained={}",
            diagnostics.raw_provider_payload_retained
        ),
    ]
}

fn print_lines(lines: Vec<String>) {
    for line in lines {
        println!("{line}");
    }
}

pub(super) fn provider_readiness_overview_response_lines(
    label: &str,
    overview: ControlProviderReadinessOverviewDto,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("overview_id={}", overview.overview_id),
        format!("projection_id={}", overview.projection_id),
        format!("status={}", overview.status),
        format!("records={}", overview.total_read_intent_count),
        format!(
            "families supported={} represented={} mutating={}",
            overview.supported_read_families.len(),
            overview.represented_read_families.len(),
            overview.represented_mutating_families.len()
        ),
        format!(
            "counts ready={} blocked={} repair_required={} duplicate_noop={} missing_evidence_families={} blockers={} evidence_refs={}",
            overview.ready_count,
            overview.blocked_count,
            overview.repair_required_count,
            overview.duplicate_noop_count,
            overview.missing_evidence_family_count,
            overview.blocker_count,
            overview.evidence_ref_count
        ),
        format!(
            "refs provider_instances={} remote_repos={} forge_providers={}",
            overview.provider_instance_refs.len(),
            overview.remote_repo_refs.len(),
            overview.forge_providers.len()
        ),
    ];
    lines.extend(no_effect_lines(
        overview.credential_resolution_performed,
        overview.provider_network_call_performed,
        overview.provider_effect_executed,
        overview.callback_effect_executed,
        overview.interruption_effect_executed,
        overview.recovery_effect_executed,
        overview.task_mutation_executed,
        overview.raw_provider_payload_retained,
    ));
    lines
}

pub(super) fn provider_read_intent_response_lines(
    label: &str,
    result: ControlProviderReadIntentQueryResultDto,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("query_id={}", result.query_id),
        format!("projection_id={}", result.projection.projection_id),
        format!("records={}", result.projection.total_count),
        format!(
            "source_counts credential_status={} repository_metadata={} pull_request={}",
            result.source_counts.credential_status_records,
            result.source_counts.repository_metadata_records,
            result.source_counts.pull_request_records
        ),
        format!(
            "counts ready={} blocked={} repair_required={} duplicate_noop={} blockers={} evidence_refs={}",
            result.projection.ready_count,
            result.projection.blocked_count,
            result.projection.repair_required_count,
            result.projection.duplicate_noop_count,
            result.projection.blocker_count,
            result.projection.evidence_ref_count
        ),
    ];
    lines.extend(no_effect_lines(
        result.credential_resolution_performed,
        result.provider_network_call_performed,
        result.provider_effect_executed,
        result.callback_effect_executed,
        result.interruption_effect_executed,
        result.recovery_effect_executed,
        result.task_mutation_executed,
        result.raw_provider_payload_retained,
    ));
    for entry in result.projection.entries {
        lines.extend(provider_read_intent_entry_lines(entry));
    }
    lines
}

fn no_effect_lines(
    credential_resolution_performed: bool,
    provider_network_call_performed: bool,
    provider_effect_executed: bool,
    callback_effect_executed: bool,
    interruption_effect_executed: bool,
    recovery_effect_executed: bool,
    task_mutation_executed: bool,
    raw_provider_payload_retained: bool,
) -> Vec<String> {
    vec![
        format!("credential_resolution_performed={credential_resolution_performed}"),
        format!("provider_network_call_performed={provider_network_call_performed}"),
        format!("provider_effect_executed={provider_effect_executed}"),
        format!("callback_effect_executed={callback_effect_executed}"),
        format!("interruption_effect_executed={interruption_effect_executed}"),
        format!("recovery_effect_executed={recovery_effect_executed}"),
        format!("task_mutation_executed={task_mutation_executed}"),
        format!("raw_provider_payload_retained={raw_provider_payload_retained}"),
    ]
}

fn provider_read_intent_entry_lines(entry: ControlProviderReadIntentEntryDto) -> Vec<String> {
    vec![
        format!("intent id={} family={}", entry.intent_id, entry.family),
        format!("  status={}", entry.status),
        format!(
            "  source_persisted_refresh_id={}",
            entry.source_persisted_refresh_id
        ),
        format!(
            "  provider_context_ref={}",
            entry.provider_context_ref.as_deref().unwrap_or("none")
        ),
        format!(
            "  provider_instance_ref={}",
            entry.provider_instance_ref.as_deref().unwrap_or("none")
        ),
        format!(
            "  forge_provider={}",
            entry.forge_provider.as_deref().unwrap_or("none")
        ),
        format!(
            "  remote_repo_ref={}",
            entry.remote_repo_ref.as_deref().unwrap_or("none")
        ),
        format!("  operation_family={}", entry.operation_family),
        format!("  blockers={}", entry.blocker_count),
        format!("  evidence_refs={}", entry.evidence_ref_count),
        format!(
            "  provider_network_call_performed={}",
            entry.provider_network_call_performed
        ),
        format!(
            "  raw_provider_payload_retained={}",
            entry.raw_provider_payload_retained
        ),
    ]
}

pub(super) fn command_evidence_response_lines(
    label: &str,
    records: Vec<ControlCommandEvidenceRecordDto>,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("records={}", records.len()),
    ];
    for record in records {
        lines.extend(command_evidence_record_lines(record));
    }
    lines
}

fn command_evidence_record_lines(record: ControlCommandEvidenceRecordDto) -> Vec<String> {
    let mut lines = vec![
        format!("record evidence_id={}", record.evidence_id),
        format!("  request_id={}", record.command_request_id),
        format!("  status={}", record.status),
        format!("  retention={}", record.retention),
    ];
    match record.exit_status {
        Some(status) => lines.push(format!("  exit_status={status}")),
        None => lines.push("  exit_status=none".to_owned()),
    }
    lines.push(format!(
        "  stdout_artifact_ref={}",
        record.stdout_artifact_ref.as_deref().unwrap_or("none")
    ));
    lines.push(format!(
        "  stderr_artifact_ref={}",
        record.stderr_artifact_ref.as_deref().unwrap_or("none")
    ));
    lines.push("  raw_output=not_retained".to_owned());
    if let Some(summary) = record.summary {
        lines.push(format!("  summary={summary}"));
    }
    lines
}
