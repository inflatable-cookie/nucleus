use super::*;
use crate::provider_runtime_orchestration::runtime_receipt_from_provider_outcome;
use crate::provider_service_runtime::{
    ProviderCommandFamily, ProviderCommandLaneId, ProviderReactorReadinessState,
    ProviderRuntimeStreamId, ProviderServiceId,
};
use nucleus_agent_protocol::AdapterCommandStreamState;
use nucleus_engine::{EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptStatus};

#[test]
fn reactor_records_distinguish_admission_queue_dispatch_and_outcome() {
    let admission = admit_provider_command(admission_input(false, false));
    let queued = queue_provider_command(&admission).expect("queued");
    let attempt = provider_command_dispatch_attempt(&queued, vec!["evidence:dry-run".to_owned()])
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
