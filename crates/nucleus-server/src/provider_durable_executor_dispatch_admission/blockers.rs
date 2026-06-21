use super::types::{
    DurableProviderExecutorDispatchAdmissionBlocker, DurableProviderExecutorDispatchAdmissionInput,
};
use crate::{
    DurableProviderExecutorDispatchSelectionRecord, DurableProviderExecutorDispatchSelectionStatus,
};

pub(super) fn admission_blockers(
    input: &DurableProviderExecutorDispatchAdmissionInput,
) -> Vec<DurableProviderExecutorDispatchAdmissionBlocker> {
    let mut blockers = Vec::new();

    if input.selection.status
        != DurableProviderExecutorDispatchSelectionStatus::SelectedForDispatchAdmission
    {
        blockers.push(DurableProviderExecutorDispatchAdmissionBlocker::SelectionNotAccepted);
    }
    if input.selection.provider_write_selected {
        blockers.push(
            DurableProviderExecutorDispatchAdmissionBlocker::SelectionAlreadySelectedProviderWrite,
        );
    }
    if selection_permits_forbidden_authority(&input.selection) {
        blockers.push(
            DurableProviderExecutorDispatchAdmissionBlocker::SelectionPermitsForbiddenAuthority,
        );
    }
    identity_blockers(input, &mut blockers);
    requested_authority_blockers(input, &mut blockers);

    blockers
}

fn selection_permits_forbidden_authority(
    selection: &DurableProviderExecutorDispatchSelectionRecord,
) -> bool {
    selection.client_authority_granted
        || selection.raw_provider_material_retained
        || selection.raw_callback_material_retained
        || selection.task_mutation_permitted
        || selection.review_acceptance_permitted
        || selection.callback_answer_permitted
        || selection.interruption_permitted
        || selection.recovery_permitted
        || selection.replacement_thread_promotion_permitted
        || selection.scm_mutation_permitted
}

fn identity_blockers(
    input: &DurableProviderExecutorDispatchAdmissionInput,
    blockers: &mut Vec<DurableProviderExecutorDispatchAdmissionBlocker>,
) {
    if input.dispatch_attempt_id.is_empty() {
        blockers.push(DurableProviderExecutorDispatchAdmissionBlocker::MissingDispatchAttemptId);
    }
    if input
        .operator_confirmation_ref
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(DurableProviderExecutorDispatchAdmissionBlocker::MissingOperatorConfirmation);
    }
    if input.runtime_session_evidence_refs.is_empty()
        || input
            .runtime_session_evidence_refs
            .iter()
            .any(|value| value.is_empty())
    {
        blockers
            .push(DurableProviderExecutorDispatchAdmissionBlocker::MissingRuntimeSessionEvidence);
    }
    if input.provider_ready_evidence_refs.is_empty()
        || input
            .provider_ready_evidence_refs
            .iter()
            .any(|value| value.is_empty())
    {
        blockers
            .push(DurableProviderExecutorDispatchAdmissionBlocker::MissingProviderReadyEvidence);
    }
    if input.admission_evidence_refs.is_empty()
        || input
            .admission_evidence_refs
            .iter()
            .any(|value| value.is_empty())
    {
        blockers.push(DurableProviderExecutorDispatchAdmissionBlocker::MissingAdmissionEvidence);
    }
    if input.write_attempt_id != input.selection.write_attempt_id {
        blockers.push(DurableProviderExecutorDispatchAdmissionBlocker::WriteAttemptMismatch);
    }
    if input.idempotency_key != input.selection.idempotency_key {
        blockers.push(DurableProviderExecutorDispatchAdmissionBlocker::IdempotencyMismatch);
    }
}

fn requested_authority_blockers(
    input: &DurableProviderExecutorDispatchAdmissionInput,
    blockers: &mut Vec<DurableProviderExecutorDispatchAdmissionBlocker>,
) {
    if input.invoke_executor_requested {
        blockers.push(DurableProviderExecutorDispatchAdmissionBlocker::ExecutorInvocationRequested);
    }
    if input.background_execution_requested {
        blockers
            .push(DurableProviderExecutorDispatchAdmissionBlocker::BackgroundExecutionRequested);
    }
    if input.provider_write_requested {
        blockers.push(DurableProviderExecutorDispatchAdmissionBlocker::ProviderWriteRequested);
    }
    if input.raw_provider_material_requested {
        blockers
            .push(DurableProviderExecutorDispatchAdmissionBlocker::RawProviderMaterialRequested);
    }
    if input.raw_callback_material_requested {
        blockers
            .push(DurableProviderExecutorDispatchAdmissionBlocker::RawCallbackMaterialRequested);
    }
    if input.task_mutation_requested {
        blockers.push(DurableProviderExecutorDispatchAdmissionBlocker::TaskMutationRequested);
    }
    if input.review_acceptance_requested {
        blockers.push(DurableProviderExecutorDispatchAdmissionBlocker::ReviewAcceptanceRequested);
    }
    if input.callback_answer_requested {
        blockers.push(DurableProviderExecutorDispatchAdmissionBlocker::CallbackAnswerRequested);
    }
    if input.interruption_requested {
        blockers.push(DurableProviderExecutorDispatchAdmissionBlocker::InterruptionRequested);
    }
    if input.recovery_requested {
        blockers.push(DurableProviderExecutorDispatchAdmissionBlocker::RecoveryRequested);
    }
    if input.replacement_thread_promotion_requested {
        blockers.push(
            DurableProviderExecutorDispatchAdmissionBlocker::ReplacementThreadPromotionRequested,
        );
    }
    if input.scm_mutation_requested {
        blockers.push(DurableProviderExecutorDispatchAdmissionBlocker::ScmMutationRequested);
    }
}
