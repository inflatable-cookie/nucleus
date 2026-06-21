use nucleus_agent_protocol::AdapterCommandStreamState;

use super::types::{
    ProviderCommandAdmissionBlocker, ProviderCommandAdmissionId, ProviderCommandAdmissionInput,
    ProviderCommandAdmissionRecord, ProviderCommandAdmissionStatus, ProviderCommandCapabilityState,
};
use crate::provider_service_runtime::ProviderReactorReadinessState;

/// Admit a provider command to the reactor without live provider send.
pub fn admit_provider_command(
    input: ProviderCommandAdmissionInput,
) -> ProviderCommandAdmissionRecord {
    let mut blockers = Vec::new();

    if input.reactor_state != ProviderReactorReadinessState::ReadyForCommands {
        blockers.push(ProviderCommandAdmissionBlocker::ReactorNotReady);
    }
    if input.command_stream_state != AdapterCommandStreamState::Accepting {
        blockers.push(ProviderCommandAdmissionBlocker::CommandLaneNotAccepting);
    }
    match &input.capability {
        ProviderCommandCapabilityState::Supported => {}
        ProviderCommandCapabilityState::Unsupported(reason) => {
            blockers.push(
                ProviderCommandAdmissionBlocker::ProviderCapabilityUnsupported(reason.clone()),
            );
        }
        ProviderCommandCapabilityState::Unknown => {
            blockers.push(ProviderCommandAdmissionBlocker::ProviderCapabilityUnknown);
        }
    }
    if input.live_send_requested {
        blockers.push(ProviderCommandAdmissionBlocker::LiveProviderSendDisabled);
    }
    if input.task_mutation_requested {
        blockers.push(ProviderCommandAdmissionBlocker::TaskMutationDisabled);
    }

    let status = if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            ProviderCommandAdmissionBlocker::ProviderCapabilityUnsupported(_)
        )
    }) {
        ProviderCommandAdmissionStatus::Unsupported
    } else if blockers.is_empty() {
        ProviderCommandAdmissionStatus::AcceptedForDryRun
    } else {
        ProviderCommandAdmissionStatus::Blocked
    };

    ProviderCommandAdmissionRecord {
        admission_id: ProviderCommandAdmissionId(format!(
            "provider-command-admission:{}",
            input.command_id.0
        )),
        command_id: input.command_id,
        reactor_id: input.reactor_id,
        service_id: input.service_id,
        command_lane_id: input.command_lane_id,
        stream_id: input.stream_id,
        family: input.family,
        target_ref: input.target_ref,
        requester: input.requester,
        status,
        blockers,
        live_send_permitted: false,
        task_mutation_permitted: false,
        evidence_refs: input.evidence_refs,
    }
}
