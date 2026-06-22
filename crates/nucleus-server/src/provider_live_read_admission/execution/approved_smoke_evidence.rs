use super::{
    ProviderLiveReadApprovedSmokeEvidenceBlocker, ProviderLiveReadApprovedSmokeEvidenceDiagnostics,
    ProviderLiveReadApprovedSmokeEvidenceInput, ProviderLiveReadApprovedSmokeEvidenceRecord,
    ProviderLiveReadApprovedSmokeEvidenceStatus, ProviderLiveReadCommandResultMappingStatus,
    ProviderLiveReadCommandSmokeRequestStatus, ProviderLiveReadServerReceiptStatus,
};

pub fn provider_live_read_approved_smoke_evidence(
    input: ProviderLiveReadApprovedSmokeEvidenceInput,
) -> ProviderLiveReadApprovedSmokeEvidenceRecord {
    let evidence_id = format!(
        "provider-live-read-approved-smoke-evidence:{}",
        input.request.request_id
    );
    let duplicate = input.existing_evidence_ids.contains(&evidence_id);
    let blockers = evidence_blockers(&input, duplicate);
    let status = evidence_status(&blockers, duplicate);

    ProviderLiveReadApprovedSmokeEvidenceRecord {
        evidence_id,
        evidence_ref: input.evidence_ref,
        command_smoke_request_id: input.request.request_id,
        handoff_id: input.mapping.handoff_id,
        command_descriptor_id: input.mapping.command_descriptor_id,
        executor_request_id: input.mapping.executor_request_id,
        output_record_id: input.mapping.output.output_record_id,
        receipt_id: input.mapping.receipt.receipt_id,
        name_with_owner: input.mapping.output.name_with_owner,
        default_branch: input.mapping.output.default_branch,
        is_private: input.mapping.output.is_private,
        visibility: input.mapping.output.visibility,
        url: input.mapping.output.url,
        viewer_permission: input.mapping.output.viewer_permission,
        pushed_at: input.mapping.output.pushed_at,
        updated_at: input.mapping.output.updated_at,
        status,
        blockers,
        duplicate_evidence_detected: duplicate,
        provider_network_call_performed: input.mapping.provider_network_call_performed,
        provider_write_executed: input.provider_write_executed
            || input.mapping.provider_write_executed,
        callback_effect_executed: input.callback_effect_executed
            || input.mapping.callback_effect_executed,
        interruption_effect_executed: input.interruption_effect_executed
            || input.mapping.interruption_effect_executed,
        recovery_effect_executed: input.recovery_effect_executed
            || input.mapping.recovery_effect_executed,
        task_mutation_executed: input.task_mutation_executed
            || input.mapping.task_mutation_executed,
        raw_provider_payload_retained: input.raw_provider_payload_retained
            || input.mapping.raw_provider_payload_retained,
    }
}

pub fn provider_live_read_approved_smoke_evidence_diagnostics(
    records: Vec<ProviderLiveReadApprovedSmokeEvidenceRecord>,
) -> ProviderLiveReadApprovedSmokeEvidenceDiagnostics {
    ProviderLiveReadApprovedSmokeEvidenceDiagnostics {
        diagnostics_id: "provider-live-read-approved-smoke-evidence-diagnostics".to_owned(),
        evidence_count: records.len(),
        promoted_count: status_count(
            &records,
            ProviderLiveReadApprovedSmokeEvidenceStatus::Promoted,
        ),
        repair_required_count: status_count(
            &records,
            ProviderLiveReadApprovedSmokeEvidenceStatus::RepairRequired,
        ),
        blocked_count: status_count(
            &records,
            ProviderLiveReadApprovedSmokeEvidenceStatus::Blocked,
        ),
        duplicate_count: status_count(
            &records,
            ProviderLiveReadApprovedSmokeEvidenceStatus::DuplicateNoop,
        ),
        provider_network_read_performed_count: records
            .iter()
            .filter(|record| record.provider_network_call_performed)
            .count(),
        blocker_count: records.iter().map(|record| record.blockers.len()).sum(),
        provider_write_executed: records.iter().any(|record| record.provider_write_executed),
        callback_effect_executed: records.iter().any(|record| record.callback_effect_executed),
        interruption_effect_executed: records
            .iter()
            .any(|record| record.interruption_effect_executed),
        recovery_effect_executed: records.iter().any(|record| record.recovery_effect_executed),
        task_mutation_executed: records.iter().any(|record| record.task_mutation_executed),
        raw_provider_payload_retained: records
            .iter()
            .any(|record| record.raw_provider_payload_retained),
    }
}

fn evidence_blockers(
    input: &ProviderLiveReadApprovedSmokeEvidenceInput,
    duplicate: bool,
) -> Vec<ProviderLiveReadApprovedSmokeEvidenceBlocker> {
    let mut blockers = Vec::new();
    if duplicate {
        blockers.push(ProviderLiveReadApprovedSmokeEvidenceBlocker::DuplicateEvidence);
    }
    if input.request.status
        != ProviderLiveReadCommandSmokeRequestStatus::StoppedPendingExplicitExecution
    {
        blockers.push(ProviderLiveReadApprovedSmokeEvidenceBlocker::CommandSmokeRequestNotStopped);
    }
    if input.mapping.status != ProviderLiveReadCommandResultMappingStatus::MappedSanitizedOutput {
        blockers.push(ProviderLiveReadApprovedSmokeEvidenceBlocker::MappingNotSanitized);
    }
    if input.mapping.receipt.status != ProviderLiveReadServerReceiptStatus::ProviderReadPerformed {
        blockers
            .push(ProviderLiveReadApprovedSmokeEvidenceBlocker::ReceiptNotProviderReadPerformed);
    }
    if input.request.handoff_id != input.mapping.handoff_id {
        blockers.push(ProviderLiveReadApprovedSmokeEvidenceBlocker::RequestHandoffMismatch);
    }
    if input.evidence_ref.is_none() {
        blockers.push(ProviderLiveReadApprovedSmokeEvidenceBlocker::MissingEvidenceRef);
    }
    if input.provider_write_executed || input.mapping.provider_write_executed {
        blockers.push(ProviderLiveReadApprovedSmokeEvidenceBlocker::ProviderWriteExecuted);
    }
    if input.callback_effect_executed || input.mapping.callback_effect_executed {
        blockers.push(ProviderLiveReadApprovedSmokeEvidenceBlocker::CallbackEffectExecuted);
    }
    if input.interruption_effect_executed || input.mapping.interruption_effect_executed {
        blockers.push(ProviderLiveReadApprovedSmokeEvidenceBlocker::InterruptionEffectExecuted);
    }
    if input.recovery_effect_executed || input.mapping.recovery_effect_executed {
        blockers.push(ProviderLiveReadApprovedSmokeEvidenceBlocker::RecoveryEffectExecuted);
    }
    if input.task_mutation_executed || input.mapping.task_mutation_executed {
        blockers.push(ProviderLiveReadApprovedSmokeEvidenceBlocker::TaskMutationExecuted);
    }
    if input.raw_provider_payload_retained || input.mapping.raw_provider_payload_retained {
        blockers.push(ProviderLiveReadApprovedSmokeEvidenceBlocker::RawProviderPayloadRetained);
    }
    blockers
}

fn evidence_status(
    blockers: &[ProviderLiveReadApprovedSmokeEvidenceBlocker],
    duplicate: bool,
) -> ProviderLiveReadApprovedSmokeEvidenceStatus {
    if duplicate {
        ProviderLiveReadApprovedSmokeEvidenceStatus::DuplicateNoop
    } else if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            ProviderLiveReadApprovedSmokeEvidenceBlocker::CommandSmokeRequestNotStopped
                | ProviderLiveReadApprovedSmokeEvidenceBlocker::MappingNotSanitized
                | ProviderLiveReadApprovedSmokeEvidenceBlocker::ReceiptNotProviderReadPerformed
                | ProviderLiveReadApprovedSmokeEvidenceBlocker::RequestHandoffMismatch
                | ProviderLiveReadApprovedSmokeEvidenceBlocker::ProviderWriteExecuted
                | ProviderLiveReadApprovedSmokeEvidenceBlocker::CallbackEffectExecuted
                | ProviderLiveReadApprovedSmokeEvidenceBlocker::InterruptionEffectExecuted
                | ProviderLiveReadApprovedSmokeEvidenceBlocker::RecoveryEffectExecuted
                | ProviderLiveReadApprovedSmokeEvidenceBlocker::TaskMutationExecuted
                | ProviderLiveReadApprovedSmokeEvidenceBlocker::RawProviderPayloadRetained
        )
    }) {
        ProviderLiveReadApprovedSmokeEvidenceStatus::Blocked
    } else if blockers.is_empty() {
        ProviderLiveReadApprovedSmokeEvidenceStatus::Promoted
    } else {
        ProviderLiveReadApprovedSmokeEvidenceStatus::RepairRequired
    }
}

fn status_count(
    records: &[ProviderLiveReadApprovedSmokeEvidenceRecord],
    status: ProviderLiveReadApprovedSmokeEvidenceStatus,
) -> usize {
    records
        .iter()
        .filter(|record| record.status == status)
        .count()
}
