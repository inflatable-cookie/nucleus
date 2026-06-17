use std::path::PathBuf;
use std::time::Duration;

use nucleus_command_policy::{
    CommandArtifactPayloadClass, CommandCancellationPolicy, CommandCleanupFailurePolicy,
    CommandEnvironmentPolicy, CommandEvidenceRef, CommandInvocation, CommandOutputBoundPolicy,
    CommandOutputRetention, CommandPolicyDecisionRef, CommandProcessInterruptionContract,
    CommandProcessSupervisionReadiness, CommandProcessSupervisionReadinessStatus,
    CommandProcessSupervisionSurface, CommandRequestId, CommandSandboxProfile,
    CommandTimeoutPolicy, CommandTimeoutStartPolicy,
};
use nucleus_projects::ProjectId;
use tempfile::tempdir;

use super::*;
use crate::{
    accept_process_supervision_request, evaluate_host_spawn_readiness_from_discovery,
    unsupported_local_host_runtime_discovery, with_local_artifact_store_readiness,
    with_local_event_transport_readiness, EngineHostId, HostSpawnReadinessBlocker,
    HostSpawnReadinessStatus, LocalArtifactStoreBackend, LocalEventTransportBackend,
    ProcessControlBackendKind, ProcessInterruptionHostContract, ProjectAuthorityAssignment,
    ProjectAuthorityDomain, ProjectAuthorityMap, ServerEventSequence,
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
    let command_request_id = CommandRequestId("command:request:sandbox-gate".to_owned());
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
        sandbox_enforcement: Some(nucleus_command_policy::CommandSandboxEnforcement::Enforced),
        summary: Some("supervision ready".to_owned()),
    };

    accept_process_supervision_request(crate::ProcessSupervisorAcceptanceRequest {
        project_id: project_id(),
        execution_host_id: host(),
        authority_map: authority_map(),
        readiness,
        evidence_ref: Some(CommandEvidenceRef("evidence:sandbox-gate".to_owned())),
        policy_decision_ref: Some(CommandPolicyDecisionRef("policy:accepted".to_owned())),
        first_sequence: ServerEventSequence(40),
        summary: Some("accepted for sandbox gate composition".to_owned()),
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

fn artifact_and_event_ready_discovery() -> crate::LocalHostRuntimeDiscovery {
    let temp_dir = tempdir().expect("temp dir");
    let artifact_backend = LocalArtifactStoreBackend::new(host(), temp_dir.path());
    artifact_backend
        .prepare_metadata_store()
        .expect("prepare artifact store");
    let artifact_discovery = with_local_artifact_store_readiness(
        unsupported_local_host_runtime_discovery(host()),
        artifact_backend.readiness(),
    )
    .expect("artifact readiness");

    with_local_event_transport_readiness(
        artifact_discovery,
        LocalEventTransportBackend::new(host()).readiness(),
    )
    .expect("event readiness")
}

#[test]
fn local_sandbox_backend_reports_read_only_profile_readiness() {
    let backend = LocalSandboxBackend::read_only(host());
    let readiness = backend.readiness();

    assert_eq!(backend.posture, LocalSandboxBackendPosture::Enforced);
    assert!(readiness.supports_future_spawn_for(&CommandSandboxProfile::NoFilesystemWrite));
    assert!(!readiness.supports_future_spawn_for(&CommandSandboxProfile::ProjectRestricted));
    assert!(!readiness.evidence_refs.is_empty());
}

#[test]
fn advisory_and_unsupported_sandbox_postures_remain_blocked() {
    let advisory = LocalSandboxBackend::advisory_only(host()).readiness();
    let unsupported = LocalSandboxBackend::unsupported(host()).readiness();

    assert!(!advisory.supports_future_spawn_for(&CommandSandboxProfile::NoFilesystemWrite));
    assert!(!unsupported.supports_future_spawn_for(&CommandSandboxProfile::NoFilesystemWrite));
}

#[test]
fn sandbox_readiness_requires_evidence() {
    let mut backend = LocalSandboxBackend::read_only(host());
    backend.supported_profiles.clear();

    assert!(!backend
        .readiness()
        .supports_future_spawn_for(&CommandSandboxProfile::NoFilesystemWrite));
}

#[test]
fn sandbox_readiness_composes_with_runtime_discovery_without_enabling_spawn() {
    let discovery = with_local_sandbox_readiness(
        artifact_and_event_ready_discovery(),
        LocalSandboxBackend::read_only(host()).readiness(),
    )
    .expect("compose sandbox readiness");

    assert_eq!(discovery.status, LocalHostRuntimeDiscoveryStatus::Degraded);
    assert!(discovery
        .sandbox_backend
        .supports_future_spawn_for(&CommandSandboxProfile::NoFilesystemWrite));
    assert!(!discovery.findings.contains(
        &LocalHostRuntimeDiscoveryFinding::SandboxBackendUnsupported(SandboxBackendKind::None)
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
            summary: Some("sandbox-backed discovery gate".to_owned()),
        });

    assert_eq!(gate.status, HostSpawnReadinessStatus::Blocked);
    assert_eq!(
        gate.blockers,
        vec![HostSpawnReadinessBlocker::ProcessControlBackendNotReady(
            ProcessControlBackendKind::None
        ),]
    );
}

#[test]
fn sandbox_readiness_composition_rejects_host_mismatch() {
    assert_eq!(
        with_local_sandbox_readiness(
            unsupported_local_host_runtime_discovery(host()),
            LocalSandboxBackend::read_only(EngineHostId("host:other".to_owned())).readiness(),
        )
        .expect_err("host mismatch"),
        LocalSandboxError::HostMismatch {
            expected: host(),
            actual: EngineHostId("host:other".to_owned()),
        }
    );
}
