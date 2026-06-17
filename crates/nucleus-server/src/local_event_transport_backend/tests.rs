use std::path::PathBuf;
use std::time::Duration;

use nucleus_command_policy::{
    CommandArtifactPayloadClass, CommandCancellationPolicy, CommandCleanupFailurePolicy,
    CommandEnvironmentPolicy, CommandEvidenceRef, CommandInvocation, CommandOutputBoundPolicy,
    CommandOutputRetention, CommandPolicyDecisionRef, CommandProcessInterruptionContract,
    CommandProcessSupervisionEventKind, CommandProcessSupervisionReadiness,
    CommandProcessSupervisionReadinessStatus, CommandProcessSupervisionSurface, CommandRequestId,
    CommandSandboxEnforcement, CommandSandboxProfile, CommandTimeoutPolicy,
    CommandTimeoutStartPolicy,
};
use nucleus_projects::ProjectId;
use tempfile::tempdir;

use super::*;
use crate::{
    accept_process_supervision_request, evaluate_host_spawn_readiness_from_discovery,
    unsupported_local_host_runtime_discovery, with_local_artifact_store_readiness, EngineHostId,
    HostSpawnReadinessBlocker, HostSpawnReadinessStatus, LocalArtifactStoreBackend,
    ProcessControlBackendKind, ProcessEventTransportBackendKind, ProcessInterruptionHostContract,
    ProjectAuthorityAssignment, ProjectAuthorityDomain, ProjectAuthorityMap, SandboxBackendKind,
    ServerEventSequence,
};

fn host() -> EngineHostId {
    EngineHostId("host:local".to_owned())
}

fn project_id() -> ProjectId {
    ProjectId("project:nucleus".to_owned())
}

fn authority_map() -> ProjectAuthorityMap {
    ProjectAuthorityMap {
        project_id: project_id(),
        assignments: vec![ProjectAuthorityAssignment {
            domain: ProjectAuthorityDomain::Execution,
            authoritative_host_id: host(),
            fallback_host_ids: Vec::new(),
            mutation_allowed: true,
            note: Some("local execution authority".to_owned()),
        }],
    }
}

fn invocation(command_request_id: CommandRequestId) -> CommandInvocation {
    CommandInvocation {
        command_request_id,
        executable: "rg".to_owned(),
        argv: vec!["TODO".to_owned()],
        working_directory: PathBuf::from("."),
        timeout: Duration::from_secs(5),
        stdout_limit_bytes: 16 * 1024,
        stderr_limit_bytes: 16 * 1024,
        environment_policy: CommandEnvironmentPolicy::MinimalInheritedSafe,
        sandbox: CommandSandboxProfile::NoFilesystemWrite,
        output_retention: CommandOutputRetention::SummaryOnly,
    }
}

fn accepted_supervisor_decision() -> crate::ProcessSupervisorAcceptanceDecision {
    let command_request_id = CommandRequestId("command:request:event-gate".to_owned());
    let readiness = CommandProcessSupervisionReadiness {
        command_request_id: command_request_id.clone(),
        invocation: Some(invocation(command_request_id)),
        status: CommandProcessSupervisionReadinessStatus::Ready,
        surfaces: vec![
            CommandProcessSupervisionSurface::StructuredInvocation,
            CommandProcessSupervisionSurface::SandboxEnforcement,
            CommandProcessSupervisionSurface::Timeout,
            CommandProcessSupervisionSurface::Cancellation,
            CommandProcessSupervisionSurface::OutputCapture,
        ],
        blockers: Vec::new(),
        timeout_policy: Some(CommandTimeoutPolicy::RequiredFinite),
        cancellation_policy: Some(CommandCancellationPolicy::Cooperative),
        output_bound_policy: Some(CommandOutputBoundPolicy::Truncate),
        sandbox_enforcement: Some(CommandSandboxEnforcement::Enforced),
        summary: Some("supervision ready".to_owned()),
    };

    accept_process_supervision_request(crate::ProcessSupervisorAcceptanceRequest {
        project_id: project_id(),
        execution_host_id: host(),
        authority_map: authority_map(),
        readiness,
        evidence_ref: Some(CommandEvidenceRef("evidence:event-gate".to_owned())),
        policy_decision_ref: Some(CommandPolicyDecisionRef("policy:accepted".to_owned())),
        first_sequence: ServerEventSequence(30),
        summary: Some("accepted for event gate composition".to_owned()),
    })
}

fn interruption_contract() -> ProcessInterruptionHostContract {
    ProcessInterruptionHostContract {
        execution_host_id: host(),
        contract: CommandProcessInterruptionContract {
            timeout_policy: CommandTimeoutPolicy::RequiredFinite,
            timeout_start_policy: CommandTimeoutStartPolicy::BeforeSpawnAttempt,
            cancellation_policy: CommandCancellationPolicy::Cooperative,
            cleanup_failure_policy: CommandCleanupFailurePolicy::EmitCleanupFailedEvent,
            finite_timeout_required: true,
            terminal_event_required: true,
            retry_classification_policy_aware: true,
            summary: Some("ready interruption contract".to_owned()),
        },
        implementation_ref: Some("process-control:future".to_owned()),
    }
}

fn artifact_ready_discovery() -> crate::LocalHostRuntimeDiscovery {
    let temp_dir = tempdir().expect("temp dir");
    let backend = LocalArtifactStoreBackend::new(host(), temp_dir.path());
    backend.prepare_metadata_store().expect("prepare store");

    with_local_artifact_store_readiness(
        unsupported_local_host_runtime_discovery(host()),
        backend.readiness(),
    )
    .expect("artifact readiness")
}

#[test]
fn local_event_transport_backend_reports_required_spawn_event_readiness() {
    let backend = LocalEventTransportBackend::new(host());
    let readiness = backend.readiness();

    assert!(backend.channel.is_ready_for_spawn_events());
    assert!(readiness.supports_required_spawn_events());
    assert_eq!(
        readiness.backend_kind,
        ProcessEventTransportBackendKind::InProcess
    );
    assert!(!readiness.delivery_evidence_refs.is_empty());
    assert!(!readiness.replay_evidence_refs.is_empty());
}

#[test]
fn local_event_transport_readiness_blocks_missing_delivery_or_replay() {
    let mut missing_delivery = LocalEventTransportBackend::new(host());
    missing_delivery.channel.bounded_in_process_delivery = false;
    let mut missing_replay = LocalEventTransportBackend::new(host());
    missing_replay.channel.replay_posture = LocalEventTransportReplayPosture::Unsupported;

    assert!(!missing_delivery
        .readiness()
        .supports_required_spawn_events());
    assert!(!missing_replay.readiness().supports_required_spawn_events());
}

#[test]
fn local_event_transport_readiness_blocks_missing_required_event_kind() {
    let mut backend = LocalEventTransportBackend::new(host());
    backend
        .channel
        .supported_event_kinds
        .retain(|kind| kind != &CommandProcessSupervisionEventKind::CleanupFailed);

    assert!(!backend.channel.is_ready_for_spawn_events());
    assert!(!backend.readiness().supports_required_spawn_events());
}

#[test]
fn event_transport_readiness_composes_with_runtime_discovery_without_enabling_spawn() {
    let discovery = with_local_event_transport_readiness(
        artifact_ready_discovery(),
        LocalEventTransportBackend::new(host()).readiness(),
    )
    .expect("compose event transport readiness");

    assert_eq!(discovery.status, LocalHostRuntimeDiscoveryStatus::Degraded);
    assert!(discovery
        .event_transport_backend
        .supports_required_spawn_events());
    assert!(!discovery.findings.contains(
        &LocalHostRuntimeDiscoveryFinding::EventTransportBackendUnsupported(
            ProcessEventTransportBackendKind::None
        )
    ));

    let authority = authority_map().readiness_for(&host(), &ProjectAuthorityDomain::Execution);
    let gate =
        evaluate_host_spawn_readiness_from_discovery(crate::LocalHostRuntimeDiscoveryGateInput {
            discovery,
            project_id: project_id(),
            authority_readiness: authority,
            supervisor_decision: accepted_supervisor_decision(),
            requested_sandbox_profile: CommandSandboxProfile::NoFilesystemWrite,
            required_artifact_payload_classes: vec![CommandArtifactPayloadClass::SanitizedSummary],
            interruption_contract: Some(interruption_contract()),
            summary: Some("event-backed discovery gate".to_owned()),
        });

    assert_eq!(gate.status, HostSpawnReadinessStatus::Blocked);
    assert_eq!(
        gate.blockers,
        vec![
            HostSpawnReadinessBlocker::SandboxBackendNotReady(SandboxBackendKind::None),
            HostSpawnReadinessBlocker::ProcessControlBackendNotReady(
                ProcessControlBackendKind::None
            ),
        ]
    );
}

#[test]
fn event_transport_readiness_composition_rejects_host_mismatch() {
    assert_eq!(
        with_local_event_transport_readiness(
            unsupported_local_host_runtime_discovery(host()),
            LocalEventTransportBackend::new(EngineHostId("host:other".to_owned())).readiness()
        )
        .expect_err("host mismatch"),
        LocalEventTransportError::HostMismatch {
            expected: host(),
            actual: EngineHostId("host:other".to_owned()),
        }
    );
}
