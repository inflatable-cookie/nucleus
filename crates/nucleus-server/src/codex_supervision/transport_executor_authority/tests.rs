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
    assert!(record
        .blockers
        .contains(&CodexAppServerTransportExecutorAuthorityBlocker::OperatorConfirmationMissing));
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
    input.provider_instance.auth_readiness = CodexAppServerTransportExecutorEvidenceState::Missing;
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
    assert!(record
        .blockers
        .contains(&CodexAppServerTransportExecutorAuthorityBlocker::MissingProviderAuthReadiness));
    assert!(record
        .blockers
        .contains(&CodexAppServerTransportExecutorAuthorityBlocker::RawStreamPolicyUnconfirmed));
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
            scope: CodexAppServerTransportExecutorConfirmationScope::PrepareExecutionHandoffOnly,
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
