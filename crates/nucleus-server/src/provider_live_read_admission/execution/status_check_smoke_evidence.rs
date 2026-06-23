use super::{
    ProviderLiveReadStatusCheckSmokeEvidenceBlocker,
    ProviderLiveReadStatusCheckSmokeEvidenceDiagnostics,
    ProviderLiveReadStatusCheckSmokeEvidenceInput, ProviderLiveReadStatusCheckSmokeEvidenceRecord,
    ProviderLiveReadStatusCheckSmokeEvidenceStatus, ProviderLiveReadStatusCheckSmokeRequestStatus,
};

pub fn provider_live_read_status_check_smoke_evidence(
    input: ProviderLiveReadStatusCheckSmokeEvidenceInput,
) -> ProviderLiveReadStatusCheckSmokeEvidenceRecord {
    let evidence_id = format!(
        "provider-live-read-status-check-smoke-evidence:{}",
        input.request.request_id
    );
    let blockers = evidence_blockers(&input);
    let status = evidence_status(&blockers);

    ProviderLiveReadStatusCheckSmokeEvidenceRecord {
        evidence_id,
        evidence_ref: input.evidence_ref,
        request_id: input.request.request_id,
        remote_repo_ref: command_arg_after(&input.request.expected_command_line, "-R"),
        pull_request_ref: input.request.expected_command_line.get(3).cloned(),
        selected_fields: command_arg_after(&input.request.expected_command_line, "--json")
            .map(|fields| {
                fields
                    .split(',')
                    .map(str::to_owned)
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default(),
        command_exit_code: input.command_exit_code,
        check_count: input.check_count,
        pass_count: input.pass_count,
        fail_count: input.fail_count,
        pending_count: input.pending_count,
        skipping_count: input.skipping_count,
        cancel_count: input.cancel_count,
        status,
        blockers,
        selected_command_scope_confirmed: input.selected_command_scope_confirmed,
        provider_network_call_performed: input.provider_network_call_performed,
        provider_write_executed: input.provider_write_executed,
        task_mutation_executed: input.task_mutation_executed,
        raw_provider_payload_retained: input.raw_provider_payload_retained,
    }
}

pub fn provider_live_read_status_check_smoke_evidence_diagnostics(
    records: Vec<ProviderLiveReadStatusCheckSmokeEvidenceRecord>,
) -> ProviderLiveReadStatusCheckSmokeEvidenceDiagnostics {
    ProviderLiveReadStatusCheckSmokeEvidenceDiagnostics {
        diagnostics_id: "provider-live-read-status-check-smoke-evidence-diagnostics".to_owned(),
        evidence_count: records.len(),
        promoted_count: evidence_status_count(
            &records,
            ProviderLiveReadStatusCheckSmokeEvidenceStatus::Promoted,
        ),
        repair_required_count: evidence_status_count(
            &records,
            ProviderLiveReadStatusCheckSmokeEvidenceStatus::RepairRequired,
        ),
        blocked_count: evidence_status_count(
            &records,
            ProviderLiveReadStatusCheckSmokeEvidenceStatus::Blocked,
        ),
        total_check_count: records.iter().map(|record| record.check_count).sum(),
        total_pass_count: records.iter().map(|record| record.pass_count).sum(),
        total_fail_count: records.iter().map(|record| record.fail_count).sum(),
        total_pending_count: records.iter().map(|record| record.pending_count).sum(),
        total_skipping_count: records.iter().map(|record| record.skipping_count).sum(),
        total_cancel_count: records.iter().map(|record| record.cancel_count).sum(),
        blocker_count: records.iter().map(|record| record.blockers.len()).sum(),
        provider_network_read_performed_count: records
            .iter()
            .filter(|record| record.provider_network_call_performed)
            .count(),
        provider_write_executed: records.iter().any(|record| record.provider_write_executed),
        task_mutation_executed: records.iter().any(|record| record.task_mutation_executed),
        raw_provider_payload_retained: records
            .iter()
            .any(|record| record.raw_provider_payload_retained),
    }
}

fn evidence_blockers(
    input: &ProviderLiveReadStatusCheckSmokeEvidenceInput,
) -> Vec<ProviderLiveReadStatusCheckSmokeEvidenceBlocker> {
    let mut blockers = Vec::new();

    if input.request.status
        != ProviderLiveReadStatusCheckSmokeRequestStatus::StoppedPendingExplicitExecution
    {
        blockers.push(ProviderLiveReadStatusCheckSmokeEvidenceBlocker::RequestNotStopped);
    }
    if input.evidence_ref.is_none() {
        blockers.push(ProviderLiveReadStatusCheckSmokeEvidenceBlocker::MissingEvidenceRef);
    }
    if !input.selected_command_scope_confirmed {
        blockers.push(
            ProviderLiveReadStatusCheckSmokeEvidenceBlocker::SelectedCommandScopeNotConfirmed,
        );
    }
    if !input.provider_network_call_performed {
        blockers.push(ProviderLiveReadStatusCheckSmokeEvidenceBlocker::ProviderReadNotPerformed);
    }
    if input.check_count == 0 {
        blockers.push(ProviderLiveReadStatusCheckSmokeEvidenceBlocker::EmptyCheckSet);
    }
    if input.pass_count
        + input.fail_count
        + input.pending_count
        + input.skipping_count
        + input.cancel_count
        != input.check_count
    {
        blockers.push(ProviderLiveReadStatusCheckSmokeEvidenceBlocker::CheckCountMismatch);
    }
    if input.provider_write_executed {
        blockers.push(ProviderLiveReadStatusCheckSmokeEvidenceBlocker::ProviderWriteExecuted);
    }
    if input.task_mutation_executed {
        blockers.push(ProviderLiveReadStatusCheckSmokeEvidenceBlocker::TaskMutationExecuted);
    }
    if input.raw_provider_payload_retained {
        blockers.push(ProviderLiveReadStatusCheckSmokeEvidenceBlocker::RawProviderPayloadRetained);
    }

    blockers
}

fn evidence_status(
    blockers: &[ProviderLiveReadStatusCheckSmokeEvidenceBlocker],
) -> ProviderLiveReadStatusCheckSmokeEvidenceStatus {
    if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            ProviderLiveReadStatusCheckSmokeEvidenceBlocker::RequestNotStopped
                | ProviderLiveReadStatusCheckSmokeEvidenceBlocker::SelectedCommandScopeNotConfirmed
                | ProviderLiveReadStatusCheckSmokeEvidenceBlocker::ProviderReadNotPerformed
                | ProviderLiveReadStatusCheckSmokeEvidenceBlocker::ProviderWriteExecuted
                | ProviderLiveReadStatusCheckSmokeEvidenceBlocker::TaskMutationExecuted
                | ProviderLiveReadStatusCheckSmokeEvidenceBlocker::RawProviderPayloadRetained
        )
    }) {
        ProviderLiveReadStatusCheckSmokeEvidenceStatus::Blocked
    } else if blockers.is_empty() {
        ProviderLiveReadStatusCheckSmokeEvidenceStatus::Promoted
    } else {
        ProviderLiveReadStatusCheckSmokeEvidenceStatus::RepairRequired
    }
}

fn evidence_status_count(
    records: &[ProviderLiveReadStatusCheckSmokeEvidenceRecord],
    status: ProviderLiveReadStatusCheckSmokeEvidenceStatus,
) -> usize {
    records
        .iter()
        .filter(|record| record.status == status)
        .count()
}

fn command_arg_after(command_line: &[String], flag: &str) -> Option<String> {
    command_line
        .iter()
        .position(|part| part == flag)
        .and_then(|position| command_line.get(position + 1))
        .cloned()
}
