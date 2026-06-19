//! Codex constrained live-send smoke boundary.
//!
//! This boundary decides whether a Codex live-send smoke is eligible for a
//! separately confirmed transport execution. It never writes to Codex stdio,
//! retains raw provider payloads, schedules retries, or mutates task state.

use nucleus_orchestration::OrchestrationEventId;

use crate::provider_transport_write::{
    ProviderTransportWriteAttemptRecord, ProviderTransportWriteAttemptStatus,
};

use super::live_send_preflight::{
    CodexAppServerLiveSendPreflightRecord, CodexAppServerLiveSendPreflightStatus,
};
use super::turn_start_live_send_receipts::{
    CodexAppServerTurnStartLiveSendReceiptLink, CodexAppServerTurnStartLiveSendReceiptStatus,
};

/// Input for the constrained live-send smoke boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerLiveSendSmokeBoundaryInput {
    pub preflight: CodexAppServerLiveSendPreflightRecord,
    pub write_attempt: ProviderTransportWriteAttemptRecord,
    pub receipt_link: CodexAppServerTurnStartLiveSendReceiptLink,
    pub operator_policy: CodexAppServerLiveSendSmokeOperatorPolicy,
    pub raw_payload_policy_confirmed: bool,
    pub task_mutation_requested: bool,
}

/// Separate opt-in policy for the first live-send smoke.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerLiveSendSmokeOperatorPolicy {
    DisabledByDefault,
    Enabled { evidence_ref: String },
}

/// Boundary decision for one constrained live-send smoke.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerLiveSendSmokeBoundaryRecord {
    pub boundary_id: CodexAppServerLiveSendSmokeBoundaryId,
    pub status: CodexAppServerLiveSendSmokeBoundaryStatus,
    pub receipt_id: String,
    pub event_id: OrchestrationEventId,
    pub evidence_refs: Vec<String>,
    pub raw_payload_retained: bool,
    pub provider_write_executed: bool,
    pub retry_scheduled: bool,
    pub task_mutation_permitted: bool,
}

/// Stable id for one live-send smoke boundary decision.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerLiveSendSmokeBoundaryId(pub String);

/// Constrained smoke boundary status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerLiveSendSmokeBoundaryStatus {
    ReadyForOperatorConfirmedExecution,
    Blocked(Vec<CodexAppServerLiveSendSmokeBoundaryBlocker>),
}

/// Why the constrained smoke cannot reach the execution handoff.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerLiveSendSmokeBoundaryBlocker {
    OperatorPolicyDisabled,
    PreflightNotAccepted,
    TransportWriteNotQueued,
    ReceiptLinkBlocked,
    RawPayloadPolicyUnconfirmed,
    TaskMutationRequested,
    ProviderWriteAlreadyExecuted,
}

/// Build the live-send smoke boundary record without executing provider I/O.
pub fn codex_live_send_smoke_boundary(
    input: CodexAppServerLiveSendSmokeBoundaryInput,
) -> CodexAppServerLiveSendSmokeBoundaryRecord {
    let mut blockers = Vec::new();
    let mut evidence_refs = Vec::new();

    match input.operator_policy {
        CodexAppServerLiveSendSmokeOperatorPolicy::DisabledByDefault => {
            blockers.push(CodexAppServerLiveSendSmokeBoundaryBlocker::OperatorPolicyDisabled);
        }
        CodexAppServerLiveSendSmokeOperatorPolicy::Enabled { evidence_ref } => {
            evidence_refs.push(evidence_ref);
        }
    }
    if input.preflight.status != CodexAppServerLiveSendPreflightStatus::AcceptedForTransportAttempt
    {
        blockers.push(CodexAppServerLiveSendSmokeBoundaryBlocker::PreflightNotAccepted);
    }
    if input.write_attempt.status != ProviderTransportWriteAttemptStatus::Queued {
        blockers.push(CodexAppServerLiveSendSmokeBoundaryBlocker::TransportWriteNotQueued);
    }
    if matches!(
        input.receipt_link.status,
        CodexAppServerTurnStartLiveSendReceiptStatus::Blocked(_)
    ) {
        blockers.push(CodexAppServerLiveSendSmokeBoundaryBlocker::ReceiptLinkBlocked);
    }
    if !input.raw_payload_policy_confirmed {
        blockers.push(CodexAppServerLiveSendSmokeBoundaryBlocker::RawPayloadPolicyUnconfirmed);
    }
    if input.task_mutation_requested {
        blockers.push(CodexAppServerLiveSendSmokeBoundaryBlocker::TaskMutationRequested);
    }
    if input.write_attempt.provider_write_executed || input.receipt_link.provider_write_executed {
        blockers.push(CodexAppServerLiveSendSmokeBoundaryBlocker::ProviderWriteAlreadyExecuted);
    }

    evidence_refs.extend(input.preflight.evidence_refs.iter().cloned());
    evidence_refs.extend(input.write_attempt.evidence_refs.iter().cloned());
    evidence_refs.push(format!(
        "receipt:{}",
        input.receipt_link.receipt.receipt_id.0
    ));
    evidence_refs.push(format!("event:{}", input.receipt_link.event.event_id.0));
    evidence_refs.sort();
    evidence_refs.dedup();

    let status = if blockers.is_empty() {
        CodexAppServerLiveSendSmokeBoundaryStatus::ReadyForOperatorConfirmedExecution
    } else {
        CodexAppServerLiveSendSmokeBoundaryStatus::Blocked(blockers)
    };

    CodexAppServerLiveSendSmokeBoundaryRecord {
        boundary_id: CodexAppServerLiveSendSmokeBoundaryId(format!(
            "codex-live-send-smoke-boundary:{}",
            input.write_attempt.attempt_id.0
        )),
        status,
        receipt_id: input.receipt_link.receipt.receipt_id.0,
        event_id: input.receipt_link.event.event_id,
        evidence_refs,
        raw_payload_retained: false,
        provider_write_executed: false,
        retry_scheduled: false,
        task_mutation_permitted: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::{
        admit_codex_turn_start, codex_live_send_preflight, codex_turn_start_live_send_receipt_link,
        codex_turn_start_reactor_dry_run, codex_turn_start_request,
        CodexAppServerLiveSendEvidenceState, CodexAppServerLiveSendOperatorPolicy,
        CodexAppServerLiveSendPreflightInput, CodexAppServerPayloadRetentionPolicy,
        CodexAppServerTurnStartAdmissionInput, CodexAppServerTurnStartDeferredPolicy,
        CodexAppServerTurnStartPromptRef, CodexAppServerTurnStartPromptRetentionPolicy,
        CodexAppServerTurnStartReactorDryRunInput,
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
    use crate::{codex_turn_start_envelope, ProviderCommandReactorId};
    use nucleus_agent_protocol::AdapterCommandStreamState;

    #[test]
    fn live_send_smoke_is_blocked_by_default_without_writing() {
        let input = boundary_input(CodexAppServerLiveSendSmokeOperatorPolicy::DisabledByDefault);

        let boundary = codex_live_send_smoke_boundary(input);

        assert!(matches!(
            boundary.status,
            CodexAppServerLiveSendSmokeBoundaryStatus::Blocked(_)
        ));
        assert!(!boundary.raw_payload_retained);
        assert!(!boundary.provider_write_executed);
        assert!(!boundary.retry_scheduled);
        assert!(!boundary.task_mutation_permitted);
    }

    #[test]
    fn live_send_smoke_requires_operator_policy_and_complete_evidence() {
        let input = boundary_input(CodexAppServerLiveSendSmokeOperatorPolicy::Enabled {
            evidence_ref: "evidence:smoke-operator-policy".to_owned(),
        });

        let boundary = codex_live_send_smoke_boundary(input);

        assert_eq!(
            boundary.status,
            CodexAppServerLiveSendSmokeBoundaryStatus::ReadyForOperatorConfirmedExecution
        );
        assert!(boundary
            .evidence_refs
            .contains(&"evidence:smoke-operator-policy".to_owned()));
        assert!(!boundary.provider_write_executed);
        assert!(!boundary.task_mutation_permitted);
    }

    #[test]
    fn live_send_smoke_blocks_incomplete_preflight_and_task_mutation() {
        let mut input = boundary_input(CodexAppServerLiveSendSmokeOperatorPolicy::Enabled {
            evidence_ref: "evidence:smoke-operator-policy".to_owned(),
        });
        input.raw_payload_policy_confirmed = false;
        input.task_mutation_requested = true;

        let boundary = codex_live_send_smoke_boundary(input);

        assert!(matches!(
            boundary.status,
            CodexAppServerLiveSendSmokeBoundaryStatus::Blocked(blockers)
                if blockers.contains(&CodexAppServerLiveSendSmokeBoundaryBlocker::RawPayloadPolicyUnconfirmed)
                    && blockers.contains(&CodexAppServerLiveSendSmokeBoundaryBlocker::TaskMutationRequested)
        ));
        assert!(!boundary.provider_write_executed);
    }

    fn boundary_input(
        operator_policy: CodexAppServerLiveSendSmokeOperatorPolicy,
    ) -> CodexAppServerLiveSendSmokeBoundaryInput {
        let dry_run = turn_start_dry_run();
        let preflight = codex_live_send_preflight(ready_preflight_input(dry_run.clone()));
        let write_attempt = provider_transport_write_attempt(ProviderTransportWriteAttemptInput {
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
        });
        let receipt_link =
            codex_turn_start_live_send_receipt_link(&dry_run, &preflight, &write_attempt);

        CodexAppServerLiveSendSmokeBoundaryInput {
            preflight,
            write_attempt,
            receipt_link,
            operator_policy,
            raw_payload_policy_confirmed: true,
            task_mutation_requested: false,
        }
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
