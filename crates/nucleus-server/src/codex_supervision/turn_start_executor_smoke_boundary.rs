//! Codex `turn/start` real-write smoke boundary.
//!
//! This boundary decides whether a `turn/start` handoff has enough explicit
//! evidence to be eligible for a separately-run real provider write smoke. It
//! does not write to Codex stdio, retain raw provider material, schedule
//! retries, answer callbacks, cancel provider work, or mutate task state.

use super::transport_executor_authority::{
    CodexAppServerTransportExecutorAuthorityRecord, CodexAppServerTransportExecutorAuthorityStatus,
};
use super::turn_start_stdio_execution_envelope::{
    CodexAppServerTurnStartStdioExecutionEnvelopeRecord,
    CodexAppServerTurnStartStdioExecutionEnvelopeStatus,
};
use super::turn_start_transport_execution_persistence::{
    CodexAppServerTurnStartTransportExecutionPersistenceRecord,
    CodexAppServerTurnStartTransportExecutionReplayPolicy,
};
use super::{
    CodexAppServerTransportExecutorConfirmationScope,
    CodexAppServerTransportExecutorOperatorConfirmation,
};
use crate::diagnostics_read_models::CodexTransportExecutorDiagnosticsDto;

/// Stable id for one Codex `turn/start` real-write smoke boundary decision.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerTurnStartExecutorSmokeBoundaryId(pub String);

/// Input for the Codex `turn/start` real-write smoke boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTurnStartExecutorSmokeBoundaryInput {
    pub authority: CodexAppServerTransportExecutorAuthorityRecord,
    pub envelope: CodexAppServerTurnStartStdioExecutionEnvelopeRecord,
    pub execution: CodexAppServerTurnStartTransportExecutionPersistenceRecord,
    pub diagnostics: CodexTransportExecutorDiagnosticsDto,
    pub smoke_intent: CodexAppServerTurnStartExecutorSmokeIntent,
    pub operator_confirmation: CodexAppServerTransportExecutorOperatorConfirmation,
    pub raw_payload_policy_confirmed: bool,
    pub raw_stream_policy_confirmed: bool,
    pub task_mutation_requested: bool,
}

/// Explicit opt-in for a real provider write smoke.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTurnStartExecutorSmokeIntent {
    DisabledByDefault,
    RealProviderWriteSmokeRequested { evidence_ref: String },
}

/// Boundary decision for a real provider write smoke.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTurnStartExecutorSmokeBoundaryRecord {
    pub boundary_id: CodexAppServerTurnStartExecutorSmokeBoundaryId,
    pub status: CodexAppServerTurnStartExecutorSmokeBoundaryStatus,
    pub authority_id: String,
    pub envelope_id: String,
    pub execution_id: String,
    pub write_attempt_id: String,
    pub idempotency_key: String,
    pub receipt_id: String,
    pub evidence_refs: Vec<String>,
    pub provider_write_executed: bool,
    pub raw_payload_retained: bool,
    pub raw_stream_retained: bool,
    pub callback_response_permitted: bool,
    pub cancellation_permitted: bool,
    pub retry_scheduled: bool,
    pub task_mutation_permitted: bool,
}

/// Real-write smoke boundary status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTurnStartExecutorSmokeBoundaryStatus {
    EligibleForSeparatelyConfirmedRealWriteSmoke,
    Blocked(Vec<CodexAppServerTurnStartExecutorSmokeBoundaryBlocker>),
}

/// Why a real provider write smoke is not eligible.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTurnStartExecutorSmokeBoundaryBlocker {
    SmokeIntentDisabledByDefault,
    OperatorConfirmationMissing,
    OperatorConfirmationScopeNotRealWriteSmoke,
    AuthorityNotReady,
    EnvelopeNotReady,
    ExecutionReceiptMissing,
    ExecutionEventMissing,
    ExecutionReplayPolicyNotInspectOnly,
    DiagnosticsMissingAuthority,
    DiagnosticsMissingEnvelope,
    DiagnosticsMissingExecution,
    DiagnosticsGrantProviderControl,
    DiagnosticsGrantTaskMutation,
    DiagnosticsExposeProviderMaterial,
    DiagnosticsExposeRawStreams,
    WriteAttemptIdentityMismatch,
    ProviderInstanceIdentityMismatch,
    ProviderWriteAlreadyExecuted,
    RawPayloadPolicyUnconfirmed,
    RawStreamPolicyUnconfirmed,
    TaskMutationRequested,
}

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

fn diagnostics_has_authority(input: &CodexAppServerTurnStartExecutorSmokeBoundaryInput) -> bool {
    let authority_id = &input.authority.authority_id.0;
    input
        .diagnostics
        .authorities
        .iter()
        .any(|record| &record.authority_id == authority_id)
}

fn diagnostics_has_envelope(input: &CodexAppServerTurnStartExecutorSmokeBoundaryInput) -> bool {
    let envelope_id = &input.envelope.envelope_id.0;
    input
        .diagnostics
        .envelopes
        .iter()
        .any(|record| &record.envelope_id == envelope_id)
}

fn diagnostics_has_execution(input: &CodexAppServerTurnStartExecutorSmokeBoundaryInput) -> bool {
    let execution_id = &input.execution.execution_id;
    input
        .diagnostics
        .executions
        .iter()
        .any(|record| &record.execution_id == execution_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics_read_models::codex_transport_executor_diagnostics;
    use crate::host_authority::EngineHostId;
    use crate::provider_service_runtime::ProviderServiceId;
    use crate::provider_transport_write::ProviderTransportWriteTarget;
    use crate::{
        CodexAppServerTurnStartStdioExecutionEnvelopeId, CodexAppServerTurnStartStdioPayloadRef,
    };
    use nucleus_engine::EngineRuntimeReceiptRecordId;
    use nucleus_orchestration::OrchestrationEventId;

    #[test]
    fn turn_start_executor_smoke_is_blocked_by_default_without_writing() {
        let input = smoke_input(
            CodexAppServerTurnStartExecutorSmokeIntent::DisabledByDefault,
            CodexAppServerTransportExecutorOperatorConfirmation::Missing,
        );

        let boundary = codex_turn_start_executor_smoke_boundary(input);

        assert!(matches!(
            boundary.status,
            CodexAppServerTurnStartExecutorSmokeBoundaryStatus::Blocked(blockers)
                if blockers.contains(
                    &CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::SmokeIntentDisabledByDefault
                )
                    && blockers.contains(
                        &CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::OperatorConfirmationMissing
                    )
        ));
        assert!(!boundary.provider_write_executed);
        assert!(!boundary.raw_payload_retained);
        assert!(!boundary.raw_stream_retained);
        assert!(!boundary.callback_response_permitted);
        assert!(!boundary.cancellation_permitted);
        assert!(!boundary.retry_scheduled);
        assert!(!boundary.task_mutation_permitted);
    }

    #[test]
    fn turn_start_executor_smoke_requires_real_write_confirmation_scope() {
        let input = smoke_input(
            CodexAppServerTurnStartExecutorSmokeIntent::RealProviderWriteSmokeRequested {
                evidence_ref: "evidence:real-write-smoke-request".to_owned(),
            },
            CodexAppServerTransportExecutorOperatorConfirmation::Confirmed {
                operator_ref: "operator:tom".to_owned(),
                evidence_ref: "evidence:operator-confirmation".to_owned(),
                scope:
                    CodexAppServerTransportExecutorConfirmationScope::PrepareExecutionHandoffOnly,
            },
        );

        let boundary = codex_turn_start_executor_smoke_boundary(input);

        assert!(matches!(
            boundary.status,
            CodexAppServerTurnStartExecutorSmokeBoundaryStatus::Blocked(blockers)
                if blockers.contains(
                    &CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::OperatorConfirmationScopeNotRealWriteSmoke
                )
        ));
        assert!(!boundary.provider_write_executed);
    }

    #[test]
    fn turn_start_executor_smoke_can_be_marked_eligible_without_executing() {
        let input = smoke_input(
            CodexAppServerTurnStartExecutorSmokeIntent::RealProviderWriteSmokeRequested {
                evidence_ref: "evidence:real-write-smoke-request".to_owned(),
            },
            CodexAppServerTransportExecutorOperatorConfirmation::Confirmed {
                operator_ref: "operator:tom".to_owned(),
                evidence_ref: "evidence:operator-confirmation".to_owned(),
                scope: CodexAppServerTransportExecutorConfirmationScope::RealProviderWriteSmoke,
            },
        );

        let boundary = codex_turn_start_executor_smoke_boundary(input);

        assert_eq!(
            boundary.status,
            CodexAppServerTurnStartExecutorSmokeBoundaryStatus::EligibleForSeparatelyConfirmedRealWriteSmoke
        );
        assert!(boundary
            .evidence_refs
            .contains(&"evidence:real-write-smoke-request".to_owned()));
        assert!(!boundary.provider_write_executed);
        assert!(!boundary.task_mutation_permitted);
    }

    #[test]
    fn turn_start_executor_smoke_blocks_missing_policy_diagnostics_and_identity() {
        let mut input = smoke_input(
            CodexAppServerTurnStartExecutorSmokeIntent::RealProviderWriteSmokeRequested {
                evidence_ref: "evidence:real-write-smoke-request".to_owned(),
            },
            CodexAppServerTransportExecutorOperatorConfirmation::Confirmed {
                operator_ref: "operator:tom".to_owned(),
                evidence_ref: "evidence:operator-confirmation".to_owned(),
                scope: CodexAppServerTransportExecutorConfirmationScope::RealProviderWriteSmoke,
            },
        );
        input.envelope.write_attempt_id = "write-attempt:other".to_owned();
        input.diagnostics = codex_transport_executor_diagnostics(&[], &[], &[], &[]);
        input.raw_payload_policy_confirmed = false;
        input.raw_stream_policy_confirmed = false;
        input.task_mutation_requested = true;

        let boundary = codex_turn_start_executor_smoke_boundary(input);

        assert!(matches!(
            boundary.status,
            CodexAppServerTurnStartExecutorSmokeBoundaryStatus::Blocked(blockers)
                if blockers.contains(&CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::DiagnosticsMissingAuthority)
                    && blockers.contains(&CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::DiagnosticsMissingEnvelope)
                    && blockers.contains(&CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::DiagnosticsMissingExecution)
                    && blockers.contains(&CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::WriteAttemptIdentityMismatch)
                    && blockers.contains(&CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::RawPayloadPolicyUnconfirmed)
                    && blockers.contains(&CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::RawStreamPolicyUnconfirmed)
                    && blockers.contains(&CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::TaskMutationRequested)
        ));
        assert!(!boundary.provider_write_executed);
    }

    fn smoke_input(
        smoke_intent: CodexAppServerTurnStartExecutorSmokeIntent,
        operator_confirmation: CodexAppServerTransportExecutorOperatorConfirmation,
    ) -> CodexAppServerTurnStartExecutorSmokeBoundaryInput {
        let authority = authority();
        let envelope = envelope();
        let execution = execution();
        let diagnostics = codex_transport_executor_diagnostics(
            &[authority.clone()],
            &[envelope.clone()],
            &[execution.clone()],
            &[],
        );

        CodexAppServerTurnStartExecutorSmokeBoundaryInput {
            authority,
            envelope,
            execution,
            diagnostics,
            smoke_intent,
            operator_confirmation,
            raw_payload_policy_confirmed: true,
            raw_stream_policy_confirmed: true,
            task_mutation_requested: false,
        }
    }

    fn authority() -> CodexAppServerTransportExecutorAuthorityRecord {
        CodexAppServerTransportExecutorAuthorityRecord {
            authority_id: super::super::CodexAppServerTransportExecutorAuthorityId(
                "authority:1".to_owned(),
            ),
            execution_host_id: EngineHostId("host:local".to_owned()),
            provider_instance_id: "codex:local-default".to_owned(),
            service_id: Some(ProviderServiceId("provider-service:codex".to_owned())),
            preflight_id: "preflight:1".to_owned(),
            write_attempt_id: "write-attempt:1".to_owned(),
            status: CodexAppServerTransportExecutorAuthorityStatus::ReadyForExecutionHandoff,
            blockers: Vec::new(),
            evidence_refs: vec!["evidence:authority".to_owned()],
            provider_write_executed: false,
            raw_payload_retained: false,
            raw_stream_retained: false,
            task_mutation_permitted: false,
        }
    }

    fn envelope() -> CodexAppServerTurnStartStdioExecutionEnvelopeRecord {
        CodexAppServerTurnStartStdioExecutionEnvelopeRecord {
            envelope_id: CodexAppServerTurnStartStdioExecutionEnvelopeId(
                "stdio-envelope:1".to_owned(),
            ),
            request_id: "turn-start-request:1".to_owned(),
            method: "turn/start".to_owned(),
            provider_instance_id: "codex:local-default".to_owned(),
            service_id: Some(ProviderServiceId("provider-service:codex".to_owned())),
            send_command_id: "send-command:1".to_owned(),
            preflight_id: "preflight:1".to_owned(),
            write_attempt_id: "write-attempt:1".to_owned(),
            receipt_id: "receipt:live-send:1".to_owned(),
            event_id: OrchestrationEventId("event:live-send:1".to_owned()),
            authority_id: "authority:1".to_owned(),
            idempotency_key: "codex-turn-start:1".to_owned(),
            payload_ref: CodexAppServerTurnStartStdioPayloadRef {
                payload_ref: "payload-ref:1".to_owned(),
                summary: "turn/start payload ref".to_owned(),
                raw_payload_retained: false,
            },
            target: ProviderTransportWriteTarget::Stdio {
                endpoint_label: "stdio://codex-app-server".to_owned(),
            },
            status: CodexAppServerTurnStartStdioExecutionEnvelopeStatus::ReadyForExecutorHandoff,
            blockers: Vec::new(),
            evidence_refs: vec!["evidence:envelope".to_owned()],
            provider_write_executed: false,
            raw_payload_retained: false,
            raw_stream_retained: false,
            callback_response_permitted: false,
            cancellation_permitted: false,
            task_mutation_permitted: false,
        }
    }

    fn execution() -> CodexAppServerTurnStartTransportExecutionPersistenceRecord {
        CodexAppServerTurnStartTransportExecutionPersistenceRecord {
            execution_id: "execution:1".to_owned(),
            write_attempt_id: "write-attempt:1".to_owned(),
            idempotency_key: "codex-turn-start:1".to_owned(),
            receipt_id: EngineRuntimeReceiptRecordId("receipt:execution:1".to_owned()),
            event_id: Some(OrchestrationEventId("event:execution:1".to_owned())),
            replay_policy: CodexAppServerTurnStartTransportExecutionReplayPolicy::InspectOnly,
            provider_write_executed: false,
            raw_payload_persisted: false,
            raw_stream_persisted: false,
            task_mutation_permitted: false,
        }
    }
}
