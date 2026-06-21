use crate::{
    DurableProviderExecutorDispatchAdmissionRecord, DurableProviderExecutorDispatchAdmissionStatus,
};

use super::types::{
    DurableDispatchInvocationPreflightBlocker, DurableDispatchInvocationPreflightInput,
};

pub(super) fn preflight_blockers(
    input: &DurableDispatchInvocationPreflightInput,
) -> Vec<DurableDispatchInvocationPreflightBlocker> {
    let mut blockers = Vec::new();

    if input.admission.status != DurableProviderExecutorDispatchAdmissionStatus::AcceptedForDispatch
    {
        blockers.push(DurableDispatchInvocationPreflightBlocker::AdmissionNotAccepted);
    }
    if input.admission.provider_write_executed {
        blockers
            .push(DurableDispatchInvocationPreflightBlocker::AdmissionAlreadyExecutedProviderWrite);
    }
    if admission_permits_forbidden_authority(&input.admission) {
        blockers
            .push(DurableDispatchInvocationPreflightBlocker::AdmissionPermitsForbiddenAuthority);
    }
    identity_blockers(input, &mut blockers);
    authority_blockers(input, &mut blockers);

    blockers
}

fn admission_permits_forbidden_authority(
    admission: &DurableProviderExecutorDispatchAdmissionRecord,
) -> bool {
    admission.client_authority_granted
        || admission.raw_provider_material_retained
        || admission.raw_callback_material_retained
        || admission.task_mutation_permitted
        || admission.review_acceptance_permitted
        || admission.callback_answer_permitted
        || admission.interruption_permitted
        || admission.recovery_permitted
        || admission.replacement_thread_promotion_permitted
        || admission.scm_mutation_permitted
}

fn identity_blockers(
    input: &DurableDispatchInvocationPreflightInput,
    blockers: &mut Vec<DurableDispatchInvocationPreflightBlocker>,
) {
    if input
        .operator_confirmation_ref
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(DurableDispatchInvocationPreflightBlocker::MissingOperatorConfirmation);
    }
    if input.provider_ready_evidence_refs.is_empty()
        || input
            .provider_ready_evidence_refs
            .iter()
            .any(|value| value.is_empty())
    {
        blockers.push(DurableDispatchInvocationPreflightBlocker::MissingProviderReadyEvidence);
    }
    if input.runtime_session_evidence_refs.is_empty()
        || input
            .runtime_session_evidence_refs
            .iter()
            .any(|value| value.is_empty())
    {
        blockers.push(DurableDispatchInvocationPreflightBlocker::MissingRuntimeSessionEvidence);
    }
    if input.invocation_evidence_refs.is_empty()
        || input
            .invocation_evidence_refs
            .iter()
            .any(|value| value.is_empty())
    {
        blockers.push(DurableDispatchInvocationPreflightBlocker::MissingInvocationEvidence);
    }
    if !input.supported_methods.contains(&input.admission.method) {
        blockers.push(DurableDispatchInvocationPreflightBlocker::UnsupportedProviderMethod);
    }
    if input
        .in_flight_invocation_attempt_ids
        .iter()
        .any(|value| value == &input.admission.dispatch_attempt_id)
    {
        blockers
            .push(DurableDispatchInvocationPreflightBlocker::DuplicateInFlightInvocationAttempt);
    }
    if input.stale_admission_evidence {
        blockers.push(DurableDispatchInvocationPreflightBlocker::StaleAdmissionEvidence);
    }
    if input.write_attempt_id != input.admission.write_attempt_id {
        blockers.push(DurableDispatchInvocationPreflightBlocker::WriteAttemptMismatch);
    }
    if input.idempotency_key != input.admission.idempotency_key {
        blockers.push(DurableDispatchInvocationPreflightBlocker::IdempotencyMismatch);
    }
}

fn authority_blockers(
    input: &DurableDispatchInvocationPreflightInput,
    blockers: &mut Vec<DurableDispatchInvocationPreflightBlocker>,
) {
    if input.executor_invocation_requested {
        blockers.push(DurableDispatchInvocationPreflightBlocker::ExecutorInvocationRequested);
    }
    if input.background_execution_requested {
        blockers.push(DurableDispatchInvocationPreflightBlocker::BackgroundExecutionRequested);
    }
    if input.provider_write_requested {
        blockers.push(DurableDispatchInvocationPreflightBlocker::ProviderWriteRequested);
    }
    if input.raw_provider_material_requested {
        blockers.push(DurableDispatchInvocationPreflightBlocker::RawProviderMaterialRequested);
    }
    if input.raw_callback_material_requested {
        blockers.push(DurableDispatchInvocationPreflightBlocker::RawCallbackMaterialRequested);
    }
    if input.task_mutation_requested {
        blockers.push(DurableDispatchInvocationPreflightBlocker::TaskMutationRequested);
    }
    if input.review_acceptance_requested {
        blockers.push(DurableDispatchInvocationPreflightBlocker::ReviewAcceptanceRequested);
    }
    if input.callback_answer_requested {
        blockers.push(DurableDispatchInvocationPreflightBlocker::CallbackAnswerRequested);
    }
    if input.interruption_requested {
        blockers.push(DurableDispatchInvocationPreflightBlocker::InterruptionRequested);
    }
    if input.recovery_requested {
        blockers.push(DurableDispatchInvocationPreflightBlocker::RecoveryRequested);
    }
    if input.replacement_thread_promotion_requested {
        blockers
            .push(DurableDispatchInvocationPreflightBlocker::ReplacementThreadPromotionRequested);
    }
    if input.scm_mutation_requested {
        blockers.push(DurableDispatchInvocationPreflightBlocker::ScmMutationRequested);
    }
}
