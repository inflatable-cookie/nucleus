use nucleus_server::{
    ControlProviderLiveReadExecutorDiagnosticsDto,
    ControlProviderLiveReadSmokeEvidenceDiagnosticsDto, ControlProviderReadIntentEntryDto,
    ControlProviderReadIntentQueryResultDto, ControlProviderReadinessOverviewDto,
};

pub(crate) fn provider_live_read_smoke_evidence_response_lines(
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

pub(crate) fn provider_live_read_executor_response_lines(
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

pub(crate) fn provider_readiness_overview_response_lines(
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
        format!(
            "live_read approved_smoke_evidence={}",
            overview.approved_live_read_smoke_evidence_count
        ),
    ];
    lines.extend(no_effect_lines(
        overview.no_effects.credential_resolution_performed,
        overview.no_effects.provider_network_call_performed,
        overview.no_effects.provider_effect_executed,
        overview.no_effects.callback_effect_executed,
        overview.no_effects.interruption_effect_executed,
        overview.no_effects.recovery_effect_executed,
        overview.no_effects.task_mutation_executed,
        overview.no_effects.raw_provider_payload_retained,
    ));
    lines
}

pub(crate) fn provider_read_intent_response_lines(
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
        result.no_effects.credential_resolution_performed,
        result.no_effects.provider_network_call_performed,
        result.no_effects.provider_effect_executed,
        result.no_effects.callback_effect_executed,
        result.no_effects.interruption_effect_executed,
        result.no_effects.recovery_effect_executed,
        result.no_effects.task_mutation_executed,
        result.no_effects.raw_provider_payload_retained,
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
            entry.no_effects.provider_network_call_performed
        ),
        format!(
            "  raw_provider_payload_retained={}",
            entry.no_effects.raw_provider_payload_retained
        ),
    ]
}
