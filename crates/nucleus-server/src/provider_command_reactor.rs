//! Provider command reactor records.
//!
//! These records describe command admission, queueing, dispatch attempts, and
//! outcomes before live provider send exists. They do not write to provider
//! transports or mutate task state.

use nucleus_agent_protocol::AdapterCommandStreamState;

use crate::provider_runtime_orchestration::{
    ProviderRuntimeOutcomeId, ProviderRuntimeOutcomeRecord, ProviderRuntimeOutcomeStatus,
};
use crate::provider_service_runtime::{
    ProviderCommandFamily, ProviderCommandLaneId, ProviderReactorReadinessState,
    ProviderRuntimeStreamId, ProviderServiceId,
};

/// Stable id for a provider command reactor.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProviderCommandReactorId(pub String);

/// Stable id for one provider command request.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProviderCommandId(pub String);

/// Stable id for a provider command admission.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProviderCommandAdmissionId(pub String);

/// Stable id for a queued provider command.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProviderCommandQueueEntryId(pub String);

/// Stable id for a provider command dispatch attempt.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProviderCommandDispatchAttemptId(pub String);

/// Stable id for a provider command reactor outcome.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProviderCommandReactorOutcomeId(pub String);

/// Command admission input for the provider reactor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderCommandAdmissionInput {
    pub command_id: ProviderCommandId,
    pub reactor_id: ProviderCommandReactorId,
    pub service_id: ProviderServiceId,
    pub command_lane_id: ProviderCommandLaneId,
    pub stream_id: Option<ProviderRuntimeStreamId>,
    pub family: ProviderCommandFamily,
    pub target_ref: Option<String>,
    pub requester: ProviderCommandRequester,
    pub capability: ProviderCommandCapabilityState,
    pub reactor_state: ProviderReactorReadinessState,
    pub command_stream_state: AdapterCommandStreamState,
    pub live_send_requested: bool,
    pub task_mutation_requested: bool,
    pub evidence_refs: Vec<String>,
}

/// Actor requesting provider work.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderCommandRequester {
    TaskAgent,
    Steward,
    User,
    System,
}

/// Provider-specific support for one command family.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderCommandCapabilityState {
    Supported,
    Unsupported(String),
    Unknown,
}

/// Reactor admission record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderCommandAdmissionRecord {
    pub admission_id: ProviderCommandAdmissionId,
    pub command_id: ProviderCommandId,
    pub reactor_id: ProviderCommandReactorId,
    pub service_id: ProviderServiceId,
    pub command_lane_id: ProviderCommandLaneId,
    pub stream_id: Option<ProviderRuntimeStreamId>,
    pub family: ProviderCommandFamily,
    pub target_ref: Option<String>,
    pub requester: ProviderCommandRequester,
    pub status: ProviderCommandAdmissionStatus,
    pub blockers: Vec<ProviderCommandAdmissionBlocker>,
    pub live_send_permitted: bool,
    pub task_mutation_permitted: bool,
    pub evidence_refs: Vec<String>,
}

/// Admission status before queueing.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderCommandAdmissionStatus {
    AcceptedForDryRun,
    Blocked,
    Unsupported,
}

/// Why provider command admission was blocked.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderCommandAdmissionBlocker {
    ReactorNotReady,
    CommandLaneNotAccepting,
    ProviderCapabilityUnknown,
    ProviderCapabilityUnsupported(String),
    LiveProviderSendDisabled,
    TaskMutationDisabled,
}

/// Provider command queued by the reactor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderQueuedCommandRecord {
    pub queue_entry_id: ProviderCommandQueueEntryId,
    pub admission_id: ProviderCommandAdmissionId,
    pub command_id: ProviderCommandId,
    pub reactor_id: ProviderCommandReactorId,
    pub service_id: ProviderServiceId,
    pub command_lane_id: ProviderCommandLaneId,
    pub stream_id: Option<ProviderRuntimeStreamId>,
    pub family: ProviderCommandFamily,
    pub state: ProviderCommandQueueState,
    pub live_send_permitted: bool,
    pub task_mutation_permitted: bool,
}

/// Queue state for a provider command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderCommandQueueState {
    QueuedForDryRun,
    Rejected(String),
}

/// Provider dispatch attempt record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderCommandDispatchAttemptRecord {
    pub attempt_id: ProviderCommandDispatchAttemptId,
    pub queue_entry_id: ProviderCommandQueueEntryId,
    pub command_id: ProviderCommandId,
    pub reactor_id: ProviderCommandReactorId,
    pub service_id: ProviderServiceId,
    pub command_lane_id: ProviderCommandLaneId,
    pub stream_id: Option<ProviderRuntimeStreamId>,
    pub family: ProviderCommandFamily,
    pub mode: ProviderCommandDispatchMode,
    pub status: ProviderCommandDispatchAttemptStatus,
    pub live_send_attempted: bool,
    pub task_mutation_attempted: bool,
    pub evidence_refs: Vec<String>,
}

/// Dispatch mode for provider command reactor work.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderCommandDispatchMode {
    DryRunOnly,
    LiveSend,
}

/// Dispatch attempt status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderCommandDispatchAttemptStatus {
    DryRunCompleted,
    SkippedLiveSend(String),
    Blocked(String),
}

/// Provider command outcome record from the reactor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderCommandReactorOutcomeRecord {
    pub outcome_id: ProviderCommandReactorOutcomeId,
    pub attempt_id: ProviderCommandDispatchAttemptId,
    pub command_id: ProviderCommandId,
    pub service_id: ProviderServiceId,
    pub command_lane_id: ProviderCommandLaneId,
    pub stream_id: Option<ProviderRuntimeStreamId>,
    pub family: ProviderCommandFamily,
    pub status: ProviderCommandReactorOutcomeStatus,
    pub live_send_attempted: bool,
    pub task_mutation_permitted: bool,
    pub evidence_refs: Vec<String>,
    pub summary: String,
}

/// Provider command outcome status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderCommandReactorOutcomeStatus {
    DryRunCompleted,
    Blocked(String),
    Unsupported(String),
    Failed(String),
}

/// Provider command reactor construction error.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderCommandReactorError {
    AdmissionNotAccepted,
    QueueEntryNotDispatchable,
}

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

/// Build a provider command outcome from a dispatch attempt.
pub fn provider_command_reactor_outcome(
    attempt: &ProviderCommandDispatchAttemptRecord,
) -> ProviderCommandReactorOutcomeRecord {
    let status = match &attempt.status {
        ProviderCommandDispatchAttemptStatus::DryRunCompleted => {
            ProviderCommandReactorOutcomeStatus::DryRunCompleted
        }
        ProviderCommandDispatchAttemptStatus::SkippedLiveSend(reason) => {
            ProviderCommandReactorOutcomeStatus::Blocked(reason.clone())
        }
        ProviderCommandDispatchAttemptStatus::Blocked(reason) => {
            ProviderCommandReactorOutcomeStatus::Blocked(reason.clone())
        }
    };

    ProviderCommandReactorOutcomeRecord {
        outcome_id: ProviderCommandReactorOutcomeId(format!(
            "provider-command-outcome:{}",
            attempt.command_id.0
        )),
        attempt_id: attempt.attempt_id.clone(),
        command_id: attempt.command_id.clone(),
        service_id: attempt.service_id.clone(),
        command_lane_id: attempt.command_lane_id.clone(),
        stream_id: attempt.stream_id.clone(),
        family: attempt.family.clone(),
        summary: outcome_summary(&status),
        status,
        live_send_attempted: attempt.live_send_attempted,
        task_mutation_permitted: false,
        evidence_refs: attempt.evidence_refs.clone(),
    }
}

/// Convert a reactor outcome into the provider runtime outcome surface.
pub fn provider_runtime_outcome_from_reactor_outcome(
    outcome: &ProviderCommandReactorOutcomeRecord,
) -> ProviderRuntimeOutcomeRecord {
    ProviderRuntimeOutcomeRecord {
        outcome_id: ProviderRuntimeOutcomeId(format!(
            "provider-runtime-outcome:{}",
            outcome.outcome_id.0
        )),
        service_id: outcome.service_id.clone(),
        command_lane_id: outcome.command_lane_id.clone(),
        stream_id: outcome.stream_id.clone(),
        command_family: outcome.family.clone(),
        status: runtime_status(&outcome.status),
        evidence_refs: outcome.evidence_refs.clone(),
        summary: outcome.summary.clone(),
        task_mutation_permitted: false,
    }
}

fn runtime_status(status: &ProviderCommandReactorOutcomeStatus) -> ProviderRuntimeOutcomeStatus {
    match status {
        ProviderCommandReactorOutcomeStatus::DryRunCompleted => {
            ProviderRuntimeOutcomeStatus::Completed
        }
        ProviderCommandReactorOutcomeStatus::Blocked(reason) => {
            ProviderRuntimeOutcomeStatus::Blocked(reason.clone())
        }
        ProviderCommandReactorOutcomeStatus::Unsupported(reason) => {
            ProviderRuntimeOutcomeStatus::Unsupported(reason.clone())
        }
        ProviderCommandReactorOutcomeStatus::Failed(reason) => {
            ProviderRuntimeOutcomeStatus::Failed(reason.clone())
        }
    }
}

fn outcome_summary(status: &ProviderCommandReactorOutcomeStatus) -> String {
    match status {
        ProviderCommandReactorOutcomeStatus::DryRunCompleted => {
            "provider command dry-run completed without live send".to_owned()
        }
        ProviderCommandReactorOutcomeStatus::Blocked(reason) => {
            format!("provider command blocked: {reason}")
        }
        ProviderCommandReactorOutcomeStatus::Unsupported(reason) => {
            format!("provider command unsupported: {reason}")
        }
        ProviderCommandReactorOutcomeStatus::Failed(reason) => {
            format!("provider command failed: {reason}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider_runtime_orchestration::runtime_receipt_from_provider_outcome;
    use nucleus_engine::{EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptStatus};

    #[test]
    fn reactor_records_distinguish_admission_queue_dispatch_and_outcome() {
        let admission = admit_provider_command(admission_input(false, false));
        let queued = queue_provider_command(&admission).expect("queued");
        let attempt =
            provider_command_dispatch_attempt(&queued, vec!["evidence:dry-run".to_owned()])
                .expect("dispatch attempt");
        let outcome = provider_command_reactor_outcome(&attempt);
        let runtime_outcome = provider_runtime_outcome_from_reactor_outcome(&outcome);
        let receipt = runtime_receipt_from_provider_outcome(&runtime_outcome);

        assert_eq!(
            admission.status,
            ProviderCommandAdmissionStatus::AcceptedForDryRun
        );
        assert!(!admission.live_send_permitted);
        assert!(!admission.task_mutation_permitted);
        assert_eq!(queued.state, ProviderCommandQueueState::QueuedForDryRun);
        assert_eq!(attempt.mode, ProviderCommandDispatchMode::DryRunOnly);
        assert!(!attempt.live_send_attempted);
        assert!(!attempt.task_mutation_attempted);
        assert_eq!(
            outcome.status,
            ProviderCommandReactorOutcomeStatus::DryRunCompleted
        );
        assert!(!runtime_outcome.task_mutation_permitted);
        assert_eq!(
            receipt.family,
            EngineRuntimeReceiptEffectFamily::HarnessProvider
        );
        assert_eq!(receipt.status, EngineRuntimeReceiptStatus::Completed);
    }

    #[test]
    fn live_send_request_is_blocked_before_queueing() {
        let admission = admit_provider_command(admission_input(true, false));

        assert_eq!(admission.status, ProviderCommandAdmissionStatus::Blocked);
        assert!(admission
            .blockers
            .contains(&ProviderCommandAdmissionBlocker::LiveProviderSendDisabled));
        assert_eq!(
            queue_provider_command(&admission),
            Err(ProviderCommandReactorError::AdmissionNotAccepted)
        );
    }

    #[test]
    fn unsupported_provider_capability_is_not_queued() {
        let mut input = admission_input(false, false);
        input.capability =
            ProviderCommandCapabilityState::Unsupported("turn interrupt unavailable".to_owned());

        let admission = admit_provider_command(input);

        assert_eq!(
            admission.status,
            ProviderCommandAdmissionStatus::Unsupported
        );
        assert!(matches!(
            admission.blockers.as_slice(),
            [ProviderCommandAdmissionBlocker::ProviderCapabilityUnsupported(_)]
        ));
        assert_eq!(
            queue_provider_command(&admission),
            Err(ProviderCommandReactorError::AdmissionNotAccepted)
        );
    }

    #[test]
    fn task_mutation_request_is_blocked_even_when_provider_command_is_supported() {
        let admission = admit_provider_command(admission_input(false, true));

        assert_eq!(admission.status, ProviderCommandAdmissionStatus::Blocked);
        assert!(admission
            .blockers
            .contains(&ProviderCommandAdmissionBlocker::TaskMutationDisabled));
        assert!(!admission.task_mutation_permitted);
    }

    fn admission_input(
        live_send_requested: bool,
        task_mutation_requested: bool,
    ) -> ProviderCommandAdmissionInput {
        ProviderCommandAdmissionInput {
            command_id: ProviderCommandId("provider-command:1".to_owned()),
            reactor_id: ProviderCommandReactorId("provider-reactor:codex".to_owned()),
            service_id: ProviderServiceId("provider-service:codex".to_owned()),
            command_lane_id: ProviderCommandLaneId("provider-command-lane:codex".to_owned()),
            stream_id: Some(ProviderRuntimeStreamId(
                "provider-event-stream:codex".to_owned(),
            )),
            family: ProviderCommandFamily::StartTurn,
            target_ref: Some("session:1".to_owned()),
            requester: ProviderCommandRequester::TaskAgent,
            capability: ProviderCommandCapabilityState::Supported,
            reactor_state: ProviderReactorReadinessState::ReadyForCommands,
            command_stream_state: AdapterCommandStreamState::Accepting,
            live_send_requested,
            task_mutation_requested,
            evidence_refs: vec!["evidence:reactor-admission".to_owned()],
        }
    }
}
