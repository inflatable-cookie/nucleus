use super::command_smoke_types::{
    descriptor_ready, handoff_ready, ProviderLiveReadCommandSmokeApprovalBlocker,
    ProviderLiveReadCommandSmokeApprovalInput, ProviderLiveReadCommandSmokeApprovalRecord,
    ProviderLiveReadCommandSmokeApprovalStatus, ProviderLiveReadCommandSmokeDiagnostics,
    ProviderLiveReadCommandSmokeRequestBlocker, ProviderLiveReadCommandSmokeRequestInput,
    ProviderLiveReadCommandSmokeRequestRecord, ProviderLiveReadCommandSmokeRequestStatus,
    ProviderLiveReadCommandSmokeTargetBlocker, ProviderLiveReadCommandSmokeTargetInput,
    ProviderLiveReadCommandSmokeTargetRecord, ProviderLiveReadCommandSmokeTargetStatus,
};

pub fn provider_live_read_command_smoke_target(
    input: ProviderLiveReadCommandSmokeTargetInput,
) -> ProviderLiveReadCommandSmokeTargetRecord {
    let blockers = target_blockers(&input);
    let status = target_status(&blockers);

    ProviderLiveReadCommandSmokeTargetRecord {
        smoke_target_id: format!(
            "provider-live-read-command-smoke-target:{}",
            input.smoke_target_ref
        ),
        smoke_target_ref: input.smoke_target_ref,
        command_descriptor_id: input.descriptor.command_descriptor_id,
        handoff_id: input.handoff.handoff_id,
        executor_request_id: input.descriptor.executor_request_id,
        remote_repo_ref: input.descriptor.remote_repo_ref,
        executable: input.handoff.executable,
        argv: input.handoff.argv,
        smoke_target_evidence_ref: input.smoke_target_evidence_ref,
        status,
        blockers,
        provider_network_call_performed: false,
        provider_write_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

pub fn provider_live_read_command_smoke_approval(
    input: ProviderLiveReadCommandSmokeApprovalInput,
) -> ProviderLiveReadCommandSmokeApprovalRecord {
    let blockers = approval_blockers(&input);
    let status = approval_status(&blockers);

    ProviderLiveReadCommandSmokeApprovalRecord {
        checklist_id: format!(
            "provider-live-read-command-smoke-checklist:{}",
            input.target.smoke_target_id
        ),
        smoke_target_id: input.target.smoke_target_id,
        command_descriptor_id: input.target.command_descriptor_id,
        handoff_id: input.target.handoff_id,
        read_authority_ref: input.read_authority_ref,
        credential_lease_ref: input.credential_lease_ref,
        payload_policy_ref: input.payload_policy_ref,
        retention_policy_ref: input.retention_policy_ref,
        operator_approval_ref: input.operator_approval_ref,
        checklist_evidence_ref: input.checklist_evidence_ref,
        status,
        blockers,
        provider_network_call_performed: false,
        credential_resolution_performed: false,
        provider_write_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

pub fn provider_live_read_command_smoke_request(
    input: ProviderLiveReadCommandSmokeRequestInput,
) -> ProviderLiveReadCommandSmokeRequestRecord {
    let request_id = format!(
        "provider-live-read-command-smoke-request:{}",
        input.checklist.checklist_id
    );
    let duplicate = input.existing_request_ids.contains(&request_id);
    let blockers = request_blockers(&input, duplicate);
    let status = request_status(&input, &blockers, duplicate);

    ProviderLiveReadCommandSmokeRequestRecord {
        request_id,
        command_smoke_request_ref: input.command_smoke_request_ref,
        checklist_id: input.checklist.checklist_id,
        smoke_target_id: input.checklist.smoke_target_id,
        command_descriptor_id: input.checklist.command_descriptor_id,
        handoff_id: input.checklist.handoff_id,
        expected_command_line: input.expected_command_line,
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

pub fn provider_live_read_command_smoke_diagnostics(
    targets: Vec<ProviderLiveReadCommandSmokeTargetRecord>,
    approvals: Vec<ProviderLiveReadCommandSmokeApprovalRecord>,
    requests: Vec<ProviderLiveReadCommandSmokeRequestRecord>,
) -> ProviderLiveReadCommandSmokeDiagnostics {
    ProviderLiveReadCommandSmokeDiagnostics {
        diagnostics_id: "provider-live-read-command-smoke-diagnostics".to_owned(),
        target_count: targets.len(),
        selected_target_count: targets
            .iter()
            .filter(|record| record.status == ProviderLiveReadCommandSmokeTargetStatus::Selected)
            .count(),
        approval_checklist_count: approvals.len(),
        approval_required_count: approvals
            .iter()
            .filter(|record| {
                record.status == ProviderLiveReadCommandSmokeApprovalStatus::ApprovalRequired
            })
            .count()
            + requests
                .iter()
                .filter(|record| {
                    record.status == ProviderLiveReadCommandSmokeRequestStatus::ApprovalRequired
                })
                .count(),
        stopped_request_count: requests
            .iter()
            .filter(|record| {
                record.status
                    == ProviderLiveReadCommandSmokeRequestStatus::StoppedPendingExplicitExecution
            })
            .count(),
        blocked_count: targets
            .iter()
            .filter(|record| record.status == ProviderLiveReadCommandSmokeTargetStatus::Blocked)
            .count()
            + approvals
                .iter()
                .filter(|record| {
                    record.status == ProviderLiveReadCommandSmokeApprovalStatus::Blocked
                })
                .count()
            + requests
                .iter()
                .filter(|record| {
                    record.status == ProviderLiveReadCommandSmokeRequestStatus::Blocked
                })
                .count(),
        blocker_count: targets
            .iter()
            .map(|record| record.blockers.len())
            .sum::<usize>()
            + approvals
                .iter()
                .map(|record| record.blockers.len())
                .sum::<usize>()
            + requests
                .iter()
                .map(|record| record.blockers.len())
                .sum::<usize>(),
        provider_network_call_performed: targets
            .iter()
            .any(|record| record.provider_network_call_performed)
            || approvals
                .iter()
                .any(|record| record.provider_network_call_performed)
            || requests
                .iter()
                .any(|record| record.provider_network_call_performed),
        credential_resolution_performed: approvals
            .iter()
            .any(|record| record.credential_resolution_performed)
            || requests
                .iter()
                .any(|record| record.credential_resolution_performed),
        provider_write_executed: targets.iter().any(|record| record.provider_write_executed)
            || approvals
                .iter()
                .any(|record| record.provider_write_executed)
            || requests.iter().any(|record| record.provider_write_executed),
        task_mutation_executed: targets.iter().any(|record| record.task_mutation_executed)
            || approvals.iter().any(|record| record.task_mutation_executed)
            || requests.iter().any(|record| record.task_mutation_executed),
        raw_provider_payload_retained: targets
            .iter()
            .any(|record| record.raw_provider_payload_retained)
            || approvals
                .iter()
                .any(|record| record.raw_provider_payload_retained)
            || requests
                .iter()
                .any(|record| record.raw_provider_payload_retained),
    }
}

fn target_blockers(
    input: &ProviderLiveReadCommandSmokeTargetInput,
) -> Vec<ProviderLiveReadCommandSmokeTargetBlocker> {
    let mut blockers = Vec::new();
    if input.smoke_target_ref.is_empty() {
        blockers.push(ProviderLiveReadCommandSmokeTargetBlocker::MissingSmokeTargetRef);
    }
    if !descriptor_ready(&input.descriptor) {
        blockers.push(ProviderLiveReadCommandSmokeTargetBlocker::CommandDescriptorNotReady);
    }
    if !handoff_ready(&input.handoff) {
        blockers.push(ProviderLiveReadCommandSmokeTargetBlocker::CommandHandoffNotReady);
    }
    if input.descriptor.command_descriptor_id != input.handoff.command_descriptor_id {
        blockers.push(ProviderLiveReadCommandSmokeTargetBlocker::DescriptorHandoffMismatch);
    }
    if input.smoke_target_evidence_ref.is_none() {
        blockers.push(ProviderLiveReadCommandSmokeTargetBlocker::MissingSmokeTargetEvidenceRef);
    }
    if input.provider_write_requested {
        blockers.push(ProviderLiveReadCommandSmokeTargetBlocker::ProviderWriteRequested);
    }
    if input.task_mutation_requested {
        blockers.push(ProviderLiveReadCommandSmokeTargetBlocker::TaskMutationRequested);
    }
    if input.raw_provider_payload_retention_requested {
        blockers
            .push(ProviderLiveReadCommandSmokeTargetBlocker::RawProviderPayloadRetentionRequested);
    }
    blockers
}

fn approval_blockers(
    input: &ProviderLiveReadCommandSmokeApprovalInput,
) -> Vec<ProviderLiveReadCommandSmokeApprovalBlocker> {
    let mut blockers = Vec::new();
    if input.target.status != ProviderLiveReadCommandSmokeTargetStatus::Selected {
        blockers.push(ProviderLiveReadCommandSmokeApprovalBlocker::TargetNotSelected);
    }
    if input.read_authority_ref.is_none() {
        blockers.push(ProviderLiveReadCommandSmokeApprovalBlocker::MissingReadAuthorityRef);
    }
    if input.credential_lease_ref.is_none() {
        blockers.push(ProviderLiveReadCommandSmokeApprovalBlocker::MissingCredentialLeaseRef);
    }
    if input.payload_policy_ref.is_none() {
        blockers.push(ProviderLiveReadCommandSmokeApprovalBlocker::MissingPayloadPolicyRef);
    }
    if input.retention_policy_ref.is_none() {
        blockers.push(ProviderLiveReadCommandSmokeApprovalBlocker::MissingRetentionPolicyRef);
    }
    if input.operator_approval_ref.is_none() {
        blockers.push(ProviderLiveReadCommandSmokeApprovalBlocker::MissingOperatorApprovalRef);
    }
    if input.checklist_evidence_ref.is_none() {
        blockers.push(ProviderLiveReadCommandSmokeApprovalBlocker::MissingChecklistEvidenceRef);
    }
    if input.credential_material_present {
        blockers.push(ProviderLiveReadCommandSmokeApprovalBlocker::CredentialMaterialPresent);
    }
    if input.provider_write_requested {
        blockers.push(ProviderLiveReadCommandSmokeApprovalBlocker::ProviderWriteRequested);
    }
    if input.task_mutation_requested {
        blockers.push(ProviderLiveReadCommandSmokeApprovalBlocker::TaskMutationRequested);
    }
    if input.raw_provider_payload_retention_requested {
        blockers.push(
            ProviderLiveReadCommandSmokeApprovalBlocker::RawProviderPayloadRetentionRequested,
        );
    }
    blockers
}

fn request_blockers(
    input: &ProviderLiveReadCommandSmokeRequestInput,
    duplicate: bool,
) -> Vec<ProviderLiveReadCommandSmokeRequestBlocker> {
    let mut blockers = Vec::new();
    if duplicate {
        blockers.push(ProviderLiveReadCommandSmokeRequestBlocker::DuplicateRequest);
    }
    if input.checklist.status
        != ProviderLiveReadCommandSmokeApprovalStatus::ReadyForStoppedCommandSmokeRequest
    {
        blockers.push(ProviderLiveReadCommandSmokeRequestBlocker::ChecklistNotReady);
    }
    if input.checklist.operator_approval_ref.is_none() {
        blockers.push(ProviderLiveReadCommandSmokeRequestBlocker::MissingOperatorApprovalRef);
    }
    if input.command_smoke_request_ref.is_none() {
        blockers.push(ProviderLiveReadCommandSmokeRequestBlocker::MissingCommandSmokeRequestRef);
    }
    if input.expected_command_line.is_empty() {
        blockers.push(ProviderLiveReadCommandSmokeRequestBlocker::MissingExpectedCommandLine);
    }
    if input.request_evidence_ref.is_none() {
        blockers.push(ProviderLiveReadCommandSmokeRequestBlocker::MissingRequestEvidenceRef);
    }
    if input.provider_network_call_requested {
        blockers.push(ProviderLiveReadCommandSmokeRequestBlocker::ProviderNetworkCallRequested);
    }
    if input.credential_material_present {
        blockers.push(ProviderLiveReadCommandSmokeRequestBlocker::CredentialMaterialPresent);
    }
    if input.provider_write_requested {
        blockers.push(ProviderLiveReadCommandSmokeRequestBlocker::ProviderWriteRequested);
    }
    if input.task_mutation_requested {
        blockers.push(ProviderLiveReadCommandSmokeRequestBlocker::TaskMutationRequested);
    }
    if input.raw_provider_payload_retention_requested {
        blockers
            .push(ProviderLiveReadCommandSmokeRequestBlocker::RawProviderPayloadRetentionRequested);
    }
    blockers
}

fn target_status(
    blockers: &[ProviderLiveReadCommandSmokeTargetBlocker],
) -> ProviderLiveReadCommandSmokeTargetStatus {
    if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            ProviderLiveReadCommandSmokeTargetBlocker::CommandDescriptorNotReady
                | ProviderLiveReadCommandSmokeTargetBlocker::CommandHandoffNotReady
                | ProviderLiveReadCommandSmokeTargetBlocker::DescriptorHandoffMismatch
                | ProviderLiveReadCommandSmokeTargetBlocker::ProviderWriteRequested
                | ProviderLiveReadCommandSmokeTargetBlocker::TaskMutationRequested
                | ProviderLiveReadCommandSmokeTargetBlocker::RawProviderPayloadRetentionRequested
        )
    }) {
        ProviderLiveReadCommandSmokeTargetStatus::Blocked
    } else if blockers.is_empty() {
        ProviderLiveReadCommandSmokeTargetStatus::Selected
    } else {
        ProviderLiveReadCommandSmokeTargetStatus::RepairRequired
    }
}

fn approval_status(
    blockers: &[ProviderLiveReadCommandSmokeApprovalBlocker],
) -> ProviderLiveReadCommandSmokeApprovalStatus {
    if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            ProviderLiveReadCommandSmokeApprovalBlocker::MissingOperatorApprovalRef
        )
    }) {
        ProviderLiveReadCommandSmokeApprovalStatus::ApprovalRequired
    } else if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            ProviderLiveReadCommandSmokeApprovalBlocker::TargetNotSelected
                | ProviderLiveReadCommandSmokeApprovalBlocker::CredentialMaterialPresent
                | ProviderLiveReadCommandSmokeApprovalBlocker::ProviderWriteRequested
                | ProviderLiveReadCommandSmokeApprovalBlocker::TaskMutationRequested
                | ProviderLiveReadCommandSmokeApprovalBlocker::RawProviderPayloadRetentionRequested
        )
    }) {
        ProviderLiveReadCommandSmokeApprovalStatus::Blocked
    } else if blockers.is_empty() {
        ProviderLiveReadCommandSmokeApprovalStatus::ReadyForStoppedCommandSmokeRequest
    } else {
        ProviderLiveReadCommandSmokeApprovalStatus::RepairRequired
    }
}

fn request_status(
    input: &ProviderLiveReadCommandSmokeRequestInput,
    blockers: &[ProviderLiveReadCommandSmokeRequestBlocker],
    duplicate: bool,
) -> ProviderLiveReadCommandSmokeRequestStatus {
    if duplicate {
        ProviderLiveReadCommandSmokeRequestStatus::DuplicateNoop
    } else if input.checklist.operator_approval_ref.is_none() {
        ProviderLiveReadCommandSmokeRequestStatus::ApprovalRequired
    } else if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            ProviderLiveReadCommandSmokeRequestBlocker::ChecklistNotReady
                | ProviderLiveReadCommandSmokeRequestBlocker::ProviderNetworkCallRequested
                | ProviderLiveReadCommandSmokeRequestBlocker::CredentialMaterialPresent
                | ProviderLiveReadCommandSmokeRequestBlocker::ProviderWriteRequested
                | ProviderLiveReadCommandSmokeRequestBlocker::TaskMutationRequested
                | ProviderLiveReadCommandSmokeRequestBlocker::RawProviderPayloadRetentionRequested
        )
    }) {
        ProviderLiveReadCommandSmokeRequestStatus::Blocked
    } else if blockers.is_empty() {
        ProviderLiveReadCommandSmokeRequestStatus::StoppedPendingExplicitExecution
    } else {
        ProviderLiveReadCommandSmokeRequestStatus::RepairRequired
    }
}
