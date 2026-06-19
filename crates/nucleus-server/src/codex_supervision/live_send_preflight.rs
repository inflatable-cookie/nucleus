//! Codex live-send preflight records.
//!
//! Preflight records gate live provider writes before transport execution. They
//! do not write to Codex stdio, retain raw payloads, or mutate task state.

use crate::provider_command_reactor::{
    ProviderCommandDispatchAttemptRecord, ProviderCommandDispatchAttemptStatus,
    ProviderCommandReactorOutcomeRecord,
};

/// Stable id for one Codex live-send preflight record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerLiveSendPreflightId(pub String);

/// Evidence-backed input for Codex live-send preflight.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerLiveSendPreflightInput {
    pub reactor_outcome: ProviderCommandReactorOutcomeRecord,
    pub dispatch_attempt: ProviderCommandDispatchAttemptRecord,
    pub execution_authority: CodexAppServerLiveSendEvidenceState,
    pub auth_readiness: CodexAppServerLiveSendEvidenceState,
    pub reactor_readiness: CodexAppServerLiveSendEvidenceState,
    pub transport_readiness: CodexAppServerLiveSendEvidenceState,
    pub operator_policy: CodexAppServerLiveSendOperatorPolicy,
    pub raw_payload_policy_confirmed: bool,
}

/// Evidence state for one preflight dimension.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerLiveSendEvidenceState {
    Ready { evidence_ref: String },
    Missing,
    Stale { evidence_ref: String },
    Blocked { reason: String },
}

/// Operator policy for live provider send.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerLiveSendOperatorPolicy {
    Disabled,
    Enabled { evidence_ref: String },
}

/// Live-send preflight record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerLiveSendPreflightRecord {
    pub preflight_id: CodexAppServerLiveSendPreflightId,
    pub command_id: String,
    pub dispatch_attempt_id: String,
    pub reactor_outcome_id: String,
    pub status: CodexAppServerLiveSendPreflightStatus,
    pub blockers: Vec<CodexAppServerLiveSendPreflightBlocker>,
    pub evidence_refs: Vec<String>,
    pub provider_write_started: bool,
    pub raw_payload_retained: bool,
    pub task_mutation_permitted: bool,
}

/// Live-send preflight status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerLiveSendPreflightStatus {
    AcceptedForTransportAttempt,
    Blocked,
}

/// Why Codex live send cannot proceed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerLiveSendPreflightBlocker {
    DispatchNotDryRunCompleted,
    ReactorOutcomeAlreadyAttemptedLiveSend,
    MissingExecutionAuthority,
    StaleExecutionAuthority,
    ExecutionAuthorityBlocked(String),
    MissingAuthReadiness,
    StaleAuthReadiness,
    AuthReadinessBlocked(String),
    MissingReactorReadiness,
    StaleReactorReadiness,
    ReactorReadinessBlocked(String),
    MissingTransportReadiness,
    StaleTransportReadiness,
    TransportReadinessBlocked(String),
    OperatorPolicyDisabled,
    RawPayloadPolicyUnconfirmed,
}

/// Assess Codex live-send readiness without writing to the provider.
pub fn codex_live_send_preflight(
    input: CodexAppServerLiveSendPreflightInput,
) -> CodexAppServerLiveSendPreflightRecord {
    let mut blockers = Vec::new();
    let mut evidence_refs = Vec::new();

    if input.dispatch_attempt.status != ProviderCommandDispatchAttemptStatus::DryRunCompleted {
        blockers.push(CodexAppServerLiveSendPreflightBlocker::DispatchNotDryRunCompleted);
    }
    if input.reactor_outcome.live_send_attempted {
        blockers
            .push(CodexAppServerLiveSendPreflightBlocker::ReactorOutcomeAlreadyAttemptedLiveSend);
    }

    collect_evidence(
        &input.execution_authority,
        &mut evidence_refs,
        &mut blockers,
        CodexAppServerLiveSendPreflightBlocker::MissingExecutionAuthority,
        CodexAppServerLiveSendPreflightBlocker::StaleExecutionAuthority,
        CodexAppServerLiveSendPreflightBlocker::ExecutionAuthorityBlocked,
    );
    collect_evidence(
        &input.auth_readiness,
        &mut evidence_refs,
        &mut blockers,
        CodexAppServerLiveSendPreflightBlocker::MissingAuthReadiness,
        CodexAppServerLiveSendPreflightBlocker::StaleAuthReadiness,
        CodexAppServerLiveSendPreflightBlocker::AuthReadinessBlocked,
    );
    collect_evidence(
        &input.reactor_readiness,
        &mut evidence_refs,
        &mut blockers,
        CodexAppServerLiveSendPreflightBlocker::MissingReactorReadiness,
        CodexAppServerLiveSendPreflightBlocker::StaleReactorReadiness,
        CodexAppServerLiveSendPreflightBlocker::ReactorReadinessBlocked,
    );
    collect_evidence(
        &input.transport_readiness,
        &mut evidence_refs,
        &mut blockers,
        CodexAppServerLiveSendPreflightBlocker::MissingTransportReadiness,
        CodexAppServerLiveSendPreflightBlocker::StaleTransportReadiness,
        CodexAppServerLiveSendPreflightBlocker::TransportReadinessBlocked,
    );

    match input.operator_policy {
        CodexAppServerLiveSendOperatorPolicy::Disabled => {
            blockers.push(CodexAppServerLiveSendPreflightBlocker::OperatorPolicyDisabled);
        }
        CodexAppServerLiveSendOperatorPolicy::Enabled { evidence_ref } => {
            evidence_refs.push(evidence_ref);
        }
    }
    if !input.raw_payload_policy_confirmed {
        blockers.push(CodexAppServerLiveSendPreflightBlocker::RawPayloadPolicyUnconfirmed);
    }

    let status = if blockers.is_empty() {
        CodexAppServerLiveSendPreflightStatus::AcceptedForTransportAttempt
    } else {
        CodexAppServerLiveSendPreflightStatus::Blocked
    };

    CodexAppServerLiveSendPreflightRecord {
        preflight_id: CodexAppServerLiveSendPreflightId(format!(
            "codex-live-send-preflight:{}",
            input.reactor_outcome.command_id.0
        )),
        command_id: input.reactor_outcome.command_id.0,
        dispatch_attempt_id: input.dispatch_attempt.attempt_id.0,
        reactor_outcome_id: input.reactor_outcome.outcome_id.0,
        status,
        blockers,
        evidence_refs,
        provider_write_started: false,
        raw_payload_retained: false,
        task_mutation_permitted: false,
    }
}

fn collect_evidence(
    state: &CodexAppServerLiveSendEvidenceState,
    evidence_refs: &mut Vec<String>,
    blockers: &mut Vec<CodexAppServerLiveSendPreflightBlocker>,
    missing: CodexAppServerLiveSendPreflightBlocker,
    stale: CodexAppServerLiveSendPreflightBlocker,
    blocked: fn(String) -> CodexAppServerLiveSendPreflightBlocker,
) {
    match state {
        CodexAppServerLiveSendEvidenceState::Ready { evidence_ref } => {
            evidence_refs.push(evidence_ref.clone());
        }
        CodexAppServerLiveSendEvidenceState::Missing => blockers.push(missing),
        CodexAppServerLiveSendEvidenceState::Stale { evidence_ref } => {
            evidence_refs.push(evidence_ref.clone());
            blockers.push(stale);
        }
        CodexAppServerLiveSendEvidenceState::Blocked { reason } => {
            blockers.push(blocked(reason.clone()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::{
        admit_codex_turn_start, codex_turn_start_envelope, codex_turn_start_reactor_dry_run,
        codex_turn_start_request, CodexAppServerPayloadRetentionPolicy,
        CodexAppServerTurnStartAdmissionInput, CodexAppServerTurnStartDeferredPolicy,
        CodexAppServerTurnStartPromptRef, CodexAppServerTurnStartPromptRetentionPolicy,
        CodexAppServerTurnStartReactorDryRunInput,
    };
    use crate::provider_service_runtime::{
        ProviderCommandLaneId, ProviderReactorReadinessState, ProviderRuntimeStreamId,
        ProviderServiceId,
    };
    use crate::ProviderCommandReactorId;
    use nucleus_agent_protocol::AdapterCommandStreamState;

    #[test]
    fn live_send_preflight_accepts_complete_evidence_without_writing() {
        let dry_run = turn_start_dry_run();
        let preflight = codex_live_send_preflight(ready_input(dry_run));

        assert_eq!(
            preflight.status,
            CodexAppServerLiveSendPreflightStatus::AcceptedForTransportAttempt
        );
        assert_eq!(preflight.evidence_refs.len(), 5);
        assert!(!preflight.provider_write_started);
        assert!(!preflight.raw_payload_retained);
        assert!(!preflight.task_mutation_permitted);
    }

    #[test]
    fn live_send_preflight_blocks_missing_readiness_or_operator_policy() {
        let dry_run = turn_start_dry_run();
        let mut input = ready_input(dry_run);
        input.auth_readiness = CodexAppServerLiveSendEvidenceState::Missing;
        input.transport_readiness = CodexAppServerLiveSendEvidenceState::Stale {
            evidence_ref: "evidence:old-transport".to_owned(),
        };
        input.operator_policy = CodexAppServerLiveSendOperatorPolicy::Disabled;

        let preflight = codex_live_send_preflight(input);

        assert_eq!(
            preflight.status,
            CodexAppServerLiveSendPreflightStatus::Blocked
        );
        assert!(preflight
            .blockers
            .contains(&CodexAppServerLiveSendPreflightBlocker::MissingAuthReadiness));
        assert!(preflight
            .blockers
            .contains(&CodexAppServerLiveSendPreflightBlocker::StaleTransportReadiness));
        assert!(preflight
            .blockers
            .contains(&CodexAppServerLiveSendPreflightBlocker::OperatorPolicyDisabled));
        assert!(!preflight.provider_write_started);
    }

    fn ready_input(
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
