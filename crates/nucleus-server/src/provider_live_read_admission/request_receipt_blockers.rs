use super::types::{
    ProviderLiveReadPreflightRecord, ProviderLiveReadPreflightStatus,
    ProviderLiveReadRequestReceiptBlocker, ProviderLiveReadRequestReceiptInput,
    ProviderLiveReadRequestReceiptStatus,
};

pub(super) fn blockers(
    input: &ProviderLiveReadRequestReceiptInput,
    preflight: &ProviderLiveReadPreflightRecord,
) -> Vec<ProviderLiveReadRequestReceiptBlocker> {
    let mut blockers = Vec::new();
    if preflight.status != ProviderLiveReadPreflightStatus::ReadyForRequestReceiptPlanning {
        blockers.push(ProviderLiveReadRequestReceiptBlocker::PreflightNotReady);
    }
    required_ref_blockers(input, &mut blockers);
    forbidden_blockers(input, &mut blockers);
    blockers
}

pub(super) fn status(
    blockers: &[ProviderLiveReadRequestReceiptBlocker],
    duplicate_request_detected: bool,
) -> ProviderLiveReadRequestReceiptStatus {
    if duplicate_request_detected {
        ProviderLiveReadRequestReceiptStatus::DuplicateNoop
    } else if blockers.is_empty() {
        ProviderLiveReadRequestReceiptStatus::PlannedRequestRecorded
    } else if blockers.iter().any(blocking_blocker) {
        ProviderLiveReadRequestReceiptStatus::Blocked
    } else {
        ProviderLiveReadRequestReceiptStatus::RepairRequired
    }
}

fn required_ref_blockers(
    input: &ProviderLiveReadRequestReceiptInput,
    blockers: &mut Vec<ProviderLiveReadRequestReceiptBlocker>,
) {
    if is_empty_ref(input.request_ref.as_deref()) {
        blockers.push(ProviderLiveReadRequestReceiptBlocker::MissingRequestRef);
    }
    if is_empty_ref(input.planned_receipt_ref.as_deref()) {
        blockers.push(ProviderLiveReadRequestReceiptBlocker::MissingPlannedReceiptRef);
    }
    if is_empty_ref(input.request_evidence_ref.as_deref()) {
        blockers.push(ProviderLiveReadRequestReceiptBlocker::MissingRequestEvidenceRef);
    }
}

fn forbidden_blockers(
    input: &ProviderLiveReadRequestReceiptInput,
    blockers: &mut Vec<ProviderLiveReadRequestReceiptBlocker>,
) {
    if input.credential_material_present {
        blockers.push(ProviderLiveReadRequestReceiptBlocker::CredentialMaterialPresent);
    }
    if input.provider_payload_present {
        blockers.push(ProviderLiveReadRequestReceiptBlocker::ProviderPayloadPresent);
    }
    if input.raw_provider_payload_retention_requested {
        blockers.push(ProviderLiveReadRequestReceiptBlocker::RawProviderPayloadRetentionRequested);
    }
    if input.real_credential_resolution_requested {
        blockers.push(ProviderLiveReadRequestReceiptBlocker::RealCredentialResolutionRequested);
    }
    if input.provider_network_call_requested {
        blockers.push(ProviderLiveReadRequestReceiptBlocker::ProviderNetworkCallRequested);
    }
    if input.provider_write_requested {
        blockers.push(ProviderLiveReadRequestReceiptBlocker::ProviderWriteRequested);
    }
    if input.callback_execution_requested {
        blockers.push(ProviderLiveReadRequestReceiptBlocker::CallbackExecutionRequested);
    }
    if input.interruption_execution_requested {
        blockers.push(ProviderLiveReadRequestReceiptBlocker::InterruptionExecutionRequested);
    }
    if input.recovery_execution_requested {
        blockers.push(ProviderLiveReadRequestReceiptBlocker::RecoveryExecutionRequested);
    }
    if input.task_mutation_requested {
        blockers.push(ProviderLiveReadRequestReceiptBlocker::TaskMutationRequested);
    }
}

fn blocking_blocker(blocker: &ProviderLiveReadRequestReceiptBlocker) -> bool {
    matches!(
        blocker,
        ProviderLiveReadRequestReceiptBlocker::PreflightNotReady
            | ProviderLiveReadRequestReceiptBlocker::CredentialMaterialPresent
            | ProviderLiveReadRequestReceiptBlocker::ProviderPayloadPresent
            | ProviderLiveReadRequestReceiptBlocker::RawProviderPayloadRetentionRequested
            | ProviderLiveReadRequestReceiptBlocker::RealCredentialResolutionRequested
            | ProviderLiveReadRequestReceiptBlocker::ProviderNetworkCallRequested
            | ProviderLiveReadRequestReceiptBlocker::ProviderWriteRequested
            | ProviderLiveReadRequestReceiptBlocker::CallbackExecutionRequested
            | ProviderLiveReadRequestReceiptBlocker::InterruptionExecutionRequested
            | ProviderLiveReadRequestReceiptBlocker::RecoveryExecutionRequested
            | ProviderLiveReadRequestReceiptBlocker::TaskMutationRequested
    )
}

fn is_empty_ref(value: Option<&str>) -> bool {
    value.unwrap_or_default().is_empty()
}
