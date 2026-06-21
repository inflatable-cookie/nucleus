use crate::{
    DurableProviderExecutorCommandRecord, DurableProviderExecutorCommandStatus,
    DurableProviderExecutorState, DurableProviderExecutorStatusRecord,
};

use super::types::{
    DurableProviderExecutorDispatchSelectionBlocker, DurableProviderExecutorDispatchSelectionInput,
};

pub(super) fn selection_blockers(
    input: &DurableProviderExecutorDispatchSelectionInput,
) -> Vec<DurableProviderExecutorDispatchSelectionBlocker> {
    let mut blockers = Vec::new();

    if input.command.status != DurableProviderExecutorCommandStatus::AcceptedForPersistence {
        blockers.push(DurableProviderExecutorDispatchSelectionBlocker::CommandNotAccepted);
    }
    if input.command.provider_write_executed {
        blockers.push(
            DurableProviderExecutorDispatchSelectionBlocker::CommandAlreadyExecutedProviderWrite,
        );
    }
    if command_permits_forbidden_authority(&input.command) {
        blockers.push(
            DurableProviderExecutorDispatchSelectionBlocker::CommandPermitsForbiddenAuthority,
        );
    }
    status_blockers(input.latest_status.as_ref(), &mut blockers);
    identity_blockers(input, &mut blockers);
    requested_authority_blockers(input, &mut blockers);

    blockers
}

fn command_permits_forbidden_authority(command: &DurableProviderExecutorCommandRecord) -> bool {
    command.client_authority_granted
        || command.raw_provider_material_retained
        || command.raw_callback_material_retained
        || command.task_mutation_permitted
        || command.review_acceptance_permitted
        || command.callback_answer_permitted
        || command.interruption_permitted
        || command.recovery_permitted
        || command.replacement_thread_promotion_permitted
        || command.scm_mutation_permitted
}

fn status_blockers(
    latest_status: Option<&DurableProviderExecutorStatusRecord>,
    blockers: &mut Vec<DurableProviderExecutorDispatchSelectionBlocker>,
) {
    let Some(latest_status) = latest_status else {
        return;
    };

    match latest_status.state {
        DurableProviderExecutorState::Queued => {}
        DurableProviderExecutorState::Running => {
            blockers.push(DurableProviderExecutorDispatchSelectionBlocker::LatestStatusInFlight);
        }
        DurableProviderExecutorState::Completed
        | DurableProviderExecutorState::Failed(_)
        | DurableProviderExecutorState::Blocked(_)
        | DurableProviderExecutorState::TimedOut
        | DurableProviderExecutorState::CleanupRequired(_) => {
            blockers.push(DurableProviderExecutorDispatchSelectionBlocker::LatestStatusTerminal);
        }
        DurableProviderExecutorState::Invalid => {
            blockers.push(DurableProviderExecutorDispatchSelectionBlocker::LatestStatusInvalid);
        }
    }
}

fn identity_blockers(
    input: &DurableProviderExecutorDispatchSelectionInput,
    blockers: &mut Vec<DurableProviderExecutorDispatchSelectionBlocker>,
) {
    if input
        .command
        .operator_confirmation_ref
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(DurableProviderExecutorDispatchSelectionBlocker::MissingOperatorConfirmation);
    }
    if input.command.runtime_session_ref.is_empty() {
        blockers.push(DurableProviderExecutorDispatchSelectionBlocker::MissingRuntimeSessionRef);
    }
    if input.provider_ready_evidence_refs.is_empty()
        || input
            .provider_ready_evidence_refs
            .iter()
            .any(|value| value.is_empty())
    {
        blockers
            .push(DurableProviderExecutorDispatchSelectionBlocker::MissingProviderReadyEvidence);
    }
    if input.runtime_ready_evidence_refs.is_empty()
        || input
            .runtime_ready_evidence_refs
            .iter()
            .any(|value| value.is_empty())
    {
        blockers.push(DurableProviderExecutorDispatchSelectionBlocker::MissingRuntimeReadyEvidence);
    }
    if input.selection_evidence_refs.is_empty()
        || input
            .selection_evidence_refs
            .iter()
            .any(|value| value.is_empty())
    {
        blockers.push(DurableProviderExecutorDispatchSelectionBlocker::MissingSelectionEvidence);
    }
    if input
        .in_flight_write_attempt_ids
        .iter()
        .any(|value| value == &input.command.write_attempt_id)
    {
        blockers
            .push(DurableProviderExecutorDispatchSelectionBlocker::DuplicateInFlightWriteAttempt);
    }
    if input.stale_command_evidence {
        blockers.push(DurableProviderExecutorDispatchSelectionBlocker::StaleCommandEvidence);
    }
}

fn requested_authority_blockers(
    input: &DurableProviderExecutorDispatchSelectionInput,
    blockers: &mut Vec<DurableProviderExecutorDispatchSelectionBlocker>,
) {
    if input.background_execution_requested {
        blockers
            .push(DurableProviderExecutorDispatchSelectionBlocker::BackgroundExecutionRequested);
    }
    if input.provider_write_requested {
        blockers.push(DurableProviderExecutorDispatchSelectionBlocker::ProviderWriteRequested);
    }
    if input.raw_provider_material_requested {
        blockers
            .push(DurableProviderExecutorDispatchSelectionBlocker::RawProviderMaterialRequested);
    }
    if input.raw_callback_material_requested {
        blockers
            .push(DurableProviderExecutorDispatchSelectionBlocker::RawCallbackMaterialRequested);
    }
    if input.task_mutation_requested {
        blockers.push(DurableProviderExecutorDispatchSelectionBlocker::TaskMutationRequested);
    }
    if input.review_acceptance_requested {
        blockers.push(DurableProviderExecutorDispatchSelectionBlocker::ReviewAcceptanceRequested);
    }
    if input.callback_answer_requested {
        blockers.push(DurableProviderExecutorDispatchSelectionBlocker::CallbackAnswerRequested);
    }
    if input.interruption_requested {
        blockers.push(DurableProviderExecutorDispatchSelectionBlocker::InterruptionRequested);
    }
    if input.recovery_requested {
        blockers.push(DurableProviderExecutorDispatchSelectionBlocker::RecoveryRequested);
    }
    if input.replacement_thread_promotion_requested {
        blockers.push(
            DurableProviderExecutorDispatchSelectionBlocker::ReplacementThreadPromotionRequested,
        );
    }
    if input.scm_mutation_requested {
        blockers.push(DurableProviderExecutorDispatchSelectionBlocker::ScmMutationRequested);
    }
}
