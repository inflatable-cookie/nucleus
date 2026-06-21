use nucleus_server::{
    DurableCodexLiveProviderWriteInvocationGateBlocker,
    DurableCodexLiveProviderWriteInvocationGateStatus, DurableCodexLiveSmokeBoundaryStatus,
};

pub(super) fn boundary_status_label(status: &DurableCodexLiveSmokeBoundaryStatus) -> &'static str {
    match status {
        DurableCodexLiveSmokeBoundaryStatus::DryRunEligible => "dry_run_eligible",
        DurableCodexLiveSmokeBoundaryStatus::EligibleForExplicitLiveProviderWrite => {
            "eligible_for_explicit_live_provider_write"
        }
        DurableCodexLiveSmokeBoundaryStatus::Blocked => "blocked",
    }
}

pub(super) fn gate_status_label(
    status: &DurableCodexLiveProviderWriteInvocationGateStatus,
) -> &'static str {
    match status {
        DurableCodexLiveProviderWriteInvocationGateStatus::ReadyForExplicitInvocation => {
            "ready_for_explicit_invocation"
        }
        DurableCodexLiveProviderWriteInvocationGateStatus::Blocked => "blocked",
    }
}

pub(super) fn gate_blocker_label(
    blocker: &DurableCodexLiveProviderWriteInvocationGateBlocker,
) -> &'static str {
    match blocker {
        DurableCodexLiveProviderWriteInvocationGateBlocker::BoundaryNotEligibleForLiveProviderWrite => {
            "boundary_not_eligible_for_live_provider_write"
        }
        DurableCodexLiveProviderWriteInvocationGateBlocker::MissingInvocationEvidence => {
            "missing_invocation_evidence"
        }
        DurableCodexLiveProviderWriteInvocationGateBlocker::MissingConfirmationRef => {
            "missing_confirmation_ref"
        }
        DurableCodexLiveProviderWriteInvocationGateBlocker::MissingEffectRef => "missing_effect_ref",
        DurableCodexLiveProviderWriteInvocationGateBlocker::BoundaryAlreadyExecutedProviderWrite => {
            "boundary_already_executed_provider_write"
        }
        DurableCodexLiveProviderWriteInvocationGateBlocker::BoundaryAlreadyInvokedExecutor => {
            "boundary_already_invoked_executor"
        }
        DurableCodexLiveProviderWriteInvocationGateBlocker::BoundaryRetainedRawProviderMaterial => {
            "boundary_retained_raw_provider_material"
        }
        DurableCodexLiveProviderWriteInvocationGateBlocker::BoundaryRetainedRawStream => {
            "boundary_retained_raw_stream"
        }
        DurableCodexLiveProviderWriteInvocationGateBlocker::BoundaryPermitsTaskMutation => {
            "boundary_permits_task_mutation"
        }
        DurableCodexLiveProviderWriteInvocationGateBlocker::BoundaryPermitsReviewAcceptance => {
            "boundary_permits_review_acceptance"
        }
        DurableCodexLiveProviderWriteInvocationGateBlocker::BoundaryPermitsCallbackAnswer => {
            "boundary_permits_callback_answer"
        }
        DurableCodexLiveProviderWriteInvocationGateBlocker::BoundaryPermitsCancellation => {
            "boundary_permits_cancellation"
        }
        DurableCodexLiveProviderWriteInvocationGateBlocker::BoundaryPermitsResume => {
            "boundary_permits_resume"
        }
        DurableCodexLiveProviderWriteInvocationGateBlocker::BoundaryPermitsScmMutation => {
            "boundary_permits_scm_mutation"
        }
        DurableCodexLiveProviderWriteInvocationGateBlocker::ExecutorInvocationRequestedAtGate => {
            "executor_invocation_requested_at_gate"
        }
        DurableCodexLiveProviderWriteInvocationGateBlocker::ProviderWriteRequestedAtGate => {
            "provider_write_requested_at_gate"
        }
        DurableCodexLiveProviderWriteInvocationGateBlocker::RawProviderMaterialRequested => {
            "raw_provider_material_requested"
        }
        DurableCodexLiveProviderWriteInvocationGateBlocker::RawStreamRequested => {
            "raw_stream_requested"
        }
        DurableCodexLiveProviderWriteInvocationGateBlocker::TaskMutationRequested => {
            "task_mutation_requested"
        }
        DurableCodexLiveProviderWriteInvocationGateBlocker::ReviewAcceptanceRequested => {
            "review_acceptance_requested"
        }
        DurableCodexLiveProviderWriteInvocationGateBlocker::CallbackAnswerRequested => {
            "callback_answer_requested"
        }
        DurableCodexLiveProviderWriteInvocationGateBlocker::CancellationRequested => {
            "cancellation_requested"
        }
        DurableCodexLiveProviderWriteInvocationGateBlocker::ResumeRequested => "resume_requested",
        DurableCodexLiveProviderWriteInvocationGateBlocker::ScmMutationRequested => {
            "scm_mutation_requested"
        }
    }
}
