use super::super::transport_executor_authority::CodexAppServerTransportExecutorAuthorityStatus;
use super::super::turn_start_live_send_receipts::CodexAppServerTurnStartLiveSendReceiptStatus;
use super::super::turn_start_send_command::CodexAppServerTurnStartWriteTarget;
use super::types::{
    CodexAppServerTurnStartStdioExecutionEnvelopeBlocker,
    CodexAppServerTurnStartStdioExecutionEnvelopeId,
    CodexAppServerTurnStartStdioExecutionEnvelopeInput,
    CodexAppServerTurnStartStdioExecutionEnvelopeRecord,
    CodexAppServerTurnStartStdioExecutionEnvelopeStatus,
};
use crate::provider_transport_write::ProviderTransportWriteTarget;

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
