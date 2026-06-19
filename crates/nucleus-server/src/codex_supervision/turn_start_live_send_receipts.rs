//! Codex turn-start live-send receipt/event linkage.
//!
//! These records make a queued or blocked live-send attempt inspectable through
//! runtime receipts and orchestration events. They do not execute provider
//! writes, retain raw payloads, retry sends, or mutate task state.

use nucleus_engine::{
    EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId,
    EngineRuntimeReceiptRef, EngineRuntimeReceiptStatus,
};
use nucleus_orchestration::{
    EventStreamRef, OrchestrationCommandId, OrchestrationEventId, OrchestrationEventRecord,
    OrchestrationEventStoreRecord,
};

use crate::provider_transport_write::{
    ProviderTransportWriteAttemptRecord, ProviderTransportWriteAttemptStatus,
};

use super::live_send_preflight::{
    CodexAppServerLiveSendPreflightRecord, CodexAppServerLiveSendPreflightStatus,
};
use super::turn_start_reactor::CodexAppServerTurnStartReactorDryRunRecord;

/// Receipt/event linkage for one Codex turn-start live-send attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTurnStartLiveSendReceiptLink {
    pub receipt: EngineRuntimeReceiptRecord,
    pub event: OrchestrationEventStoreRecord,
    pub status: CodexAppServerTurnStartLiveSendReceiptStatus,
    pub identity: CodexAppServerTurnStartLiveSendReceiptIdentity,
    pub raw_payload_retained: bool,
    pub provider_write_executed: bool,
    pub retry_scheduled: bool,
    pub task_mutation_permitted: bool,
}

/// Identity refs that must survive receipt/event projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTurnStartLiveSendReceiptIdentity {
    pub envelope_id: String,
    pub provider_command_id: String,
    pub dispatch_attempt_id: String,
    pub preflight_id: String,
    pub write_attempt_id: String,
}

/// Receipt state for the attempted live send.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTurnStartLiveSendReceiptStatus {
    QueuedForWrite,
    Blocked(Vec<CodexAppServerTurnStartLiveSendReceiptBlocker>),
}

/// Why a live-send receipt is blocked.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTurnStartLiveSendReceiptBlocker {
    PreflightBlocked,
    TransportWriteBlocked,
    CommandIdentityMismatch,
    DispatchIdentityMismatch,
}

/// Build sanitized receipt/event linkage for a Codex turn-start live send.
pub fn codex_turn_start_live_send_receipt_link(
    dry_run: &CodexAppServerTurnStartReactorDryRunRecord,
    preflight: &CodexAppServerLiveSendPreflightRecord,
    write_attempt: &ProviderTransportWriteAttemptRecord,
) -> CodexAppServerTurnStartLiveSendReceiptLink {
    let blockers = live_send_receipt_blockers(dry_run, preflight, write_attempt);
    let status = if blockers.is_empty() {
        CodexAppServerTurnStartLiveSendReceiptStatus::QueuedForWrite
    } else {
        CodexAppServerTurnStartLiveSendReceiptStatus::Blocked(blockers)
    };
    let identity = CodexAppServerTurnStartLiveSendReceiptIdentity {
        envelope_id: dry_run.envelope_id.clone(),
        provider_command_id: write_attempt.command_id.0.clone(),
        dispatch_attempt_id: write_attempt.dispatch_attempt_id.0.clone(),
        preflight_id: preflight.preflight_id.0.clone(),
        write_attempt_id: write_attempt.attempt_id.0.clone(),
    };
    let receipt = live_send_runtime_receipt(dry_run, preflight, write_attempt, &status);
    let event = live_send_event_store_record(write_attempt);

    CodexAppServerTurnStartLiveSendReceiptLink {
        receipt,
        event,
        status,
        identity,
        raw_payload_retained: false,
        provider_write_executed: false,
        retry_scheduled: false,
        task_mutation_permitted: false,
    }
}

fn live_send_receipt_blockers(
    dry_run: &CodexAppServerTurnStartReactorDryRunRecord,
    preflight: &CodexAppServerLiveSendPreflightRecord,
    write_attempt: &ProviderTransportWriteAttemptRecord,
) -> Vec<CodexAppServerTurnStartLiveSendReceiptBlocker> {
    let mut blockers = Vec::new();

    if preflight.status != CodexAppServerLiveSendPreflightStatus::AcceptedForTransportAttempt {
        blockers.push(CodexAppServerTurnStartLiveSendReceiptBlocker::PreflightBlocked);
    }
    if write_attempt.status != ProviderTransportWriteAttemptStatus::Queued {
        blockers.push(CodexAppServerTurnStartLiveSendReceiptBlocker::TransportWriteBlocked);
    }
    if dry_run.outcome.command_id != write_attempt.command_id {
        blockers.push(CodexAppServerTurnStartLiveSendReceiptBlocker::CommandIdentityMismatch);
    }
    if dry_run.dispatch_attempt.attempt_id != write_attempt.dispatch_attempt_id {
        blockers.push(CodexAppServerTurnStartLiveSendReceiptBlocker::DispatchIdentityMismatch);
    }

    blockers
}

fn live_send_runtime_receipt(
    dry_run: &CodexAppServerTurnStartReactorDryRunRecord,
    preflight: &CodexAppServerLiveSendPreflightRecord,
    write_attempt: &ProviderTransportWriteAttemptRecord,
    status: &CodexAppServerTurnStartLiveSendReceiptStatus,
) -> EngineRuntimeReceiptRecord {
    EngineRuntimeReceiptRecord {
        receipt_id: EngineRuntimeReceiptRecordId(format!(
            "receipt:codex-turn-start-live-send:{}",
            write_attempt.attempt_id.0
        )),
        family: EngineRuntimeReceiptEffectFamily::HarnessProvider,
        status: receipt_status(status),
        command_ref: Some(EngineRuntimeReceiptRef::Custom(
            write_attempt.command_id.0.clone(),
        )),
        effect_ref: Some(EngineRuntimeReceiptRef::Custom(
            write_attempt.attempt_id.0.clone(),
        )),
        evidence_refs: live_send_evidence_refs(dry_run, preflight, write_attempt),
        artifact_refs: dry_run
            .dispatch_attempt
            .stream_id
            .iter()
            .map(|stream_id| EngineRuntimeReceiptRef::Custom(stream_id.0.clone()))
            .collect(),
        summary: Some(live_send_summary(preflight, write_attempt, status)),
    }
}

fn live_send_event_store_record(
    write_attempt: &ProviderTransportWriteAttemptRecord,
) -> OrchestrationEventStoreRecord {
    let event = OrchestrationEventRecord::runtime_observation_accepted(
        OrchestrationEventId(format!(
            "event:codex-turn-start-live-send:{}",
            write_attempt.attempt_id.0
        )),
        OrchestrationCommandId(format!(
            "command:codex-turn-start-live-send:{}",
            write_attempt.command_id.0
        )),
        Some(write_attempt.service_id.0.clone()),
    );

    OrchestrationEventStoreRecord::from_event(
        EventStreamRef(format!(
            "stream:codex-turn-start-live-send:{}",
            write_attempt.service_id.0
        )),
        event,
    )
}

fn receipt_status(
    status: &CodexAppServerTurnStartLiveSendReceiptStatus,
) -> EngineRuntimeReceiptStatus {
    match status {
        CodexAppServerTurnStartLiveSendReceiptStatus::QueuedForWrite => {
            EngineRuntimeReceiptStatus::Queued
        }
        CodexAppServerTurnStartLiveSendReceiptStatus::Blocked(_) => {
            EngineRuntimeReceiptStatus::Blocked
        }
    }
}

fn live_send_evidence_refs(
    dry_run: &CodexAppServerTurnStartReactorDryRunRecord,
    preflight: &CodexAppServerLiveSendPreflightRecord,
    write_attempt: &ProviderTransportWriteAttemptRecord,
) -> Vec<EngineRuntimeReceiptRef> {
    let mut refs = Vec::new();
    push_ref(&mut refs, format!("envelope:{}", dry_run.envelope_id));
    push_ref(
        &mut refs,
        format!("provider-command:{}", dry_run.outcome.command_id.0),
    );
    push_ref(
        &mut refs,
        format!("dispatch-attempt:{}", dry_run.dispatch_attempt.attempt_id.0),
    );
    push_ref(&mut refs, format!("preflight:{}", preflight.preflight_id.0));
    push_ref(
        &mut refs,
        format!("transport-write:{}", write_attempt.attempt_id.0),
    );

    for evidence_ref in dry_run
        .outcome
        .evidence_refs
        .iter()
        .chain(preflight.evidence_refs.iter())
        .chain(write_attempt.evidence_refs.iter())
    {
        push_ref(&mut refs, evidence_ref.clone());
    }

    refs
}

fn push_ref(refs: &mut Vec<EngineRuntimeReceiptRef>, value: String) {
    let receipt_ref = EngineRuntimeReceiptRef::Custom(value);
    if !refs.contains(&receipt_ref) {
        refs.push(receipt_ref);
    }
}

fn live_send_summary(
    preflight: &CodexAppServerLiveSendPreflightRecord,
    write_attempt: &ProviderTransportWriteAttemptRecord,
    status: &CodexAppServerTurnStartLiveSendReceiptStatus,
) -> String {
    format!(
        "Codex turn/start live-send {:?}: preflight_id={}, write_attempt_id={}, raw_payload_retained=false, provider_write_executed=false, retry_scheduled=false, task_mutation_permitted=false",
        status, preflight.preflight_id.0, write_attempt.attempt_id.0
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::{
        admit_codex_turn_start, codex_live_send_preflight, codex_turn_start_envelope,
        codex_turn_start_reactor_dry_run, codex_turn_start_request,
        CodexAppServerLiveSendEvidenceState, CodexAppServerLiveSendOperatorPolicy,
        CodexAppServerLiveSendPreflightInput, CodexAppServerPayloadRetentionPolicy,
        CodexAppServerTurnStartAdmissionInput, CodexAppServerTurnStartDeferredPolicy,
        CodexAppServerTurnStartPromptRef, CodexAppServerTurnStartPromptRetentionPolicy,
        CodexAppServerTurnStartReactorDryRunInput,
    };
    use crate::provider_runtime_orchestration::provider_runtime_projection_readiness;
    use crate::provider_service_runtime::{
        ProviderCommandLaneId, ProviderReactorReadinessState, ProviderRuntimeStreamId,
        ProviderServiceId,
    };
    use crate::provider_transport_write::{
        provider_transport_write_attempt, ProviderTransportWriteAttemptInput,
        ProviderTransportWriteIdempotencyKey, ProviderTransportWritePayloadShape,
        ProviderTransportWritePreflightStatus, ProviderTransportWriteTarget,
    };
    use crate::{provider_runtime_outcome_from_reactor_outcome, ProviderCommandReactorId};
    use nucleus_agent_protocol::AdapterCommandStreamState;
    use nucleus_engine::{EngineRuntimeReceiptRef, EngineRuntimeReceiptStatus};
    use nucleus_orchestration::OrchestrationEventKind;

    #[test]
    fn queued_live_send_attempt_maps_to_receipt_and_event_without_writing() {
        let dry_run = turn_start_dry_run();
        let preflight = codex_live_send_preflight(ready_preflight_input(dry_run.clone()));
        let write_attempt = write_attempt(
            &dry_run,
            &preflight,
            ProviderTransportWritePreflightStatus::Accepted,
        );

        let link = codex_turn_start_live_send_receipt_link(&dry_run, &preflight, &write_attempt);
        let projection = provider_runtime_projection_readiness(
            &provider_runtime_outcome_from_reactor_outcome(&dry_run.outcome),
        );

        assert_eq!(
            link.status,
            CodexAppServerTurnStartLiveSendReceiptStatus::QueuedForWrite
        );
        assert_eq!(link.receipt.status, EngineRuntimeReceiptStatus::Queued);
        assert_eq!(
            link.event.kind,
            OrchestrationEventKind::RuntimeObservationAccepted
        );
        assert_eq!(link.identity.envelope_id, dry_run.envelope_id);
        assert_eq!(
            link.identity.provider_command_id,
            dry_run.outcome.command_id.0
        );
        assert!(link
            .receipt
            .evidence_refs
            .contains(&EngineRuntimeReceiptRef::Custom(format!(
                "preflight:{}",
                preflight.preflight_id.0
            ))));
        assert!(!link.raw_payload_retained);
        assert!(!link.provider_write_executed);
        assert!(!link.retry_scheduled);
        assert!(!link.task_mutation_permitted);
        assert!(!projection.task_mutation_allowed);
    }

    #[test]
    fn blocked_live_send_attempt_stays_inspectable_without_retry() {
        let dry_run = turn_start_dry_run();
        let mut preflight_input = ready_preflight_input(dry_run.clone());
        preflight_input.operator_policy = CodexAppServerLiveSendOperatorPolicy::Disabled;
        let preflight = codex_live_send_preflight(preflight_input);
        let write_attempt = write_attempt(
            &dry_run,
            &preflight,
            ProviderTransportWritePreflightStatus::Blocked("operator policy disabled".to_owned()),
        );

        let link = codex_turn_start_live_send_receipt_link(&dry_run, &preflight, &write_attempt);

        assert!(matches!(
            link.status,
            CodexAppServerTurnStartLiveSendReceiptStatus::Blocked(_)
        ));
        assert_eq!(link.receipt.status, EngineRuntimeReceiptStatus::Blocked);
        assert!(link
            .receipt
            .summary
            .as_deref()
            .unwrap_or_default()
            .contains("retry_scheduled=false"));
        assert!(!link.provider_write_executed);
        assert!(!link.task_mutation_permitted);
    }

    fn write_attempt(
        dry_run: &crate::CodexAppServerTurnStartReactorDryRunRecord,
        preflight: &CodexAppServerLiveSendPreflightRecord,
        preflight_status: ProviderTransportWritePreflightStatus,
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
            preflight_status,
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
            execution_authority: ready("evidence:execution-authority"),
            auth_readiness: ready("evidence:auth"),
            reactor_readiness: ready("evidence:reactor"),
            transport_readiness: ready("evidence:transport"),
            operator_policy: CodexAppServerLiveSendOperatorPolicy::Enabled {
                evidence_ref: "evidence:operator-policy".to_owned(),
            },
            raw_payload_policy_confirmed: true,
        }
    }

    fn ready(evidence_ref: &str) -> CodexAppServerLiveSendEvidenceState {
        CodexAppServerLiveSendEvidenceState::Ready {
            evidence_ref: evidence_ref.to_owned(),
        }
    }

    fn turn_start_dry_run() -> crate::CodexAppServerTurnStartReactorDryRunRecord {
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

        codex_turn_start_reactor_dry_run(CodexAppServerTurnStartReactorDryRunInput {
            envelope,
            reactor_id: ProviderCommandReactorId("provider-reactor:codex".to_owned()),
            service_id: ProviderServiceId("provider-service:codex".to_owned()),
            command_lane_id: ProviderCommandLaneId("provider-command-lane:codex".to_owned()),
            stream_id: Some(ProviderRuntimeStreamId(
                "provider-event-stream:codex".to_owned(),
            )),
            reactor_state: ProviderReactorReadinessState::ReadyForCommands,
            command_stream_state: AdapterCommandStreamState::Accepting,
        })
        .expect("dry run")
    }
}
