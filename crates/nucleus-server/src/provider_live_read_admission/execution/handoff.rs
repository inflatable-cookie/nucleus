use super::super::{ProviderLiveReadPersistenceRecord, ProviderLiveReadPersistenceStatus};
use super::types::{
    handoff_id, ProviderLiveReadStoppedHandoffBlocker, ProviderLiveReadStoppedHandoffInput,
    ProviderLiveReadStoppedHandoffRecord, ProviderLiveReadStoppedHandoffSet,
    ProviderLiveReadStoppedHandoffStatus,
};

pub fn provider_live_read_stopped_handoff(
    input: ProviderLiveReadStoppedHandoffInput,
) -> ProviderLiveReadStoppedHandoffSet {
    let mut records = input
        .persisted_live_reads
        .records
        .iter()
        .cloned()
        .map(|record| handoff_record(&input, record))
        .collect::<Vec<_>>();
    records.sort_by(|left, right| left.handoff_id.cmp(&right.handoff_id));

    ProviderLiveReadStoppedHandoffSet {
        handoff_set_id: format!(
            "provider-live-read-stopped-handoff:{}",
            input.persisted_live_reads.persistence_set_id
        ),
        ready_handoff_ids: ids_with_status(
            &records,
            ProviderLiveReadStoppedHandoffStatus::ReadyForFixtureResponse,
        ),
        blocked_handoff_ids: ids_with_status(
            &records,
            ProviderLiveReadStoppedHandoffStatus::Blocked,
        ),
        duplicate_handoff_ids: ids_with_status(
            &records,
            ProviderLiveReadStoppedHandoffStatus::DuplicateNoop,
        ),
        repair_required_handoff_ids: ids_with_status(
            &records,
            ProviderLiveReadStoppedHandoffStatus::RepairRequired,
        ),
        records,
        provider_network_call_performed: false,
        credential_resolution_performed: false,
        provider_write_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

fn handoff_record(
    input: &ProviderLiveReadStoppedHandoffInput,
    record: ProviderLiveReadPersistenceRecord,
) -> ProviderLiveReadStoppedHandoffRecord {
    let handoff_id = handoff_id(&record);
    let duplicate = input.existing_handoff_ids.contains(&handoff_id);
    let blockers = blockers(input, &record, duplicate);
    let status = status(&blockers, duplicate);
    let mut evidence_refs = record.evidence_refs.clone();
    if let Some(ref evidence_ref) = input.handoff_evidence_ref {
        evidence_refs.push(evidence_ref.clone());
    }
    evidence_refs.sort();
    evidence_refs.dedup();

    ProviderLiveReadStoppedHandoffRecord {
        handoff_id,
        persisted_live_read_id: record.persisted_live_read_id,
        execution_request_id: record.execution_request_id,
        provider_context_ref: record.provider_context_ref,
        operation_family: record.operation_family,
        target_refs: record.target_refs,
        request_ref: record.request_ref,
        planned_receipt_ref: record.planned_receipt_ref,
        credential_lease_ref: input.credential_lease_ref.clone(),
        network_read_authority_ref: input.network_read_authority_ref.clone(),
        fixture_client_ref: input.fixture_client_ref.clone(),
        capability_ref: input.capability.capability_ref.clone(),
        sanitization_policy_ref: input.sanitization_policy_ref.clone(),
        handoff_evidence_ref: input.handoff_evidence_ref.clone(),
        evidence_refs,
        status,
        blockers,
        duplicate_handoff_detected: duplicate,
        provider_network_call_performed: false,
        credential_resolution_performed: false,
        provider_write_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

fn blockers(
    input: &ProviderLiveReadStoppedHandoffInput,
    record: &ProviderLiveReadPersistenceRecord,
    duplicate: bool,
) -> Vec<ProviderLiveReadStoppedHandoffBlocker> {
    let mut blockers = Vec::new();
    if duplicate {
        blockers.push(ProviderLiveReadStoppedHandoffBlocker::DuplicateHandoff);
    }
    if record.persistence_status != ProviderLiveReadPersistenceStatus::Persisted {
        blockers.push(ProviderLiveReadStoppedHandoffBlocker::PersistedLiveReadNotReady);
    }
    if input.credential_lease_ref.is_none() {
        blockers.push(ProviderLiveReadStoppedHandoffBlocker::MissingCredentialLeaseRef);
    }
    if input.network_read_authority_ref.is_none() {
        blockers.push(ProviderLiveReadStoppedHandoffBlocker::MissingNetworkReadAuthorityRef);
    }
    if input.fixture_client_ref.is_none() {
        blockers.push(ProviderLiveReadStoppedHandoffBlocker::MissingFixtureClientRef);
    }
    if input.sanitization_policy_ref.is_none() {
        blockers.push(ProviderLiveReadStoppedHandoffBlocker::MissingSanitizationPolicyRef);
    }
    if input.handoff_evidence_ref.is_none() {
        blockers.push(ProviderLiveReadStoppedHandoffBlocker::MissingHandoffEvidenceRef);
    }
    if !input
        .capability
        .supported_operation_families
        .contains(&record.operation_family)
    {
        blockers
            .push(ProviderLiveReadStoppedHandoffBlocker::CapabilityDoesNotSupportOperationFamily);
    }
    effect_blockers(input, &mut blockers);
    blockers
}

fn effect_blockers(
    input: &ProviderLiveReadStoppedHandoffInput,
    blockers: &mut Vec<ProviderLiveReadStoppedHandoffBlocker>,
) {
    if input.credential_material_present {
        blockers.push(ProviderLiveReadStoppedHandoffBlocker::CredentialMaterialPresent);
    }
    if input.provider_payload_present {
        blockers.push(ProviderLiveReadStoppedHandoffBlocker::ProviderPayloadPresent);
    }
    if input.raw_provider_payload_retention_requested {
        blockers.push(ProviderLiveReadStoppedHandoffBlocker::RawProviderPayloadRetentionRequested);
    }
    if input.real_credential_resolution_requested {
        blockers.push(ProviderLiveReadStoppedHandoffBlocker::RealCredentialResolutionRequested);
    }
    if input.provider_network_call_requested {
        blockers.push(ProviderLiveReadStoppedHandoffBlocker::ProviderNetworkCallRequested);
    }
    if input.provider_write_requested {
        blockers.push(ProviderLiveReadStoppedHandoffBlocker::ProviderWriteRequested);
    }
    if input.callback_execution_requested {
        blockers.push(ProviderLiveReadStoppedHandoffBlocker::CallbackExecutionRequested);
    }
    if input.interruption_execution_requested {
        blockers.push(ProviderLiveReadStoppedHandoffBlocker::InterruptionExecutionRequested);
    }
    if input.recovery_execution_requested {
        blockers.push(ProviderLiveReadStoppedHandoffBlocker::RecoveryExecutionRequested);
    }
    if input.task_mutation_requested {
        blockers.push(ProviderLiveReadStoppedHandoffBlocker::TaskMutationRequested);
    }
}

fn status(
    blockers: &[ProviderLiveReadStoppedHandoffBlocker],
    duplicate: bool,
) -> ProviderLiveReadStoppedHandoffStatus {
    if duplicate {
        ProviderLiveReadStoppedHandoffStatus::DuplicateNoop
    } else if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            ProviderLiveReadStoppedHandoffBlocker::MissingCredentialLeaseRef
                | ProviderLiveReadStoppedHandoffBlocker::MissingNetworkReadAuthorityRef
                | ProviderLiveReadStoppedHandoffBlocker::MissingFixtureClientRef
                | ProviderLiveReadStoppedHandoffBlocker::MissingSanitizationPolicyRef
                | ProviderLiveReadStoppedHandoffBlocker::MissingHandoffEvidenceRef
        )
    }) {
        ProviderLiveReadStoppedHandoffStatus::RepairRequired
    } else if blockers.is_empty() {
        ProviderLiveReadStoppedHandoffStatus::ReadyForFixtureResponse
    } else {
        ProviderLiveReadStoppedHandoffStatus::Blocked
    }
}

fn ids_with_status(
    records: &[ProviderLiveReadStoppedHandoffRecord],
    status: ProviderLiveReadStoppedHandoffStatus,
) -> Vec<String> {
    records
        .iter()
        .filter(|record| record.status == status)
        .map(|record| record.handoff_id.clone())
        .collect()
}
