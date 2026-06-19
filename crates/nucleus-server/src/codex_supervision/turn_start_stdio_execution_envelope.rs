//! Codex `turn/start` stdio execution envelope records.
//!
//! These records prepare a provider transport executor handoff from existing
//! authority, send-command, preflight, write-attempt, and receipt/event
//! evidence. They do not write to Codex stdio, retain raw payloads or streams,
//! answer callbacks, schedule retries, or mutate task state.

use nucleus_orchestration::OrchestrationEventId;

use crate::provider_service_runtime::ProviderServiceId;
use crate::provider_transport_write::{
    ProviderTransportWriteAttemptRecord, ProviderTransportWriteTarget,
};

use super::live_send_preflight::CodexAppServerLiveSendPreflightRecord;
use super::transport_executor_authority::{
    CodexAppServerTransportExecutorAuthorityRecord, CodexAppServerTransportExecutorAuthorityStatus,
};
use super::turn_start_live_send_receipts::{
    CodexAppServerTurnStartLiveSendReceiptLink, CodexAppServerTurnStartLiveSendReceiptStatus,
};
use super::turn_start_send_command::{
    CodexAppServerTurnStartSendCommandRecord, CodexAppServerTurnStartWriteTarget,
};

/// Stable id for one Codex `turn/start` stdio execution envelope.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerTurnStartStdioExecutionEnvelopeId(pub String);

/// Input for building a Codex `turn/start` stdio execution envelope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTurnStartStdioExecutionEnvelopeInput {
    pub send_command: CodexAppServerTurnStartSendCommandRecord,
    pub preflight: CodexAppServerLiveSendPreflightRecord,
    pub write_attempt: ProviderTransportWriteAttemptRecord,
    pub receipt_link: CodexAppServerTurnStartLiveSendReceiptLink,
    pub authority: CodexAppServerTransportExecutorAuthorityRecord,
    pub payload_ref: CodexAppServerTurnStartStdioPayloadRef,
}

/// Reference to provider payload material without retaining that material.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTurnStartStdioPayloadRef {
    pub payload_ref: String,
    pub summary: String,
    pub raw_payload_retained: bool,
}

/// Sanitized handoff envelope for the stdio transport executor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTurnStartStdioExecutionEnvelopeRecord {
    pub envelope_id: CodexAppServerTurnStartStdioExecutionEnvelopeId,
    pub request_id: String,
    pub method: String,
    pub provider_instance_id: String,
    pub service_id: Option<ProviderServiceId>,
    pub send_command_id: String,
    pub preflight_id: String,
    pub write_attempt_id: String,
    pub receipt_id: String,
    pub event_id: OrchestrationEventId,
    pub authority_id: String,
    pub idempotency_key: String,
    pub payload_ref: CodexAppServerTurnStartStdioPayloadRef,
    pub target: ProviderTransportWriteTarget,
    pub status: CodexAppServerTurnStartStdioExecutionEnvelopeStatus,
    pub blockers: Vec<CodexAppServerTurnStartStdioExecutionEnvelopeBlocker>,
    pub evidence_refs: Vec<String>,
    pub provider_write_executed: bool,
    pub raw_payload_retained: bool,
    pub raw_stream_retained: bool,
    pub callback_response_permitted: bool,
    pub cancellation_permitted: bool,
    pub task_mutation_permitted: bool,
}

/// Execution-envelope status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTurnStartStdioExecutionEnvelopeStatus {
    ReadyForExecutorHandoff,
    Blocked,
}

/// Why the execution envelope cannot be handed off.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTurnStartStdioExecutionEnvelopeBlocker {
    AuthorityNotReady,
    SendCommandAlreadyStartedProviderWrite,
    SendCommandTargetNotStdio,
    WriteAttemptTargetNotStdio,
    ReceiptLinkBlocked,
    RawPayloadRetained,
    RawStreamRetentionNotAllowed,
    MethodNotTurnStart,
    PreflightIdentityMismatch,
    WriteAttemptIdentityMismatch,
    ReceiptIdentityMismatch,
    EnvelopeIdentityMismatch,
    EmptyPayloadRef,
    EmptyIdempotencyKey,
}

/// Build a sanitized stdio execution envelope without provider I/O.
pub fn codex_turn_start_stdio_execution_envelope(
    input: CodexAppServerTurnStartStdioExecutionEnvelopeInput,
) -> CodexAppServerTurnStartStdioExecutionEnvelopeRecord {
    let mut blockers = Vec::new();

    if input.authority.status
        != CodexAppServerTransportExecutorAuthorityStatus::ReadyForExecutionHandoff
    {
        blockers.push(CodexAppServerTurnStartStdioExecutionEnvelopeBlocker::AuthorityNotReady);
    }
    if input.send_command.provider_write_started {
        blockers.push(
            CodexAppServerTurnStartStdioExecutionEnvelopeBlocker::SendCommandAlreadyStartedProviderWrite,
        );
    }
    if input.send_command.write_target != CodexAppServerTurnStartWriteTarget::Stdio {
        blockers
            .push(CodexAppServerTurnStartStdioExecutionEnvelopeBlocker::SendCommandTargetNotStdio);
    }
    if !matches!(
        input.write_attempt.target,
        ProviderTransportWriteTarget::Stdio { .. }
    ) {
        blockers
            .push(CodexAppServerTurnStartStdioExecutionEnvelopeBlocker::WriteAttemptTargetNotStdio);
    }
    if matches!(
        input.receipt_link.status,
        CodexAppServerTurnStartLiveSendReceiptStatus::Blocked(_)
    ) {
        blockers.push(CodexAppServerTurnStartStdioExecutionEnvelopeBlocker::ReceiptLinkBlocked);
    }
    if input.payload_ref.raw_payload_retained
        || input.send_command.raw_payload_retained
        || input.write_attempt.raw_payload_retained
        || input.receipt_link.raw_payload_retained
        || input.authority.raw_payload_retained
    {
        blockers.push(CodexAppServerTurnStartStdioExecutionEnvelopeBlocker::RawPayloadRetained);
    }
    if input.authority.raw_stream_retained {
        blockers.push(
            CodexAppServerTurnStartStdioExecutionEnvelopeBlocker::RawStreamRetentionNotAllowed,
        );
    }
    if input.send_command.method != "turn/start" {
        blockers.push(CodexAppServerTurnStartStdioExecutionEnvelopeBlocker::MethodNotTurnStart);
    }
    if input.authority.preflight_id != input.preflight.preflight_id.0 {
        blockers
            .push(CodexAppServerTurnStartStdioExecutionEnvelopeBlocker::PreflightIdentityMismatch);
    }
    if input.authority.write_attempt_id != input.write_attempt.attempt_id.0 {
        blockers.push(
            CodexAppServerTurnStartStdioExecutionEnvelopeBlocker::WriteAttemptIdentityMismatch,
        );
    }
    if input.receipt_link.identity.write_attempt_id != input.write_attempt.attempt_id.0 {
        blockers
            .push(CodexAppServerTurnStartStdioExecutionEnvelopeBlocker::ReceiptIdentityMismatch);
    }
    if input.receipt_link.identity.envelope_id != input.send_command.envelope_id {
        blockers
            .push(CodexAppServerTurnStartStdioExecutionEnvelopeBlocker::EnvelopeIdentityMismatch);
    }
    if input.payload_ref.payload_ref.is_empty() {
        blockers.push(CodexAppServerTurnStartStdioExecutionEnvelopeBlocker::EmptyPayloadRef);
    }
    if input.write_attempt.idempotency_key.0.is_empty() {
        blockers.push(CodexAppServerTurnStartStdioExecutionEnvelopeBlocker::EmptyIdempotencyKey);
    }

    let mut evidence_refs = Vec::new();
    evidence_refs.extend(input.send_command.evidence_refs.iter().cloned());
    evidence_refs.extend(input.preflight.evidence_refs.iter().cloned());
    evidence_refs.extend(input.write_attempt.evidence_refs.iter().cloned());
    evidence_refs.extend(input.authority.evidence_refs.iter().cloned());
    evidence_refs.push(format!("payload-ref:{}", input.payload_ref.payload_ref));
    evidence_refs.push(format!(
        "receipt:{}",
        input.receipt_link.receipt.receipt_id.0
    ));
    evidence_refs.push(format!("event:{}", input.receipt_link.event.event_id.0));
    evidence_refs.sort();
    evidence_refs.dedup();

    let status = if blockers.is_empty() {
        CodexAppServerTurnStartStdioExecutionEnvelopeStatus::ReadyForExecutorHandoff
    } else {
        CodexAppServerTurnStartStdioExecutionEnvelopeStatus::Blocked
    };

    CodexAppServerTurnStartStdioExecutionEnvelopeRecord {
        envelope_id: CodexAppServerTurnStartStdioExecutionEnvelopeId(format!(
            "codex-turn-start-stdio-execution:{}",
            input.write_attempt.attempt_id.0
        )),
        request_id: input.send_command.request_id,
        method: input.send_command.method,
        provider_instance_id: input.authority.provider_instance_id,
        service_id: input.authority.service_id,
        send_command_id: input.send_command.command_id.0,
        preflight_id: input.preflight.preflight_id.0,
        write_attempt_id: input.write_attempt.attempt_id.0,
        receipt_id: input.receipt_link.receipt.receipt_id.0,
        event_id: input.receipt_link.event.event_id,
        authority_id: input.authority.authority_id.0,
        idempotency_key: input.write_attempt.idempotency_key.0,
        payload_ref: input.payload_ref,
        target: input.write_attempt.target,
        status,
        blockers,
        evidence_refs,
        provider_write_executed: false,
        raw_payload_retained: false,
        raw_stream_retained: false,
        callback_response_permitted: false,
        cancellation_permitted: false,
        task_mutation_permitted: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::{
        admit_codex_turn_start, codex_live_send_preflight, codex_transport_executor_authority,
        codex_turn_start_envelope, codex_turn_start_live_send_receipt_link,
        codex_turn_start_reactor_dry_run, codex_turn_start_request, codex_turn_start_send_command,
        CodexAppServerLiveSendEvidenceState, CodexAppServerLiveSendOperatorPolicy,
        CodexAppServerLiveSendPreflightInput, CodexAppServerPayloadRetentionPolicy,
        CodexAppServerTransportExecutorConfirmationScope,
        CodexAppServerTransportExecutorEvidenceState,
        CodexAppServerTransportExecutorOperatorConfirmation,
        CodexAppServerTransportExecutorProviderAuthority, CodexAppServerTurnStartAdmissionInput,
        CodexAppServerTurnStartDeferredPolicy, CodexAppServerTurnStartEnvelopeRecord,
        CodexAppServerTurnStartPromptRef, CodexAppServerTurnStartPromptRetentionPolicy,
        CodexAppServerTurnStartReactorDryRunInput, CodexAppServerTurnStartReactorDryRunRecord,
        CodexAppServerTurnStartWriteTarget,
    };
    use crate::host_authority::{
        EngineHostId, ProjectAuthorityAssignment, ProjectAuthorityDomain, ProjectAuthorityMap,
    };
    use crate::provider_service_runtime::{
        ProviderCommandLaneId, ProviderReactorReadinessState, ProviderRuntimeStreamId,
        ProviderServiceId,
    };
    use crate::provider_transport_write::{
        provider_transport_write_attempt, ProviderTransportWriteAttemptInput,
        ProviderTransportWriteIdempotencyKey, ProviderTransportWritePayloadShape,
        ProviderTransportWritePreflightStatus, ProviderTransportWriteTarget,
    };
    use crate::ProviderCommandReactorId;
    use nucleus_agent_protocol::AdapterCommandStreamState;
    use nucleus_projects::ProjectId;

    #[test]
    fn stdio_execution_envelope_preserves_identity_without_writing() {
        let input = execution_envelope_input();

        let envelope = codex_turn_start_stdio_execution_envelope(input);

        assert_eq!(
            envelope.status,
            CodexAppServerTurnStartStdioExecutionEnvelopeStatus::ReadyForExecutorHandoff
        );
        assert_eq!(envelope.method, "turn/start");
        assert_eq!(envelope.provider_instance_id, "codex:local-default");
        assert!(envelope
            .send_command_id
            .starts_with("codex-turn-start-send:"));
        assert!(envelope
            .preflight_id
            .starts_with("codex-live-send-preflight:"));
        assert!(envelope
            .write_attempt_id
            .starts_with("provider-transport-write:"));
        assert!(envelope
            .receipt_id
            .starts_with("receipt:codex-turn-start-live-send:"));
        assert!(!envelope.provider_write_executed);
        assert!(!envelope.raw_payload_retained);
        assert!(!envelope.raw_stream_retained);
        assert!(!envelope.callback_response_permitted);
        assert!(!envelope.cancellation_permitted);
        assert!(!envelope.task_mutation_permitted);
    }

    #[test]
    fn blocked_authority_prevents_execution_handoff() {
        let mut input = execution_envelope_input();
        input.authority = blocked_authority(&input.preflight, &input.write_attempt);

        let envelope = codex_turn_start_stdio_execution_envelope(input);

        assert_eq!(
            envelope.status,
            CodexAppServerTurnStartStdioExecutionEnvelopeStatus::Blocked
        );
        assert!(envelope
            .blockers
            .contains(&CodexAppServerTurnStartStdioExecutionEnvelopeBlocker::AuthorityNotReady));
        assert!(!envelope.provider_write_executed);
        assert!(!envelope.task_mutation_permitted);
    }

    #[test]
    fn envelope_blocks_raw_payload_and_identity_mismatch() {
        let mut input = execution_envelope_input();
        input.payload_ref.raw_payload_retained = true;
        input.receipt_link.identity.envelope_id = "codex-envelope:other".to_owned();

        let envelope = codex_turn_start_stdio_execution_envelope(input);

        assert_eq!(
            envelope.status,
            CodexAppServerTurnStartStdioExecutionEnvelopeStatus::Blocked
        );
        assert!(envelope
            .blockers
            .contains(&CodexAppServerTurnStartStdioExecutionEnvelopeBlocker::RawPayloadRetained));
        assert!(envelope.blockers.contains(
            &CodexAppServerTurnStartStdioExecutionEnvelopeBlocker::EnvelopeIdentityMismatch
        ));
        assert!(!envelope.provider_write_executed);
    }

    fn execution_envelope_input() -> CodexAppServerTurnStartStdioExecutionEnvelopeInput {
        let context = turn_start_context();
        let dry_run = context.dry_run;
        let preflight = codex_live_send_preflight(ready_preflight_input(dry_run.clone()));
        let write_attempt = write_attempt(&dry_run, &preflight);
        let receipt_link =
            codex_turn_start_live_send_receipt_link(&dry_run, &preflight, &write_attempt);
        let authority = ready_authority(&preflight, &write_attempt);
        let send_command = codex_turn_start_send_command(
            &context.envelope,
            CodexAppServerTurnStartWriteTarget::Stdio,
        )
        .expect("send command");

        CodexAppServerTurnStartStdioExecutionEnvelopeInput {
            send_command,
            preflight,
            write_attempt,
            receipt_link,
            authority,
            payload_ref: CodexAppServerTurnStartStdioPayloadRef {
                payload_ref: "payload-ref:turn-start:1".to_owned(),
                summary: "turn/start payload built from prompt ref".to_owned(),
                raw_payload_retained: false,
            },
        }
    }

    fn ready_authority(
        preflight: &CodexAppServerLiveSendPreflightRecord,
        write_attempt: &ProviderTransportWriteAttemptRecord,
    ) -> CodexAppServerTransportExecutorAuthorityRecord {
        codex_transport_executor_authority(authority_input(preflight, write_attempt, true))
    }

    fn blocked_authority(
        preflight: &CodexAppServerLiveSendPreflightRecord,
        write_attempt: &ProviderTransportWriteAttemptRecord,
    ) -> CodexAppServerTransportExecutorAuthorityRecord {
        let mut input = authority_input(preflight, write_attempt, true);
        input.operator_confirmation = CodexAppServerTransportExecutorOperatorConfirmation::Missing;
        codex_transport_executor_authority(input)
    }

    fn authority_input(
        preflight: &CodexAppServerLiveSendPreflightRecord,
        write_attempt: &ProviderTransportWriteAttemptRecord,
        mutation_allowed: bool,
    ) -> crate::CodexAppServerTransportExecutorAuthorityInput {
        crate::CodexAppServerTransportExecutorAuthorityInput {
            preflight: preflight.clone(),
            write_attempt: write_attempt.clone(),
            execution_host_authority: authority_map(mutation_allowed)
                .readiness_for(&host(), &ProjectAuthorityDomain::Execution),
            provider_instance: provider_instance(),
            operator_confirmation: CodexAppServerTransportExecutorOperatorConfirmation::Confirmed {
                operator_ref: "operator:tom".to_owned(),
                evidence_ref: "evidence:operator-confirmation".to_owned(),
                scope:
                    CodexAppServerTransportExecutorConfirmationScope::PrepareExecutionHandoffOnly,
            },
            raw_payload_policy_confirmed: true,
            raw_stream_policy_confirmed: true,
            task_mutation_requested: false,
        }
    }

    fn provider_instance() -> CodexAppServerTransportExecutorProviderAuthority {
        CodexAppServerTransportExecutorProviderAuthority {
            provider_instance_id: "codex:local-default".to_owned(),
            service_id: Some(ProviderServiceId("provider-service:codex".to_owned())),
            auth_readiness: ready_executor_evidence("evidence:auth"),
            transport_readiness: ready_executor_evidence("evidence:transport"),
            evidence_refs: vec!["evidence:provider-instance".to_owned()],
        }
    }

    fn ready_executor_evidence(evidence_ref: &str) -> CodexAppServerTransportExecutorEvidenceState {
        CodexAppServerTransportExecutorEvidenceState::Ready {
            evidence_ref: evidence_ref.to_owned(),
        }
    }

    fn write_attempt(
        dry_run: &crate::CodexAppServerTurnStartReactorDryRunRecord,
        preflight: &CodexAppServerLiveSendPreflightRecord,
    ) -> ProviderTransportWriteAttemptRecord {
        provider_transport_write_attempt(ProviderTransportWriteAttemptInput {
            command_id: dry_run.outcome.command_id.clone(),
            dispatch_attempt_id: dry_run.dispatch_attempt.attempt_id.clone(),
            reactor_outcome_id: dry_run.outcome.outcome_id.clone(),
            service_id: dry_run.outcome.service_id.clone(),
            command_lane_id: dry_run.outcome.command_lane_id.clone(),
            target: ProviderTransportWriteTarget::Stdio {
                endpoint_label: "stdio://codex-app-server".to_owned(),
            },
            idempotency_key: ProviderTransportWriteIdempotencyKey(format!(
                "codex-turn-start:{}",
                dry_run.envelope_id
            )),
            preflight_status: ProviderTransportWritePreflightStatus::Accepted,
            payload_shape: ProviderTransportWritePayloadShape::EvidenceRefsOnly,
            evidence_refs: preflight.evidence_refs.clone(),
        })
    }

    fn ready_preflight_input(
        dry_run: crate::CodexAppServerTurnStartReactorDryRunRecord,
    ) -> CodexAppServerLiveSendPreflightInput {
        CodexAppServerLiveSendPreflightInput {
            reactor_outcome: dry_run.outcome,
            dispatch_attempt: dry_run.dispatch_attempt,
            execution_authority: ready_preflight_evidence("evidence:execution-authority"),
            auth_readiness: ready_preflight_evidence("evidence:auth"),
            reactor_readiness: ready_preflight_evidence("evidence:reactor"),
            transport_readiness: ready_preflight_evidence("evidence:transport"),
            operator_policy: CodexAppServerLiveSendOperatorPolicy::Enabled {
                evidence_ref: "evidence:operator-policy".to_owned(),
            },
            raw_payload_policy_confirmed: true,
        }
    }

    fn ready_preflight_evidence(evidence_ref: &str) -> CodexAppServerLiveSendEvidenceState {
        CodexAppServerLiveSendEvidenceState::Ready {
            evidence_ref: evidence_ref.to_owned(),
        }
    }

    fn authority_map(mutation_allowed: bool) -> ProjectAuthorityMap {
        ProjectAuthorityMap {
            project_id: ProjectId("project:nucleus".to_owned()),
            assignments: vec![ProjectAuthorityAssignment {
                domain: ProjectAuthorityDomain::Execution,
                authoritative_host_id: host(),
                fallback_host_ids: Vec::new(),
                mutation_allowed,
                note: Some("local execution host".to_owned()),
            }],
        }
    }

    fn host() -> EngineHostId {
        EngineHostId("host:local".to_owned())
    }

    struct TurnStartContext {
        envelope: CodexAppServerTurnStartEnvelopeRecord,
        dry_run: CodexAppServerTurnStartReactorDryRunRecord,
    }

    fn turn_start_context() -> TurnStartContext {
        let runtime = crate::codex_supervision::test_support::runtime();
        let request = codex_turn_start_request(
            &runtime,
            crate::codex_supervision::test_support::session_id(),
            crate::codex_supervision::test_support::task_id(),
            crate::codex_supervision::test_support::work_item_id(),
            CodexAppServerTurnStartPromptRef {
                prompt_ref: "prompt:1".to_owned(),
                summary: "turn prompt summary".to_owned(),
                retention: CodexAppServerTurnStartPromptRetentionPolicy::SummaryAndRefOnly,
            },
            CodexAppServerPayloadRetentionPolicy::MetadataOnly,
        )
        .expect("turn request");
        let admission = admit_codex_turn_start(CodexAppServerTurnStartAdmissionInput {
            request: request.clone(),
            runtime_ready_evidence_refs: vec!["evidence:live-spawn-smoke".to_owned()],
            task_work_ready: true,
            assignment_ready: true,
            callback_policy: CodexAppServerTurnStartDeferredPolicy::ExplicitlyDeferred,
            cancellation_policy: CodexAppServerTurnStartDeferredPolicy::ExplicitlyDeferred,
            raw_payload_policy_confirmed: true,
        });
        let envelope = codex_turn_start_envelope(&request, &admission).expect("envelope");

        let dry_run = codex_turn_start_reactor_dry_run(CodexAppServerTurnStartReactorDryRunInput {
            envelope: envelope.clone(),
            reactor_id: ProviderCommandReactorId("provider-reactor:codex".to_owned()),
            service_id: ProviderServiceId("provider-service:codex".to_owned()),
            command_lane_id: ProviderCommandLaneId("provider-command-lane:codex".to_owned()),
            stream_id: Some(ProviderRuntimeStreamId(
                "provider-event-stream:codex".to_owned(),
            )),
            reactor_state: ProviderReactorReadinessState::ReadyForCommands,
            command_stream_state: AdapterCommandStreamState::Accepting,
        })
        .expect("dry run");

        TurnStartContext { envelope, dry_run }
    }
}
