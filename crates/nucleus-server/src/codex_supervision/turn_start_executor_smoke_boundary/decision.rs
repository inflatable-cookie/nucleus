use super::super::transport_executor_authority::CodexAppServerTransportExecutorAuthorityStatus;
use super::super::turn_start_stdio_execution_envelope::CodexAppServerTurnStartStdioExecutionEnvelopeStatus;
use super::super::turn_start_transport_execution_persistence::CodexAppServerTurnStartTransportExecutionReplayPolicy;
use super::super::{
    CodexAppServerTransportExecutorConfirmationScope,
    CodexAppServerTransportExecutorOperatorConfirmation,
};
use super::diagnostics::{
    diagnostics_has_authority, diagnostics_has_envelope, diagnostics_has_execution,
};
use super::types::{
    CodexAppServerTurnStartExecutorSmokeBoundaryBlocker,
    CodexAppServerTurnStartExecutorSmokeBoundaryId,
    CodexAppServerTurnStartExecutorSmokeBoundaryInput,
    CodexAppServerTurnStartExecutorSmokeBoundaryRecord,
    CodexAppServerTurnStartExecutorSmokeBoundaryStatus, CodexAppServerTurnStartExecutorSmokeIntent,
};

/// Build a stopped-by-default real-write smoke boundary without provider I/O.
pub fn codex_turn_start_executor_smoke_boundary(
    input: CodexAppServerTurnStartExecutorSmokeBoundaryInput,
) -> CodexAppServerTurnStartExecutorSmokeBoundaryRecord {
    let mut blockers = Vec::new();
    let mut evidence_refs = Vec::new();

    match &input.smoke_intent {
        CodexAppServerTurnStartExecutorSmokeIntent::DisabledByDefault => {
            blockers.push(
                CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::SmokeIntentDisabledByDefault,
            );
        }
        CodexAppServerTurnStartExecutorSmokeIntent::RealProviderWriteSmokeRequested {
            evidence_ref,
        } => evidence_refs.push(evidence_ref.clone()),
    }

    match &input.operator_confirmation {
        CodexAppServerTransportExecutorOperatorConfirmation::Missing => blockers
            .push(CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::OperatorConfirmationMissing),
        CodexAppServerTransportExecutorOperatorConfirmation::Confirmed {
            operator_ref,
            evidence_ref,
            scope,
        } => {
            evidence_refs.push(format!("operator:{operator_ref}"));
            evidence_refs.push(evidence_ref.clone());
            if *scope != CodexAppServerTransportExecutorConfirmationScope::RealProviderWriteSmoke {
                blockers.push(
                    CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::OperatorConfirmationScopeNotRealWriteSmoke,
                );
            }
        }
        CodexAppServerTransportExecutorOperatorConfirmation::CliFlagAsserted {
            operator_ref,
            flag,
            scope,
        } => {
            evidence_refs.push(format!("operator:{operator_ref}"));
            evidence_refs.push(format!("assertion:cli-flag:{flag}"));
            if *scope != CodexAppServerTransportExecutorConfirmationScope::RealProviderWriteSmoke {
                blockers.push(
                    CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::OperatorConfirmationScopeNotRealWriteSmoke,
                );
            }
        }
    }

    if input.authority.status
        != CodexAppServerTransportExecutorAuthorityStatus::ReadyForExecutionHandoff
    {
        blockers.push(CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::AuthorityNotReady);
    }
    if input.envelope.status
        != CodexAppServerTurnStartStdioExecutionEnvelopeStatus::ReadyForExecutorHandoff
    {
        blockers.push(CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::EnvelopeNotReady);
    }
    if input.execution.receipt_id.0.is_empty() {
        blockers.push(CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::ExecutionReceiptMissing);
    }
    if input.execution.event_id.is_none() {
        blockers.push(CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::ExecutionEventMissing);
    }
    if input.execution.replay_policy
        != CodexAppServerTurnStartTransportExecutionReplayPolicy::InspectOnly
    {
        blockers.push(
            CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::ExecutionReplayPolicyNotInspectOnly,
        );
    }
    if !diagnostics_has_authority(&input) {
        blockers
            .push(CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::DiagnosticsMissingAuthority);
    }
    if !diagnostics_has_envelope(&input) {
        blockers
            .push(CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::DiagnosticsMissingEnvelope);
    }
    if !diagnostics_has_execution(&input) {
        blockers
            .push(CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::DiagnosticsMissingExecution);
    }
    if input.diagnostics.client_can_execute_provider_write
        || input.diagnostics.client_can_answer_callbacks
        || input.diagnostics.client_can_cancel_provider
    {
        blockers.push(
            CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::DiagnosticsGrantProviderControl,
        );
    }
    if input.diagnostics.client_can_mutate_tasks {
        blockers.push(
            CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::DiagnosticsGrantTaskMutation,
        );
    }
    if input.diagnostics.provider_material_exposed {
        blockers.push(
            CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::DiagnosticsExposeProviderMaterial,
        );
    }
    if input.diagnostics.raw_streams_exposed {
        blockers
            .push(CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::DiagnosticsExposeRawStreams);
    }
    if input.authority.write_attempt_id != input.envelope.write_attempt_id
        || input.authority.write_attempt_id != input.execution.write_attempt_id
    {
        blockers.push(
            CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::WriteAttemptIdentityMismatch,
        );
    }
    if input.authority.provider_instance_id != input.envelope.provider_instance_id {
        blockers.push(
            CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::ProviderInstanceIdentityMismatch,
        );
    }
    if input.authority.provider_write_executed
        || input.envelope.provider_write_executed
        || input.execution.provider_write_executed
    {
        blockers.push(
            CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::ProviderWriteAlreadyExecuted,
        );
    }
    if !input.raw_payload_policy_confirmed {
        blockers
            .push(CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::RawPayloadPolicyUnconfirmed);
    }
    if !input.raw_stream_policy_confirmed {
        blockers
            .push(CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::RawStreamPolicyUnconfirmed);
    }
    if input.task_mutation_requested {
        blockers.push(CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::TaskMutationRequested);
    }

    evidence_refs.extend(input.authority.evidence_refs.iter().cloned());
    evidence_refs.extend(input.envelope.evidence_refs.iter().cloned());
    evidence_refs.push(format!("receipt:{}", input.execution.receipt_id.0));
    if let Some(event_id) = &input.execution.event_id {
        evidence_refs.push(format!("event:{}", event_id.0));
    }
    evidence_refs.sort();
    evidence_refs.dedup();

    let status = if blockers.is_empty() {
        CodexAppServerTurnStartExecutorSmokeBoundaryStatus::EligibleForSeparatelyConfirmedRealWriteSmoke
    } else {
        CodexAppServerTurnStartExecutorSmokeBoundaryStatus::Blocked(blockers)
    };

    CodexAppServerTurnStartExecutorSmokeBoundaryRecord {
        boundary_id: CodexAppServerTurnStartExecutorSmokeBoundaryId(format!(
            "codex-turn-start-executor-smoke-boundary:{}",
            input.execution.write_attempt_id
        )),
        status,
        authority_id: input.authority.authority_id.0,
        envelope_id: input.envelope.envelope_id.0,
        execution_id: input.execution.execution_id,
        write_attempt_id: input.execution.write_attempt_id,
        idempotency_key: input.execution.idempotency_key,
        receipt_id: input.execution.receipt_id.0,
        evidence_refs,
        provider_write_executed: false,
        raw_payload_retained: false,
        raw_stream_retained: false,
        callback_response_permitted: false,
        cancellation_permitted: false,
        retry_scheduled: false,
        task_mutation_permitted: false,
    }
}
