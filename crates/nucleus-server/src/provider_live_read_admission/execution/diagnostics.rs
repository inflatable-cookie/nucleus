use super::types::{
    ProviderLiveReadExecutionDiagnostics, ProviderLiveReadFixtureResponseRecord,
    ProviderLiveReadFixtureResponseStatus,
};

pub fn provider_live_read_execution_diagnostics_from_responses(
    records: Vec<ProviderLiveReadFixtureResponseRecord>,
) -> ProviderLiveReadExecutionDiagnostics {
    ProviderLiveReadExecutionDiagnostics {
        diagnostics_id: "provider-live-read-execution-diagnostics".to_owned(),
        response_count: records.len(),
        ready_count: status_count(
            &records,
            ProviderLiveReadFixtureResponseStatus::SanitizedResponseReady,
        ),
        blocked_count: status_count(&records, ProviderLiveReadFixtureResponseStatus::Blocked),
        retryable_error_count: status_count(
            &records,
            ProviderLiveReadFixtureResponseStatus::RetryableError,
        ),
        non_retryable_error_count: status_count(
            &records,
            ProviderLiveReadFixtureResponseStatus::NonRetryableError,
        ),
        duplicate_noop_count: status_count(
            &records,
            ProviderLiveReadFixtureResponseStatus::DuplicateNoop,
        ),
        blocker_count: records.iter().map(|record| record.blockers.len()).sum(),
        evidence_ref_count: records
            .iter()
            .map(|record| record.evidence_refs.len())
            .sum(),
        provider_network_call_performed: false,
        credential_resolution_performed: false,
        provider_write_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

fn status_count(
    records: &[ProviderLiveReadFixtureResponseRecord],
    status: ProviderLiveReadFixtureResponseStatus,
) -> usize {
    records
        .iter()
        .filter(|record| record.status == status)
        .count()
}
