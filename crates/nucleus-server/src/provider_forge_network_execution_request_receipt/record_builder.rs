use crate::{ForgeNetworkExecutionPreflightRecord, ForgeNetworkExecutionPreflightStatus};

use super::types::{
    ForgeNetworkExecutionReceiptStatus, ForgeNetworkExecutionRequestReceiptBlocker,
    ForgeNetworkExecutionRequestReceiptInput, ForgeNetworkExecutionRequestReceiptRecord,
    ForgeNetworkExecutionRequestReceiptStatus,
};

pub(super) fn request_receipt_record(
    input: &ForgeNetworkExecutionRequestReceiptInput,
    preflight: ForgeNetworkExecutionPreflightRecord,
) -> ForgeNetworkExecutionRequestReceiptRecord {
    let blockers = blockers(input, &preflight);
    let status = status(&blockers);
    let receipt_status = receipt_status(&status);
    ForgeNetworkExecutionRequestReceiptRecord::from_preflight(
        preflight,
        input,
        status,
        receipt_status,
        blockers,
    )
}

fn blockers(
    input: &ForgeNetworkExecutionRequestReceiptInput,
    preflight: &ForgeNetworkExecutionPreflightRecord,
) -> Vec<ForgeNetworkExecutionRequestReceiptBlocker> {
    let mut blockers = Vec::new();
    if preflight.status != ForgeNetworkExecutionPreflightStatus::ReadyForStoppedExecutionRequest
        || !preflight.stopped_execution_request_permitted
    {
        blockers.push(ForgeNetworkExecutionRequestReceiptBlocker::PreflightNotReady);
    }
    required_ref_blockers(input, preflight, &mut blockers);
    forbidden_blockers(input, &mut blockers);
    blockers
}

fn required_ref_blockers(
    input: &ForgeNetworkExecutionRequestReceiptInput,
    preflight: &ForgeNetworkExecutionPreflightRecord,
    blockers: &mut Vec<ForgeNetworkExecutionRequestReceiptBlocker>,
) {
    if empty(input.execution_request_evidence_ref.as_deref()) {
        blockers
            .push(ForgeNetworkExecutionRequestReceiptBlocker::MissingExecutionRequestEvidenceRef);
    }
    if empty(input.runtime_receipt_ref.as_deref()) {
        blockers.push(ForgeNetworkExecutionRequestReceiptBlocker::MissingRuntimeReceiptRef);
    }
    if empty(preflight.provider_response_evidence_ref.as_deref()) {
        blockers
            .push(ForgeNetworkExecutionRequestReceiptBlocker::MissingProviderResponseEvidenceRef);
    }
    if empty(preflight.credential_use_evidence_ref.as_deref()) {
        blockers.push(ForgeNetworkExecutionRequestReceiptBlocker::MissingCredentialUseEvidenceRef);
    }
    if empty(preflight.idempotency_key.as_deref()) {
        blockers.push(ForgeNetworkExecutionRequestReceiptBlocker::MissingIdempotencyKey);
    }
    if empty(preflight.retry_policy_ref.as_deref()) {
        blockers.push(ForgeNetworkExecutionRequestReceiptBlocker::MissingRetryPolicyRef);
    }
    if empty(preflight.recovery_policy_ref.as_deref()) {
        blockers.push(ForgeNetworkExecutionRequestReceiptBlocker::MissingRecoveryPolicyRef);
    }
    if input.retry_of_receipt_ref.is_some() && empty(input.recovery_classification_ref.as_deref()) {
        blockers.push(ForgeNetworkExecutionRequestReceiptBlocker::MissingRecoveryClassificationRef);
    }
}

fn forbidden_blockers(
    input: &ForgeNetworkExecutionRequestReceiptInput,
    blockers: &mut Vec<ForgeNetworkExecutionRequestReceiptBlocker>,
) {
    if input.real_credential_resolution_requested {
        blockers
            .push(ForgeNetworkExecutionRequestReceiptBlocker::RealCredentialResolutionRequested);
    }
    if input.provider_network_call_requested {
        blockers.push(ForgeNetworkExecutionRequestReceiptBlocker::ProviderNetworkCallRequested);
    }
    if input.raw_provider_payload_retention_requested {
        blockers
            .push(ForgeNetworkExecutionRequestReceiptBlocker::RawProviderPayloadRetentionRequested);
    }
    if input.callback_execution_requested {
        blockers.push(ForgeNetworkExecutionRequestReceiptBlocker::CallbackExecutionRequested);
    }
    if input.interruption_execution_requested {
        blockers.push(ForgeNetworkExecutionRequestReceiptBlocker::InterruptionExecutionRequested);
    }
    if input.recovery_execution_requested {
        blockers.push(ForgeNetworkExecutionRequestReceiptBlocker::RecoveryExecutionRequested);
    }
    if input.task_mutation_requested {
        blockers.push(ForgeNetworkExecutionRequestReceiptBlocker::TaskMutationRequested);
    }
}

fn status(
    blockers: &[ForgeNetworkExecutionRequestReceiptBlocker],
) -> ForgeNetworkExecutionRequestReceiptStatus {
    if blockers.is_empty() {
        ForgeNetworkExecutionRequestReceiptStatus::StoppedRequestRecorded
    } else if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            ForgeNetworkExecutionRequestReceiptBlocker::PreflightNotReady
                | ForgeNetworkExecutionRequestReceiptBlocker::MissingExecutionRequestEvidenceRef
                | ForgeNetworkExecutionRequestReceiptBlocker::MissingRuntimeReceiptRef
                | ForgeNetworkExecutionRequestReceiptBlocker::MissingProviderResponseEvidenceRef
                | ForgeNetworkExecutionRequestReceiptBlocker::MissingCredentialUseEvidenceRef
                | ForgeNetworkExecutionRequestReceiptBlocker::MissingIdempotencyKey
                | ForgeNetworkExecutionRequestReceiptBlocker::MissingRetryPolicyRef
                | ForgeNetworkExecutionRequestReceiptBlocker::MissingRecoveryPolicyRef
                | ForgeNetworkExecutionRequestReceiptBlocker::MissingRecoveryClassificationRef
        )
    }) {
        ForgeNetworkExecutionRequestReceiptStatus::RepairRequired
    } else {
        ForgeNetworkExecutionRequestReceiptStatus::Blocked
    }
}

fn receipt_status(
    status: &ForgeNetworkExecutionRequestReceiptStatus,
) -> ForgeNetworkExecutionReceiptStatus {
    match status {
        ForgeNetworkExecutionRequestReceiptStatus::StoppedRequestRecorded => {
            ForgeNetworkExecutionReceiptStatus::AcceptedStopped
        }
        ForgeNetworkExecutionRequestReceiptStatus::RepairRequired => {
            ForgeNetworkExecutionReceiptStatus::RepairRequired
        }
        ForgeNetworkExecutionRequestReceiptStatus::Blocked => {
            ForgeNetworkExecutionReceiptStatus::Blocked
        }
    }
}

fn empty(value: Option<&str>) -> bool {
    value.unwrap_or_default().is_empty()
}
