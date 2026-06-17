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
    with_local_event_transport_readiness, with_local_sandbox_readiness, EngineHostId,
    HostSpawnReadinessStatus, LocalArtifactStoreBackend, LocalEventTransportBackend,
    LocalSandboxBackend, ProcessInterruptionHostContract, ProjectAuthorityAssignment,
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
    let command_request_id = CommandRequestId("command:request:process-control-gate".to_owned());
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
        evidence_ref: Some(CommandEvidenceRef(
            "evidence:process-control-gate".to_owned(),
        )),
        policy_decision_ref: Some(CommandPolicyDecisionRef("policy:accepted".to_owned())),
        first_sequence: ServerEventSequence(50),
        summary: Some("accepted for process-control gate composition".to_owned()),
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

fn all_other_backends_ready_discovery() -> crate::LocalHostRuntimeDiscovery {
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
    let event_discovery = with_local_event_transport_readiness(
        artifact_discovery,
        LocalEventTransportBackend::new(host()).readiness(),
    )
    .expect("event readiness");

    with_local_sandbox_readiness(
        event_discovery,
        LocalSandboxBackend::read_only(host()).readiness(),
    )
    .expect("sandbox readiness")
}

#[test]
fn local_process_control_backend_reports_read_only_spawn_control_readiness() {
    let backend = LocalProcessControlBackend::read_only(host());
    let readiness = backend.readiness();

    assert!(backend.is_ready_for_read_only_spawn());
    assert!(readiness.supports_future_spawn());
    assert!(readiness.spawn_ready);
    assert!(readiness.timeout_ready);
    assert!(readiness.cancellation_ready);
    assert!(readiness.cleanup_ready);
    assert!(!readiness.implementation_evidence_refs.is_empty());
}

#[test]
fn process_control_readiness_blocks_missing_timeout_cancellation_or_cleanup() {
    let mut missing_timeout = LocalProcessControlBackend::read_only(host());
    missing_timeout.profile.finite_timeout_ready = false;
    let mut missing_cancellation = LocalProcessControlBackend::read_only(host());
    missing_cancellation.profile.cooperative_cancellation_ready = false;
    let mut missing_cleanup = LocalProcessControlBackend::read_only(host());
    missing_cleanup.profile.cleanup_failure_reporting_ready = false;

    assert!(!missing_timeout.readiness().supports_future_spawn());
    assert!(!missing_cancellation.readiness().supports_future_spawn());
    assert!(!missing_cleanup.readiness().supports_future_spawn());
}

#[test]
fn process_control_readiness_blocks_shell_passthrough_and_pty() {
    let mut shell = LocalProcessControlBackend::read_only(host());
    shell.profile.shell_passthrough_allowed = true;
    let mut pty = LocalProcessControlBackend::read_only(host());
    pty.profile.pty_allowed = true;

    assert!(!shell.is_ready_for_read_only_spawn());
    assert!(!shell.readiness().supports_future_spawn());
    assert!(!pty.is_ready_for_read_only_spawn());
    assert!(!pty.readiness().supports_future_spawn());
}

#[test]
fn process_control_readiness_composes_with_runtime_discovery_and_readies_spawn_gate() {
    let discovery = with_local_process_control_readiness(
        all_other_backends_ready_discovery(),
        LocalProcessControlBackend::read_only(host()).readiness(),
    )
    .expect("compose process-control readiness");

    assert_eq!(discovery.status, LocalHostRuntimeDiscoveryStatus::Ready);
    assert!(discovery.process_control_backend.supports_future_spawn());
    assert!(!discovery.findings.contains(
        &LocalHostRuntimeDiscoveryFinding::ProcessControlBackendUnsupported(
            ProcessControlBackendKind::None
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
            summary: Some("all local backends ready".to_owned()),
        });

    assert_eq!(gate.status, HostSpawnReadinessStatus::Ready);
    assert!(gate.blockers.is_empty());
}

#[test]
fn process_control_readiness_composition_rejects_host_mismatch() {
    assert_eq!(
        with_local_process_control_readiness(
            unsupported_local_host_runtime_discovery(host()),
            LocalProcessControlBackend::read_only(EngineHostId("host:other".to_owned()))
                .readiness(),
        )
        .expect_err("host mismatch"),
        LocalProcessControlError::HostMismatch {
            expected: host(),
            actual: EngineHostId("host:other".to_owned()),
        }
    );
}
