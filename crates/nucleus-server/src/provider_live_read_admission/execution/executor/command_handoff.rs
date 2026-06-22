use super::super::executor_types::{
    ProviderLiveReadCommandHandoffBlocker, ProviderLiveReadCommandHandoffInput,
    ProviderLiveReadCommandHandoffRecord, ProviderLiveReadCommandHandoffStatus,
    ProviderLiveReadGhCommandDescriptorStatus,
};

pub fn provider_live_read_command_handoff(
    input: ProviderLiveReadCommandHandoffInput,
) -> ProviderLiveReadCommandHandoffRecord {
    let handoff_id = format!(
        "provider-live-read-command-handoff:{}",
        input.descriptor.command_descriptor_id
    );
    let duplicate = input.existing_handoff_ids.contains(&handoff_id);
    let blockers = blockers(&input, duplicate);
    let status = status(&blockers, duplicate);

    ProviderLiveReadCommandHandoffRecord {
        handoff_id,
        command_handoff_ref: input.command_handoff_ref,
        command_descriptor_id: input.descriptor.command_descriptor_id,
        executor_request_id: input.descriptor.executor_request_id,
        executable: input.descriptor.executable,
        argv: input.descriptor.args,
        working_directory_hint: input.working_directory_hint,
        timeout_ms: input.timeout_ms,
        stdout_limit_bytes: input.stdout_limit_bytes,
        stderr_limit_bytes: input.stderr_limit_bytes,
        status,
        blockers,
        duplicate_handoff_detected: duplicate,
        provider_network_call_performed: false,
        provider_write_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

fn blockers(
    input: &ProviderLiveReadCommandHandoffInput,
    duplicate: bool,
) -> Vec<ProviderLiveReadCommandHandoffBlocker> {
    let mut blockers = Vec::new();
    if duplicate {
        blockers.push(ProviderLiveReadCommandHandoffBlocker::DuplicateHandoff);
    }
    if input.descriptor.status != ProviderLiveReadGhCommandDescriptorStatus::ReadyForReadOnlySpawn {
        blockers.push(ProviderLiveReadCommandHandoffBlocker::CommandDescriptorNotReady);
    }
    if input.command_handoff_ref.is_none() {
        blockers.push(ProviderLiveReadCommandHandoffBlocker::MissingCommandHandoffRef);
    }
    if input.working_directory_hint.is_none() {
        blockers.push(ProviderLiveReadCommandHandoffBlocker::MissingWorkingDirectoryHint);
    }
    if input.timeout_ms.is_none() {
        blockers.push(ProviderLiveReadCommandHandoffBlocker::MissingTimeout);
    }
    if input.stdout_limit_bytes.is_none() {
        blockers.push(ProviderLiveReadCommandHandoffBlocker::MissingStdoutLimit);
    }
    if input.stderr_limit_bytes.is_none() {
        blockers.push(ProviderLiveReadCommandHandoffBlocker::MissingStderrLimit);
    }
    if input.provider_write_requested {
        blockers.push(ProviderLiveReadCommandHandoffBlocker::ProviderWriteRequested);
    }
    if input.task_mutation_requested {
        blockers.push(ProviderLiveReadCommandHandoffBlocker::TaskMutationRequested);
    }
    if input.raw_provider_payload_retention_requested {
        blockers.push(ProviderLiveReadCommandHandoffBlocker::RawProviderPayloadRetentionRequested);
    }
    blockers
}

fn status(
    blockers: &[ProviderLiveReadCommandHandoffBlocker],
    duplicate: bool,
) -> ProviderLiveReadCommandHandoffStatus {
    if duplicate {
        ProviderLiveReadCommandHandoffStatus::DuplicateNoop
    } else if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            ProviderLiveReadCommandHandoffBlocker::CommandDescriptorNotReady
                | ProviderLiveReadCommandHandoffBlocker::ProviderWriteRequested
                | ProviderLiveReadCommandHandoffBlocker::TaskMutationRequested
                | ProviderLiveReadCommandHandoffBlocker::RawProviderPayloadRetentionRequested
        )
    }) {
        ProviderLiveReadCommandHandoffStatus::Blocked
    } else if blockers.is_empty() {
        ProviderLiveReadCommandHandoffStatus::ReadyForReadOnlyCommand
    } else {
        ProviderLiveReadCommandHandoffStatus::RepairRequired
    }
}
