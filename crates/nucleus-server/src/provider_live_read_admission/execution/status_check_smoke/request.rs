use super::super::status_check_smoke_types::{
    ProviderLiveReadStatusCheckSmokeChecklistRecord,
    ProviderLiveReadStatusCheckSmokeChecklistStatus,
    ProviderLiveReadStatusCheckSmokeRequestBlocker, ProviderLiveReadStatusCheckSmokeRequestInput,
    ProviderLiveReadStatusCheckSmokeRequestRecord, ProviderLiveReadStatusCheckSmokeRequestStatus,
};

pub fn provider_live_read_status_check_smoke_request(
    input: ProviderLiveReadStatusCheckSmokeRequestInput,
) -> ProviderLiveReadStatusCheckSmokeRequestRecord {
    let request_id = format!(
        "provider-live-read-status-check-smoke-request:{}",
        input.checklist.checklist_id
    );
    let duplicate = input.existing_request_ids.contains(&request_id);
    let blockers = request_blockers(&input, duplicate);
    let status = request_status(&input, &blockers, duplicate);
    let expected_command_line = expected_command_line(&input.checklist);

    ProviderLiveReadStatusCheckSmokeRequestRecord {
        request_id,
        status_check_request_ref: input.status_check_request_ref,
        checklist_id: input.checklist.checklist_id,
        smoke_target_id: input.checklist.smoke_target_id,
        expected_command_line,
        request_evidence_ref: input.request_evidence_ref,
        status,
        blockers,
        duplicate_request_detected: duplicate,
        provider_network_call_performed: false,
        credential_resolution_performed: false,
        provider_write_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

fn request_blockers(
    input: &ProviderLiveReadStatusCheckSmokeRequestInput,
    duplicate: bool,
) -> Vec<ProviderLiveReadStatusCheckSmokeRequestBlocker> {
    let mut blockers = Vec::new();
    if duplicate {
        blockers.push(ProviderLiveReadStatusCheckSmokeRequestBlocker::DuplicateRequest);
    }
    if input.checklist.status
        != ProviderLiveReadStatusCheckSmokeChecklistStatus::ReadyForStoppedStatusCheckRequest
    {
        blockers.push(ProviderLiveReadStatusCheckSmokeRequestBlocker::ChecklistNotReady);
    }
    if input.checklist.operator_approval_ref.is_none() {
        blockers.push(ProviderLiveReadStatusCheckSmokeRequestBlocker::MissingOperatorApprovalRef);
    }
    if input.status_check_request_ref.is_none() {
        blockers.push(ProviderLiveReadStatusCheckSmokeRequestBlocker::MissingStatusCheckRequestRef);
    }
    if input.request_evidence_ref.is_none() {
        blockers.push(ProviderLiveReadStatusCheckSmokeRequestBlocker::MissingRequestEvidenceRef);
    }
    if input.checklist.remote_repo_ref.is_none() || input.checklist.pull_request_ref.is_none() {
        blockers.push(ProviderLiveReadStatusCheckSmokeRequestBlocker::MissingCommandTarget);
    }
    if input.provider_network_call_requested {
        blockers.push(ProviderLiveReadStatusCheckSmokeRequestBlocker::ProviderNetworkCallRequested);
    }
    if input.credential_material_present {
        blockers.push(ProviderLiveReadStatusCheckSmokeRequestBlocker::CredentialMaterialPresent);
    }
    if input.provider_write_requested {
        blockers.push(ProviderLiveReadStatusCheckSmokeRequestBlocker::ProviderWriteRequested);
    }
    if input.task_mutation_requested {
        blockers.push(ProviderLiveReadStatusCheckSmokeRequestBlocker::TaskMutationRequested);
    }
    if input.raw_provider_payload_retention_requested {
        blockers.push(
            ProviderLiveReadStatusCheckSmokeRequestBlocker::RawProviderPayloadRetentionRequested,
        );
    }
    blockers
}

fn request_status(
    input: &ProviderLiveReadStatusCheckSmokeRequestInput,
    blockers: &[ProviderLiveReadStatusCheckSmokeRequestBlocker],
    duplicate: bool,
) -> ProviderLiveReadStatusCheckSmokeRequestStatus {
    if duplicate {
        return ProviderLiveReadStatusCheckSmokeRequestStatus::DuplicateNoop;
    }
    if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            ProviderLiveReadStatusCheckSmokeRequestBlocker::ProviderNetworkCallRequested
                | ProviderLiveReadStatusCheckSmokeRequestBlocker::CredentialMaterialPresent
                | ProviderLiveReadStatusCheckSmokeRequestBlocker::ProviderWriteRequested
                | ProviderLiveReadStatusCheckSmokeRequestBlocker::TaskMutationRequested
                | ProviderLiveReadStatusCheckSmokeRequestBlocker::RawProviderPayloadRetentionRequested
        )
    }) {
        ProviderLiveReadStatusCheckSmokeRequestStatus::Blocked
    } else if input.checklist.operator_approval_ref.is_none() {
        ProviderLiveReadStatusCheckSmokeRequestStatus::ApprovalRequired
    } else if blockers.is_empty() {
        ProviderLiveReadStatusCheckSmokeRequestStatus::StoppedPendingExplicitExecution
    } else {
        ProviderLiveReadStatusCheckSmokeRequestStatus::RepairRequired
    }
}

fn expected_command_line(
    checklist: &ProviderLiveReadStatusCheckSmokeChecklistRecord,
) -> Vec<String> {
    match (&checklist.remote_repo_ref, &checklist.pull_request_ref) {
        (Some(remote_repo_ref), Some(pull_request_ref)) => vec![
            "gh".to_owned(),
            "pr".to_owned(),
            "checks".to_owned(),
            pull_request_ref.clone(),
            "-R".to_owned(),
            remote_repo_ref.clone(),
            "--json".to_owned(),
            checklist.json_fields.join(","),
        ],
        _ => Vec::new(),
    }
}
