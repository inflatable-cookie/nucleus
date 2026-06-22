use super::store::OUTCOME_PREFIX;
use super::types::{
    ForgeNetworkExecutionOutcomePersistenceBlocker, ForgeNetworkExecutionOutcomePersistenceInput,
    ForgeNetworkExecutionOutcomePersistenceRecord, ForgeNetworkExecutionOutcomePersistenceStatus,
    ForgeNetworkExecutionOutcomeStatus,
};
use crate::{ForgeNetworkExecutionRequestReceiptRecord, ForgeNetworkExecutionRequestReceiptStatus};

pub(super) fn outcome_record(
    input: &ForgeNetworkExecutionOutcomePersistenceInput,
    request_receipt: ForgeNetworkExecutionRequestReceiptRecord,
    persisted_outcome_id: String,
    duplicate_outcome_detected: bool,
    persistence_blockers: Vec<ForgeNetworkExecutionOutcomePersistenceBlocker>,
) -> ForgeNetworkExecutionOutcomePersistenceRecord {
    let persistence_status = if duplicate_outcome_detected {
        ForgeNetworkExecutionOutcomePersistenceStatus::DuplicateNoop
    } else if persistence_blockers.is_empty() {
        ForgeNetworkExecutionOutcomePersistenceStatus::Persisted
    } else {
        ForgeNetworkExecutionOutcomePersistenceStatus::Blocked
    };
    let outcome_status = outcome_status(
        input.requested_status.clone(),
        &request_receipt.status,
        duplicate_outcome_detected,
    );

    ForgeNetworkExecutionOutcomePersistenceRecord {
        persisted_outcome_id,
        execution_request_id: request_receipt.execution_request_id,
        receipt_id: request_receipt.receipt_id,
        preflight_id: request_receipt.preflight_id,
        admission_id: request_receipt.admission_id,
        request_id: request_receipt.request_id,
        task_id: request_receipt.task_id,
        repo_id: request_receipt.repo_id,
        operator_ref: request_receipt.operator_ref,
        operation_family: request_receipt.operation_family,
        forge_provider: request_receipt.forge_provider,
        credential_ref: request_receipt.credential_ref,
        network_authority_ref: request_receipt.network_authority_ref,
        operator_approval_ref: request_receipt.operator_approval_ref,
        idempotency_key: request_receipt.idempotency_key,
        retry_policy_ref: request_receipt.retry_policy_ref,
        recovery_policy_ref: request_receipt.recovery_policy_ref,
        sanitization_policy_ref: request_receipt.sanitization_policy_ref,
        provider_context_ref: request_receipt.provider_context_ref,
        target_provider_ref: request_receipt.target_provider_ref,
        credential_use_evidence_ref: request_receipt.credential_use_evidence_ref,
        preflight_evidence_ref: request_receipt.preflight_evidence_ref,
        provider_response_evidence_ref: request_receipt.provider_response_evidence_ref,
        execution_request_evidence_ref: request_receipt.execution_request_evidence_ref,
        runtime_receipt_ref: request_receipt.runtime_receipt_ref,
        retry_of_receipt_ref: request_receipt.retry_of_receipt_ref,
        recovery_classification_ref: request_receipt.recovery_classification_ref,
        request_receipt_status: request_receipt.status,
        request_receipt_blockers: request_receipt.blockers,
        receipt_status: request_receipt.receipt_status,
        outcome_status,
        persistence_status,
        persistence_blockers,
        duplicate_outcome_detected,
        inspected_ref_count: input.inspected_ref_count,
        evidence_refs: unique_sorted(input.evidence_refs.clone()),
        stopped_request_recorded: request_receipt.stopped_request_recorded,
        credential_resolution_performed: false,
        provider_network_call_performed: false,
        forge_effect_executed: false,
        provider_effect_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

pub(super) fn persisted_outcome_id(execution_request_id: &str) -> String {
    format!("{OUTCOME_PREFIX}{execution_request_id}")
}

fn outcome_status(
    requested: ForgeNetworkExecutionOutcomeStatus,
    request_status: &ForgeNetworkExecutionRequestReceiptStatus,
    duplicate: bool,
) -> ForgeNetworkExecutionOutcomeStatus {
    if duplicate {
        return ForgeNetworkExecutionOutcomeStatus::DuplicateNoop;
    }
    match request_status {
        ForgeNetworkExecutionRequestReceiptStatus::StoppedRequestRecorded => requested,
        ForgeNetworkExecutionRequestReceiptStatus::Blocked => {
            ForgeNetworkExecutionOutcomeStatus::Blocked
        }
        ForgeNetworkExecutionRequestReceiptStatus::RepairRequired => {
            ForgeNetworkExecutionOutcomeStatus::RepairRequired
        }
    }
}

fn unique_sorted(mut refs: Vec<String>) -> Vec<String> {
    refs.sort();
    refs.dedup();
    refs
}
