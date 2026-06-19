//! Codex transport executor authority records.
//!
//! These records decide whether a Codex `turn/start` transport execution
//! handoff may be prepared. They do not write to Codex stdio, retain raw
//! payloads or streams, schedule retries, or mutate task state.

use crate::host_authority::{EngineHostId, HostAuthorityReadiness, HostAuthorityReadinessStatus};
use crate::provider_service_runtime::ProviderServiceId;
use crate::provider_transport_write::{
    ProviderTransportWriteAttemptRecord, ProviderTransportWriteAttemptStatus,
};

use super::live_send_preflight::{
    CodexAppServerLiveSendPreflightRecord, CodexAppServerLiveSendPreflightStatus,
};

/// Stable id for one Codex transport executor authority record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerTransportExecutorAuthorityId(pub String);

/// Input for assessing Codex transport executor authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTransportExecutorAuthorityInput {
    pub preflight: CodexAppServerLiveSendPreflightRecord,
    pub write_attempt: ProviderTransportWriteAttemptRecord,
    pub execution_host_authority: HostAuthorityReadiness,
    pub provider_instance: CodexAppServerTransportExecutorProviderAuthority,
    pub operator_confirmation: CodexAppServerTransportExecutorOperatorConfirmation,
    pub raw_payload_policy_confirmed: bool,
    pub raw_stream_policy_confirmed: bool,
    pub task_mutation_requested: bool,
}

/// Provider instance authority evidence for the transport executor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTransportExecutorProviderAuthority {
    pub provider_instance_id: String,
    pub service_id: Option<ProviderServiceId>,
    pub auth_readiness: CodexAppServerTransportExecutorEvidenceState,
    pub transport_readiness: CodexAppServerTransportExecutorEvidenceState,
    pub evidence_refs: Vec<String>,
}

/// Evidence state for one executor-authority dimension.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTransportExecutorEvidenceState {
    Ready { evidence_ref: String },
    Missing,
    Stale { evidence_ref: String },
    Blocked { reason: String },
}

/// Operator confirmation for the transport executor handoff.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTransportExecutorOperatorConfirmation {
    Missing,
    Confirmed {
        operator_ref: String,
        evidence_ref: String,
        scope: CodexAppServerTransportExecutorConfirmationScope,
    },
}

/// Scope of an operator confirmation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTransportExecutorConfirmationScope {
    PrepareExecutionHandoffOnly,
    RealProviderWriteSmoke,
}

/// Authority decision for Codex transport executor handoff.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTransportExecutorAuthorityRecord {
    pub authority_id: CodexAppServerTransportExecutorAuthorityId,
    pub execution_host_id: EngineHostId,
    pub provider_instance_id: String,
    pub service_id: Option<ProviderServiceId>,
    pub preflight_id: String,
    pub write_attempt_id: String,
    pub status: CodexAppServerTransportExecutorAuthorityStatus,
    pub blockers: Vec<CodexAppServerTransportExecutorAuthorityBlocker>,
    pub evidence_refs: Vec<String>,
    pub provider_write_executed: bool,
    pub raw_payload_retained: bool,
    pub raw_stream_retained: bool,
    pub task_mutation_permitted: bool,
}

/// Transport executor authority status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTransportExecutorAuthorityStatus {
    ReadyForExecutionHandoff,
    Blocked,
}

/// Why Codex transport execution cannot be handed off.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTransportExecutorAuthorityBlocker {
    ExecutionHostAuthorityNotReady(HostAuthorityReadinessStatus),
    ProviderServiceMissing,
    ProviderServiceMismatch,
    MissingProviderAuthReadiness,
    StaleProviderAuthReadiness,
    ProviderAuthBlocked(String),
    MissingTransportReadiness,
    StaleTransportReadiness,
    TransportReadinessBlocked(String),
    OperatorConfirmationMissing,
    PreflightNotAccepted,
    TransportWriteNotQueued,
    RawPayloadPolicyUnconfirmed,
    RawStreamPolicyUnconfirmed,
    TaskMutationRequested,
    ProviderWriteAlreadyExecuted,
}

/// Assess Codex transport executor authority without executing provider I/O.
pub fn codex_transport_executor_authority(
    input: CodexAppServerTransportExecutorAuthorityInput,
) -> CodexAppServerTransportExecutorAuthorityRecord {
    let mut blockers = Vec::new();
    let mut evidence_refs = Vec::new();

    if input.execution_host_authority.status != HostAuthorityReadinessStatus::Ready {
        blockers.push(
            CodexAppServerTransportExecutorAuthorityBlocker::ExecutionHostAuthorityNotReady(
                input.execution_host_authority.status.clone(),
            ),
        );
    }
    match &input.provider_instance.service_id {
        None => {
            blockers.push(CodexAppServerTransportExecutorAuthorityBlocker::ProviderServiceMissing)
        }
        Some(service_id) if service_id != &input.write_attempt.service_id => {
            blockers.push(CodexAppServerTransportExecutorAuthorityBlocker::ProviderServiceMismatch);
        }
        Some(_) => {}
    }

    collect_executor_evidence(
        &input.provider_instance.auth_readiness,
        &mut evidence_refs,
        &mut blockers,
        CodexAppServerTransportExecutorAuthorityBlocker::MissingProviderAuthReadiness,
        CodexAppServerTransportExecutorAuthorityBlocker::StaleProviderAuthReadiness,
        CodexAppServerTransportExecutorAuthorityBlocker::ProviderAuthBlocked,
    );
    collect_executor_evidence(
        &input.provider_instance.transport_readiness,
        &mut evidence_refs,
        &mut blockers,
        CodexAppServerTransportExecutorAuthorityBlocker::MissingTransportReadiness,
        CodexAppServerTransportExecutorAuthorityBlocker::StaleTransportReadiness,
        CodexAppServerTransportExecutorAuthorityBlocker::TransportReadinessBlocked,
    );

    match input.operator_confirmation {
        CodexAppServerTransportExecutorOperatorConfirmation::Missing => blockers
            .push(CodexAppServerTransportExecutorAuthorityBlocker::OperatorConfirmationMissing),
        CodexAppServerTransportExecutorOperatorConfirmation::Confirmed {
            operator_ref,
            evidence_ref,
            scope,
        } => {
            evidence_refs.push(format!("operator:{operator_ref}"));
            evidence_refs.push(format!("operator-confirmation:{scope:?}"));
            evidence_refs.push(evidence_ref);
        }
    }
    if input.preflight.status != CodexAppServerLiveSendPreflightStatus::AcceptedForTransportAttempt
    {
        blockers.push(CodexAppServerTransportExecutorAuthorityBlocker::PreflightNotAccepted);
    }
    if input.write_attempt.status != ProviderTransportWriteAttemptStatus::Queued {
        blockers.push(CodexAppServerTransportExecutorAuthorityBlocker::TransportWriteNotQueued);
    }
    if !input.raw_payload_policy_confirmed {
        blockers.push(CodexAppServerTransportExecutorAuthorityBlocker::RawPayloadPolicyUnconfirmed);
    }
    if !input.raw_stream_policy_confirmed {
        blockers.push(CodexAppServerTransportExecutorAuthorityBlocker::RawStreamPolicyUnconfirmed);
    }
    if input.task_mutation_requested {
        blockers.push(CodexAppServerTransportExecutorAuthorityBlocker::TaskMutationRequested);
    }
    if input.write_attempt.provider_write_executed {
        blockers
            .push(CodexAppServerTransportExecutorAuthorityBlocker::ProviderWriteAlreadyExecuted);
    }

    evidence_refs.extend(input.preflight.evidence_refs.iter().cloned());
    evidence_refs.extend(input.write_attempt.evidence_refs.iter().cloned());
    evidence_refs.extend(input.provider_instance.evidence_refs.iter().cloned());
    evidence_refs.sort();
    evidence_refs.dedup();

    let status = if blockers.is_empty() {
        CodexAppServerTransportExecutorAuthorityStatus::ReadyForExecutionHandoff
    } else {
        CodexAppServerTransportExecutorAuthorityStatus::Blocked
    };

    CodexAppServerTransportExecutorAuthorityRecord {
        authority_id: CodexAppServerTransportExecutorAuthorityId(format!(
            "codex-transport-executor-authority:{}",
            input.write_attempt.attempt_id.0
        )),
        execution_host_id: input.execution_host_authority.host_id,
        provider_instance_id: input.provider_instance.provider_instance_id,
        service_id: input.provider_instance.service_id,
        preflight_id: input.preflight.preflight_id.0,
        write_attempt_id: input.write_attempt.attempt_id.0,
        status,
        blockers,
        evidence_refs,
        provider_write_executed: false,
        raw_payload_retained: false,
        raw_stream_retained: false,
        task_mutation_permitted: false,
    }
}

fn collect_executor_evidence(
    state: &CodexAppServerTransportExecutorEvidenceState,
    evidence_refs: &mut Vec<String>,
    blockers: &mut Vec<CodexAppServerTransportExecutorAuthorityBlocker>,
    missing: CodexAppServerTransportExecutorAuthorityBlocker,
    stale: CodexAppServerTransportExecutorAuthorityBlocker,
    blocked: fn(String) -> CodexAppServerTransportExecutorAuthorityBlocker,
) {
    match state {
        CodexAppServerTransportExecutorEvidenceState::Ready { evidence_ref } => {
            evidence_refs.push(evidence_ref.clone());
        }
        CodexAppServerTransportExecutorEvidenceState::Missing => blockers.push(missing),
        CodexAppServerTransportExecutorEvidenceState::Stale { evidence_ref } => {
            evidence_refs.push(evidence_ref.clone());
            blockers.push(stale);
        }
        CodexAppServerTransportExecutorEvidenceState::Blocked { reason } => {
            blockers.push(blocked(reason.clone()));
        }
    }
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
    use crate::host_authority::{
        ProjectAuthorityAssignment, ProjectAuthorityDomain, ProjectAuthorityMap,
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
    fn transport_executor_authority_blocks_by_default_without_writing() {
        let mut input = authority_input();
        input.operator_confirmation = CodexAppServerTransportExecutorOperatorConfirmation::Missing;

        let record = codex_transport_executor_authority(input);

        assert_eq!(
            record.status,
            CodexAppServerTransportExecutorAuthorityStatus::Blocked
        );
        assert!(record.blockers.contains(
            &CodexAppServerTransportExecutorAuthorityBlocker::OperatorConfirmationMissing
        ));
        assert!(!record.provider_write_executed);
        assert!(!record.raw_payload_retained);
        assert!(!record.raw_stream_retained);
        assert!(!record.task_mutation_permitted);
    }

    #[test]
    fn transport_executor_authority_allows_confirmed_handoff_only() {
        let record = codex_transport_executor_authority(authority_input());

        assert_eq!(
            record.status,
            CodexAppServerTransportExecutorAuthorityStatus::ReadyForExecutionHandoff
        );
        assert!(record.blockers.is_empty());
        assert!(record
            .evidence_refs
            .contains(&"evidence:operator-confirmation".to_owned()));
        assert!(!record.provider_write_executed);
        assert!(!record.task_mutation_permitted);
    }

    #[test]
    fn transport_executor_authority_blocks_bad_host_provider_and_policy() {
        let mut input = authority_input();
        input.execution_host_authority =
            authority_map(false).readiness_for(&host(), &ProjectAuthorityDomain::Execution);
        input.provider_instance.service_id =
            Some(ProviderServiceId("provider-service:wrong".to_owned()));
        input.provider_instance.auth_readiness =
            CodexAppServerTransportExecutorEvidenceState::Missing;
        input.raw_stream_policy_confirmed = false;
        input.task_mutation_requested = true;

        let record = codex_transport_executor_authority(input);

        assert_eq!(
            record.status,
            CodexAppServerTransportExecutorAuthorityStatus::Blocked
        );
        assert!(record.blockers.iter().any(|blocker| matches!(
            blocker,
            CodexAppServerTransportExecutorAuthorityBlocker::ExecutionHostAuthorityNotReady(_)
        )));
        assert!(record
            .blockers
            .contains(&CodexAppServerTransportExecutorAuthorityBlocker::ProviderServiceMismatch));
        assert!(record.blockers.contains(
            &CodexAppServerTransportExecutorAuthorityBlocker::MissingProviderAuthReadiness
        ));
        assert!(record.blockers.contains(
            &CodexAppServerTransportExecutorAuthorityBlocker::RawStreamPolicyUnconfirmed
        ));
        assert!(record
            .blockers
            .contains(&CodexAppServerTransportExecutorAuthorityBlocker::TaskMutationRequested));
        assert!(!record.provider_write_executed);
    }

    fn authority_input() -> CodexAppServerTransportExecutorAuthorityInput {
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

        CodexAppServerTransportExecutorAuthorityInput {
            preflight,
            write_attempt,
            execution_host_authority: authority_map(true)
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
