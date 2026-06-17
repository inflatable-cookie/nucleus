use std::path::PathBuf;
use std::time::Duration;

use nucleus_command_policy::{
    CommandApprovalPolicy, CommandArtifactPayloadClass, CommandAuthorityArea,
    CommandCancellationPolicy, CommandCleanupFailurePolicy, CommandEnvironmentPolicy,
    CommandExecutionRequest, CommandInvocation, CommandOutputBoundPolicy, CommandOutputRetention,
    CommandPolicyDecisionRef, CommandProcessInterruptionContract,
    CommandProcessSupervisionReadiness, CommandProcessSupervisionReadinessStatus,
    CommandProcessSupervisionSurface, CommandRisk, CommandSandboxProfile, CommandScope,
    CommandTimeoutPolicy, CommandTimeoutStartPolicy,
};
use nucleus_projects::ProjectId;
use tempfile::tempdir;

use super::super::LocalReadOnlySpawnInput;
use crate::{
    accept_process_supervision_request, evaluate_host_spawn_readiness_from_discovery,
    unsupported_local_host_runtime_discovery, with_local_artifact_store_readiness,
    with_local_event_transport_readiness, with_local_process_control_readiness,
    with_local_sandbox_readiness, EngineHostId, HostSpawnReadinessGate, LocalArtifactStoreBackend,
    LocalEventTransportBackend, LocalProcessControlBackend, LocalSandboxBackend,
    ProcessInterruptionHostContract, ProjectAuthorityAssignment, ProjectAuthorityDomain,
    ProjectAuthorityMap,
};

pub(super) fn host() -> EngineHostId {
    EngineHostId("host:local".to_owned())
}

pub(super) fn project_id() -> ProjectId {
    ProjectId("project:nucleus".to_owned())
}

pub(super) fn authority_map() -> ProjectAuthorityMap {
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

pub(super) fn request() -> CommandExecutionRequest {
    CommandExecutionRequest {
        id: nucleus_command_policy::CommandRequestId("command:request:spawn".to_owned()),
        policy_id: None,
        authority_area: CommandAuthorityArea::Validation,
        scope: CommandScope::ReadOnlyInspection,
        risk: CommandRisk::Low,
        sandbox: CommandSandboxProfile::NoFilesystemWrite,
        approval: CommandApprovalPolicy::AutoAllowed,
        command_display: Some("echo nucleus".to_owned()),
        working_directory_hint: None,
    }
}

pub(super) fn invocation(executable: &str, argv: Vec<&str>) -> CommandInvocation {
    CommandInvocation {
        command_request_id: request().id,
        executable: executable.to_owned(),
        argv: argv.into_iter().map(str::to_owned).collect(),
        working_directory: std::env::current_dir().expect("current dir"),
        timeout: Duration::from_secs(2),
        stdout_limit_bytes: 64,
        stderr_limit_bytes: 64,
        environment_policy: CommandEnvironmentPolicy::MinimalInheritedSafe,
        sandbox: CommandSandboxProfile::NoFilesystemWrite,
        output_retention: CommandOutputRetention::SummaryOnly,
    }
}

pub(super) fn ready_gate() -> HostSpawnReadinessGate {
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
    let sandbox_discovery = with_local_sandbox_readiness(
        event_discovery,
        LocalSandboxBackend::read_only(host()).readiness(),
    )
    .expect("sandbox readiness");
    let discovery = with_local_process_control_readiness(
        sandbox_discovery,
        LocalProcessControlBackend::read_only(host()).readiness(),
    )
    .expect("process-control readiness");
    let authority = authority_map().readiness_for(&host(), &ProjectAuthorityDomain::Execution);

    evaluate_host_spawn_readiness_from_discovery(crate::LocalHostRuntimeDiscoveryGateInput {
        discovery,
        project_id: project_id(),
        authority_readiness: authority,
        supervisor_decision: accepted_supervisor_decision(),
        requested_sandbox_profile: CommandSandboxProfile::NoFilesystemWrite,
        required_artifact_payload_classes: vec![CommandArtifactPayloadClass::SanitizedSummary],
        interruption_contract: Some(interruption_contract()),
        summary: Some("ready read-only spawn gate".to_owned()),
    })
}

pub(super) fn spawn_input(
    invocation: CommandInvocation,
    host_gate: HostSpawnReadinessGate,
) -> LocalReadOnlySpawnInput {
    LocalReadOnlySpawnInput {
        project_id: project_id(),
        execution_host_id: host(),
        request: request(),
        invocation,
        host_gate,
        first_sequence: crate::runtime_effect_events::ServerEventSequence(100),
    }
}

fn accepted_supervisor_decision() -> crate::ProcessSupervisorAcceptanceDecision {
    let command_request_id = request().id;
    let readiness = CommandProcessSupervisionReadiness {
        command_request_id: command_request_id.clone(),
        invocation: Some(CommandInvocation {
            command_request_id,
            executable: "echo".to_owned(),
            argv: vec!["nucleus".to_owned()],
            working_directory: PathBuf::from("."),
            timeout: Duration::from_secs(2),
            stdout_limit_bytes: 64,
            stderr_limit_bytes: 64,
            environment_policy: CommandEnvironmentPolicy::MinimalInheritedSafe,
            sandbox: CommandSandboxProfile::NoFilesystemWrite,
            output_retention: CommandOutputRetention::SummaryOnly,
        }),
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
        evidence_ref: None,
        policy_decision_ref: Some(CommandPolicyDecisionRef("policy:accepted".to_owned())),
        first_sequence: crate::runtime_effect_events::ServerEventSequence(60),
        summary: Some("accepted for read-only spawn".to_owned()),
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
        implementation_ref: Some("process-control:read-only".to_owned()),
    }
}
