use super::types::{
    ProviderLiveReadFixtureResponseBlocker, ProviderLiveReadFixtureResponseInput,
    ProviderLiveReadFixtureResponseRecord, ProviderLiveReadFixtureResponseSet,
    ProviderLiveReadFixtureResponseStatus, ProviderLiveReadStoppedHandoffRecord,
    ProviderLiveReadStoppedHandoffStatus,
};

pub fn provider_live_read_fixture_responses(
    input: ProviderLiveReadFixtureResponseInput,
) -> ProviderLiveReadFixtureResponseSet {
    let mut records = input
        .handoffs
        .records
        .iter()
        .cloned()
        .map(|handoff| response_record(&input, handoff))
        .collect::<Vec<_>>();
    records.sort_by(|left, right| left.response_id.cmp(&right.response_id));

    ProviderLiveReadFixtureResponseSet {
        response_set_id: format!(
            "provider-live-read-fixture-response:{}",
            input.handoffs.handoff_set_id
        ),
        ready_response_ids: ids_with_status(
            &records,
            ProviderLiveReadFixtureResponseStatus::SanitizedResponseReady,
        ),
        blocked_response_ids: ids_with_status(
            &records,
            ProviderLiveReadFixtureResponseStatus::Blocked,
        ),
        retryable_response_ids: ids_with_status(
            &records,
            ProviderLiveReadFixtureResponseStatus::RetryableError,
        ),
        non_retryable_response_ids: ids_with_status(
            &records,
            ProviderLiveReadFixtureResponseStatus::NonRetryableError,
        ),
        duplicate_response_ids: ids_with_status(
            &records,
            ProviderLiveReadFixtureResponseStatus::DuplicateNoop,
        ),
        records,
        provider_network_call_performed: false,
        credential_resolution_performed: false,
        provider_write_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

fn response_record(
    input: &ProviderLiveReadFixtureResponseInput,
    handoff: ProviderLiveReadStoppedHandoffRecord,
) -> ProviderLiveReadFixtureResponseRecord {
    let response_id = format!("provider-live-read-fixture-response:{}", handoff.handoff_id);
    let duplicate = input.existing_response_ids.contains(&response_id);
    let blockers = blockers(input, &handoff, duplicate);
    let status = status(input, &blockers, duplicate);
    let mut evidence_refs = handoff.evidence_refs.clone();
    optional_push(&mut evidence_refs, &input.response_evidence_ref);
    optional_push(&mut evidence_refs, &input.retry_hint_ref);
    optional_push(&mut evidence_refs, &input.rate_limit_ref);
    optional_push(&mut evidence_refs, &input.cancellation_ref);
    evidence_refs.sort();
    evidence_refs.dedup();

    ProviderLiveReadFixtureResponseRecord {
        response_id,
        handoff_id: handoff.handoff_id,
        persisted_live_read_id: handoff.persisted_live_read_id,
        operation_family: handoff.operation_family,
        response_summary_ref: input.response_summary_ref.clone(),
        response_evidence_ref: input.response_evidence_ref.clone(),
        provider_status_class_ref: input.provider_status_class_ref.clone(),
        provider_error_class_ref: input.provider_error_class_ref.clone(),
        retry_hint_ref: input.retry_hint_ref.clone(),
        rate_limit_ref: input.rate_limit_ref.clone(),
        cancellation_ref: input.cancellation_ref.clone(),
        evidence_refs,
        status,
        blockers,
        duplicate_response_detected: duplicate,
        provider_network_call_performed: false,
        credential_resolution_performed: false,
        provider_write_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

fn blockers(
    input: &ProviderLiveReadFixtureResponseInput,
    handoff: &ProviderLiveReadStoppedHandoffRecord,
    duplicate: bool,
) -> Vec<ProviderLiveReadFixtureResponseBlocker> {
    let mut blockers = Vec::new();
    if duplicate {
        blockers.push(ProviderLiveReadFixtureResponseBlocker::DuplicateResponse);
    }
    if handoff.status != ProviderLiveReadStoppedHandoffStatus::ReadyForFixtureResponse {
        blockers.push(ProviderLiveReadFixtureResponseBlocker::HandoffNotReady);
    }
    if input.response_summary_ref.is_none() {
        blockers.push(ProviderLiveReadFixtureResponseBlocker::MissingResponseSummaryRef);
    }
    if input.response_evidence_ref.is_none() {
        blockers.push(ProviderLiveReadFixtureResponseBlocker::MissingResponseEvidenceRef);
    }
    if input.provider_status_class_ref.is_none() && input.provider_error_class_ref.is_none() {
        blockers.push(ProviderLiveReadFixtureResponseBlocker::MissingProviderStatusClassRef);
    }
    effect_blockers(input, &mut blockers);
    blockers
}

fn effect_blockers(
    input: &ProviderLiveReadFixtureResponseInput,
    blockers: &mut Vec<ProviderLiveReadFixtureResponseBlocker>,
) {
    if input.credential_material_present {
        blockers.push(ProviderLiveReadFixtureResponseBlocker::CredentialMaterialPresent);
    }
    if input.provider_payload_present {
        blockers.push(ProviderLiveReadFixtureResponseBlocker::ProviderPayloadPresent);
    }
    if input.raw_provider_payload_retention_requested {
        blockers.push(ProviderLiveReadFixtureResponseBlocker::RawProviderPayloadRetentionRequested);
    }
    if input.real_credential_resolution_requested {
        blockers.push(ProviderLiveReadFixtureResponseBlocker::RealCredentialResolutionRequested);
    }
    if input.provider_network_call_requested {
        blockers.push(ProviderLiveReadFixtureResponseBlocker::ProviderNetworkCallRequested);
    }
    if input.provider_write_requested {
        blockers.push(ProviderLiveReadFixtureResponseBlocker::ProviderWriteRequested);
    }
    if input.callback_execution_requested {
        blockers.push(ProviderLiveReadFixtureResponseBlocker::CallbackExecutionRequested);
    }
    if input.interruption_execution_requested {
        blockers.push(ProviderLiveReadFixtureResponseBlocker::InterruptionExecutionRequested);
    }
    if input.recovery_execution_requested {
        blockers.push(ProviderLiveReadFixtureResponseBlocker::RecoveryExecutionRequested);
    }
    if input.task_mutation_requested {
        blockers.push(ProviderLiveReadFixtureResponseBlocker::TaskMutationRequested);
    }
}

fn status(
    input: &ProviderLiveReadFixtureResponseInput,
    blockers: &[ProviderLiveReadFixtureResponseBlocker],
    duplicate: bool,
) -> ProviderLiveReadFixtureResponseStatus {
    if duplicate {
        ProviderLiveReadFixtureResponseStatus::DuplicateNoop
    } else if !blockers.is_empty() {
        ProviderLiveReadFixtureResponseStatus::Blocked
    } else if input.provider_error_class_ref.is_some() && input.retry_hint_ref.is_some() {
        ProviderLiveReadFixtureResponseStatus::RetryableError
    } else if input.provider_error_class_ref.is_some() {
        ProviderLiveReadFixtureResponseStatus::NonRetryableError
    } else {
        ProviderLiveReadFixtureResponseStatus::SanitizedResponseReady
    }
}

fn ids_with_status(
    records: &[ProviderLiveReadFixtureResponseRecord],
    status: ProviderLiveReadFixtureResponseStatus,
) -> Vec<String> {
    records
        .iter()
        .filter(|record| record.status == status)
        .map(|record| record.response_id.clone())
        .collect()
}

fn optional_push(values: &mut Vec<String>, value: &Option<String>) {
    if let Some(value) = value {
        values.push(value.clone());
    }
}
