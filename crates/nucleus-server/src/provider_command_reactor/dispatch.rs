use super::types::{
    ProviderCommandAdmissionRecord, ProviderCommandAdmissionStatus,
    ProviderCommandDispatchAttemptId, ProviderCommandDispatchAttemptRecord,
    ProviderCommandDispatchAttemptStatus, ProviderCommandDispatchMode, ProviderCommandQueueEntryId,
    ProviderCommandQueueState, ProviderCommandReactorError, ProviderQueuedCommandRecord,
};

/// Queue an accepted provider command admission for dry-run dispatch.
pub fn queue_provider_command(
    admission: &ProviderCommandAdmissionRecord,
) -> Result<ProviderQueuedCommandRecord, ProviderCommandReactorError> {
    if admission.status != ProviderCommandAdmissionStatus::AcceptedForDryRun {
        return Err(ProviderCommandReactorError::AdmissionNotAccepted);
    }

    Ok(ProviderQueuedCommandRecord {
        queue_entry_id: ProviderCommandQueueEntryId(format!(
            "provider-command-queue:{}",
            admission.command_id.0
        )),
        admission_id: admission.admission_id.clone(),
        command_id: admission.command_id.clone(),
        reactor_id: admission.reactor_id.clone(),
        service_id: admission.service_id.clone(),
        command_lane_id: admission.command_lane_id.clone(),
        stream_id: admission.stream_id.clone(),
        family: admission.family.clone(),
        state: ProviderCommandQueueState::QueuedForDryRun,
        live_send_permitted: false,
        task_mutation_permitted: false,
    })
}

/// Record a dry-run dispatch attempt for a queued provider command.
pub fn provider_command_dispatch_attempt(
    queued: &ProviderQueuedCommandRecord,
    evidence_refs: Vec<String>,
) -> Result<ProviderCommandDispatchAttemptRecord, ProviderCommandReactorError> {
    if queued.state != ProviderCommandQueueState::QueuedForDryRun {
        return Err(ProviderCommandReactorError::QueueEntryNotDispatchable);
    }

    Ok(ProviderCommandDispatchAttemptRecord {
        attempt_id: ProviderCommandDispatchAttemptId(format!(
            "provider-command-dispatch:{}",
            queued.command_id.0
        )),
        queue_entry_id: queued.queue_entry_id.clone(),
        command_id: queued.command_id.clone(),
        reactor_id: queued.reactor_id.clone(),
        service_id: queued.service_id.clone(),
        command_lane_id: queued.command_lane_id.clone(),
        stream_id: queued.stream_id.clone(),
        family: queued.family.clone(),
        mode: ProviderCommandDispatchMode::DryRunOnly,
        status: ProviderCommandDispatchAttemptStatus::DryRunCompleted,
        live_send_attempted: false,
        task_mutation_attempted: false,
        evidence_refs,
    })
}
