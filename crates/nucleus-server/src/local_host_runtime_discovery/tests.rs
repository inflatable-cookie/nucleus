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

use super::*;
use crate::{
    accept_process_supervision_request, ArtifactStoreBackendEvidenceRef, HostSpawnReadinessBlocker,
    HostSpawnReadinessStatus, ProcessControlBackendEvidenceRef, ProcessEventTransportEvidenceRef,
    ProjectAuthorityAssignment, ProjectAuthorityDomain, ProjectAuthorityMap,
    SandboxBackendEvidenceRef, ServerEventSequence,
};

fn host() -> EngineHostId {
    EngineHostId("host:local".to_owned())
}

fn other_host() -> EngineHostId {
    EngineHostId("host:remote".to_owned())
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

fn accepted_supervisor_decision() -> ProcessSupervisorAcceptanceDecision {
    let command_request_id = CommandRequestId("command:request:discovery-gate".to_owned());
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
        evidence_ref: Some(CommandEvidenceRef("evidence:discovery-gate".to_owned())),
        policy_decision_ref: Some(CommandPolicyDecisionRef("policy:accepted".to_owned())),
        first_sequence: ServerEventSequence(10),
        summary: Some("accepted for discovery gate composition".to_owned()),
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

fn sandbox_backend(execution_host_id: EngineHostId) -> SandboxBackendReadiness {
    SandboxBackendReadiness {
        execution_host_id,
        backend_kind: SandboxBackendKind::None,
        enforced_profiles: Vec::new(),
        enforcement: CommandSandboxEnforcement::Unsupported,
        evidence_refs: Vec::new(),
        summary: Some("sandbox backend unsupported".to_owned()),
    }
}

fn unsupported_discovery() -> LocalHostRuntimeDiscovery {
    unsupported_local_host_runtime_discovery(host())
}

#[test]
fn unsupported_local_host_discovery_can_be_represented_without_io() {
    let discovery = unsupported_discovery();

    assert!(discovery.is_unsupported());
    assert!(discovery.descriptors_match_host());
    assert!(discovery.has_descriptor_evidence());
    assert_eq!(discovery.findings.len(), 4);
    assert!(!discovery
        .sandbox_backend
        .supports_future_spawn_for(&CommandSandboxProfile::NoFilesystemWrite));
    assert!(!discovery
        .artifact_store_backend
        .supports_payload_class(&CommandArtifactPayloadClass::SanitizedSummary));
    assert!(!discovery
        .event_transport_backend
        .supports_required_spawn_events());
    assert!(!discovery.process_control_backend.supports_future_spawn());
}

#[test]
fn unsupported_local_host_discovery_fixture_is_deterministic() {
    let first = unsupported_local_host_runtime_discovery(host());
    let second = unsupported_local_host_runtime_discovery(host());

    assert_eq!(first, second);
    assert_eq!(
        first.evidence_refs,
        vec![LocalHostRuntimeDiscoveryEvidenceRef(
            "evidence:host:local:local-host-runtime:unsupported".to_owned()
        )]
    );
    assert!(!first.sandbox_backend.evidence_refs.is_empty());
    assert!(!first
        .artifact_store_backend
        .retention_evidence_refs
        .is_empty());
    assert!(!first
        .artifact_store_backend
        .redaction_evidence_refs
        .is_empty());
    assert!(!first
        .event_transport_backend
        .delivery_evidence_refs
        .is_empty());
    assert!(!first
        .event_transport_backend
        .replay_evidence_refs
        .is_empty());
    assert!(!first
        .process_control_backend
        .implementation_evidence_refs
        .is_empty());
}

#[test]
fn unsupported_discovery_composes_with_spawn_gate_as_backend_blockers() {
    let authority = authority_map().readiness_for(&host(), &ProjectAuthorityDomain::Execution);
    let gate = evaluate_host_spawn_readiness_from_discovery(LocalHostRuntimeDiscoveryGateInput {
        discovery: unsupported_local_host_runtime_discovery(host()),
        project_id: project_id(),
        authority_readiness: authority,
        supervisor_decision: accepted_supervisor_decision(),
        requested_sandbox_profile: CommandSandboxProfile::NoFilesystemWrite,
        required_artifact_payload_classes: vec![CommandArtifactPayloadClass::SanitizedSummary],
        interruption_contract: Some(interruption_contract()),
        summary: Some("discovery-backed host-spawn readiness".to_owned()),
    });

    assert_eq!(gate.status, HostSpawnReadinessStatus::Blocked);
    assert_eq!(
        gate.blockers,
        vec![
            HostSpawnReadinessBlocker::SandboxBackendNotReady(SandboxBackendKind::None),
            HostSpawnReadinessBlocker::ArtifactStoreBackendNotReady(ArtifactStoreBackendKind::None),
            HostSpawnReadinessBlocker::EventTransportBackendNotReady(
                ProcessEventTransportBackendKind::None
            ),
            HostSpawnReadinessBlocker::ProcessControlBackendNotReady(
                ProcessControlBackendKind::None
            ),
        ]
    );
}

#[test]
fn descriptor_host_mismatches_are_reported_as_values() {
    let discovery = LocalHostRuntimeDiscovery {
        sandbox_backend: sandbox_backend(other_host()),
        ..unsupported_discovery()
    };

    assert!(!discovery.descriptors_match_host());
    assert_eq!(
        discovery.descriptor_host_mismatches(),
        vec![LocalHostRuntimeDiscoveryFinding::DescriptorHostMismatch {
            expected: host(),
            actual: other_host(),
        }]
    );
    assert!(!discovery.has_descriptor_evidence());
}

#[test]
fn ready_discovery_can_carry_all_backend_descriptor_groups() {
    let discovery = LocalHostRuntimeDiscovery {
        execution_host_id: host(),
        status: LocalHostRuntimeDiscoveryStatus::Ready,
        sandbox_backend: SandboxBackendReadiness {
            execution_host_id: host(),
            backend_kind: SandboxBackendKind::OsSandbox,
            enforced_profiles: vec![CommandSandboxProfile::NoFilesystemWrite],
            enforcement: CommandSandboxEnforcement::Enforced,
            evidence_refs: vec![SandboxBackendEvidenceRef(
                "evidence:sandbox:no-write".to_owned(),
            )],
            summary: Some("sandbox ready".to_owned()),
        },
        artifact_store_backend: ArtifactStoreBackendReadiness {
            execution_host_id: host(),
            backend_kind: ArtifactStoreBackendKind::Filesystem,
            supported_payload_classes: vec![CommandArtifactPayloadClass::SanitizedSummary],
            payload_storage_ready: true,
            retention_evidence_refs: vec![ArtifactStoreBackendEvidenceRef(
                "evidence:artifact:retention".to_owned(),
            )],
            redaction_evidence_refs: vec![ArtifactStoreBackendEvidenceRef(
                "evidence:artifact:redaction".to_owned(),
            )],
            summary: Some("artifact store ready".to_owned()),
        },
        event_transport_backend: ProcessEventTransportReadiness {
            execution_host_id: host(),
            backend_kind: ProcessEventTransportBackendKind::InProcess,
            supported_event_kinds: vec![
                CommandProcessSupervisionEventKind::Running,
                CommandProcessSupervisionEventKind::Terminal,
                CommandProcessSupervisionEventKind::CleanupFailed,
            ],
            delivery_evidence_refs: vec![ProcessEventTransportEvidenceRef(
                "evidence:event:delivery".to_owned(),
            )],
            replay_evidence_refs: vec![ProcessEventTransportEvidenceRef(
                "evidence:event:replay".to_owned(),
            )],
            summary: Some("event transport ready".to_owned()),
        },
        process_control_backend: ProcessControlBackendReadiness {
            execution_host_id: host(),
            backend_kind: ProcessControlBackendKind::StdProcess,
            spawn_ready: true,
            timeout_ready: true,
            cancellation_ready: true,
            cleanup_ready: true,
            implementation_evidence_refs: vec![ProcessControlBackendEvidenceRef(
                "evidence:process-control".to_owned(),
            )],
            summary: Some("process control ready".to_owned()),
        },
        evidence_refs: vec![LocalHostRuntimeDiscoveryEvidenceRef(
            "evidence:local-host:ready".to_owned(),
        )],
        findings: Vec::new(),
        summary: Some("local host runtime ready".to_owned()),
    };

    assert!(discovery.descriptors_match_host());
    assert!(discovery.has_descriptor_evidence());
    assert!(discovery
        .sandbox_backend
        .supports_future_spawn_for(&CommandSandboxProfile::NoFilesystemWrite));
    assert!(discovery
        .artifact_store_backend
        .supports_payload_class(&CommandArtifactPayloadClass::SanitizedSummary));
    assert!(discovery
        .event_transport_backend
        .supports_required_spawn_events());
    assert!(discovery.process_control_backend.supports_future_spawn());
}
