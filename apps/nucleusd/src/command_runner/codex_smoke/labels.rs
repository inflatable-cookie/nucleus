use nucleus_server::{
    CodexAppServerTurnStartExecutorSmokeBoundaryBlocker,
    CodexAppServerTurnStartExecutorSmokeBoundaryStatus,
};

pub(super) fn boundary_status_label(
    status: &CodexAppServerTurnStartExecutorSmokeBoundaryStatus,
) -> &'static str {
    match status {
        CodexAppServerTurnStartExecutorSmokeBoundaryStatus::EligibleForSeparatelyConfirmedRealWriteSmoke => {
            "eligible"
        }
        CodexAppServerTurnStartExecutorSmokeBoundaryStatus::Blocked(_) => "blocked",
    }
}

pub(super) fn blocker_label(
    blocker: &CodexAppServerTurnStartExecutorSmokeBoundaryBlocker,
) -> &'static str {
    match blocker {
        CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::SmokeIntentDisabledByDefault => {
            "smoke_intent_disabled_by_default"
        }
        CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::OperatorConfirmationMissing => {
            "operator_confirmation_missing"
        }
        CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::OperatorConfirmationScopeNotRealWriteSmoke => {
            "operator_confirmation_scope_not_real_write_smoke"
        }
        CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::AuthorityNotReady => {
            "authority_not_ready"
        }
        CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::EnvelopeNotReady => {
            "envelope_not_ready"
        }
        CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::ExecutionReceiptMissing => {
            "execution_receipt_missing"
        }
        CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::ExecutionEventMissing => {
            "execution_event_missing"
        }
        CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::ExecutionReplayPolicyNotInspectOnly => {
            "execution_replay_policy_not_inspect_only"
        }
        CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::DiagnosticsMissingAuthority => {
            "diagnostics_missing_authority"
        }
        CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::DiagnosticsMissingEnvelope => {
            "diagnostics_missing_envelope"
        }
        CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::DiagnosticsMissingExecution => {
            "diagnostics_missing_execution"
        }
        CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::DiagnosticsGrantProviderControl => {
            "diagnostics_grant_provider_control"
        }
        CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::DiagnosticsGrantTaskMutation => {
            "diagnostics_grant_task_mutation"
        }
        CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::DiagnosticsExposeProviderMaterial => {
            "diagnostics_expose_provider_material"
        }
        CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::DiagnosticsExposeRawStreams => {
            "diagnostics_expose_raw_streams"
        }
        CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::WriteAttemptIdentityMismatch => {
            "write_attempt_identity_mismatch"
        }
        CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::ProviderInstanceIdentityMismatch => {
            "provider_instance_identity_mismatch"
        }
        CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::ProviderWriteAlreadyExecuted => {
            "provider_write_already_executed"
        }
        CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::RawPayloadPolicyUnconfirmed => {
            "raw_payload_policy_unconfirmed"
        }
        CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::RawStreamPolicyUnconfirmed => {
            "raw_stream_policy_unconfirmed"
        }
        CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::TaskMutationRequested => {
            "task_mutation_requested"
        }
    }
}
