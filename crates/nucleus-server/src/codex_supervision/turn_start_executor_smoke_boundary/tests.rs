use super::*;
use crate::diagnostics_read_models::codex_transport_executor_diagnostics;
use crate::host_authority::EngineHostId;
use crate::provider_service_runtime::ProviderServiceId;
use crate::provider_transport_write::ProviderTransportWriteTarget;
use crate::{
    CodexAppServerTransportExecutorAuthorityRecord, CodexAppServerTransportExecutorAuthorityStatus,
    CodexAppServerTransportExecutorConfirmationScope,
    CodexAppServerTransportExecutorOperatorConfirmation,
    CodexAppServerTurnStartStdioExecutionEnvelopeId,
    CodexAppServerTurnStartStdioExecutionEnvelopeRecord,
    CodexAppServerTurnStartStdioExecutionEnvelopeStatus, CodexAppServerTurnStartStdioPayloadRef,
    CodexAppServerTurnStartTransportExecutionPersistenceRecord,
    CodexAppServerTurnStartTransportExecutionReplayPolicy,
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
            scope: CodexAppServerTransportExecutorConfirmationScope::PrepareExecutionHandoffOnly,
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
    input.diagnostics = codex_transport_executor_diagnostics(&[], &[], &[], &[], &[], &[], &[]);
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
        &[],
        &[authority.clone()],
        &[envelope.clone()],
        &[execution.clone()],
        &[],
        &[],
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
        envelope_id: CodexAppServerTurnStartStdioExecutionEnvelopeId("stdio-envelope:1".to_owned()),
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
