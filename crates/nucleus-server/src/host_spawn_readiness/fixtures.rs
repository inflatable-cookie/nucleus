use std::path::PathBuf;
use std::time::Duration;

use nucleus_command_policy::{
    CommandArtifactPayloadClass, CommandCancellationPolicy, CommandCleanupFailurePolicy,
    CommandEnvironmentPolicy, CommandEvidenceRef, CommandInvocation, CommandOutputBoundPolicy,
    CommandOutputRetention, CommandPolicyDecisionRef, CommandProcessInterruptionContract,
    CommandProcessSupervisionEventKind, CommandProcessSupervisionReadiness,
    CommandProcessSupervisionReadinessStatus, CommandProcessSupervisionSurface, CommandRequestId,
    CommandSandboxProfile, CommandTimeoutPolicy, CommandTimeoutStartPolicy,
};
use nucleus_projects::ProjectId;

use super::HostSpawnReadinessInput;
use crate::{
    accept_process_supervision_request, ArtifactStoreBackendEvidenceRef, ArtifactStoreBackendKind,
    ArtifactStoreBackendReadiness, EngineHostId, ProcessControlBackendEvidenceRef,
    ProcessControlBackendKind, ProcessControlBackendReadiness, ProcessEventTransportBackendKind,
    ProcessEventTransportEvidenceRef, ProcessEventTransportReadiness,
    ProcessInterruptionHostContract, ProjectAuthorityAssignment, ProjectAuthorityDomain,
    ProjectAuthorityMap, SandboxBackendEvidenceRef, SandboxBackendKind, SandboxBackendReadiness,
    ServerEventSequence,
};

pub(super) fn host() -> EngineHostId {
    EngineHostId("host:local".to_owned())
}

pub(super) fn project_id() -> ProjectId {
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
            note: None,
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

pub(super) fn sandbox_backend(backend_kind: SandboxBackendKind) -> SandboxBackendReadiness {
    SandboxBackendReadiness {
        execution_host_id: host(),
        backend_kind,
        enforced_profiles: vec![CommandSandboxProfile::NoFilesystemWrite],
        enforcement: nucleus_command_policy::CommandSandboxEnforcement::Enforced,
        evidence_refs: vec![SandboxBackendEvidenceRef(
            "evidence:sandbox:no-write".to_owned(),
        )],
        summary: Some("sandbox backend ready".to_owned()),
    }
}

fn artifact_store_backend(backend_kind: ArtifactStoreBackendKind) -> ArtifactStoreBackendReadiness {
    ArtifactStoreBackendReadiness {
        execution_host_id: host(),
        backend_kind,
        supported_payload_classes: vec![CommandArtifactPayloadClass::SanitizedSummary],
        payload_storage_ready: true,
        retention_evidence_refs: vec![ArtifactStoreBackendEvidenceRef(
            "evidence:artifact:retention".to_owned(),
        )],
        redaction_evidence_refs: vec![ArtifactStoreBackendEvidenceRef(
            "evidence:artifact:redaction".to_owned(),
        )],
        summary: Some("artifact store ready".to_owned()),
    }
}

fn event_transport_backend(
    backend_kind: ProcessEventTransportBackendKind,
) -> ProcessEventTransportReadiness {
    ProcessEventTransportReadiness {
        execution_host_id: host(),
        backend_kind,
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
    }
}

fn process_control_backend(
    backend_kind: ProcessControlBackendKind,
) -> ProcessControlBackendReadiness {
    ProcessControlBackendReadiness {
        execution_host_id: host(),
        backend_kind,
        spawn_ready: true,
        timeout_ready: true,
        cancellation_ready: true,
        cleanup_ready: true,
        implementation_evidence_refs: vec![ProcessControlBackendEvidenceRef(
            "evidence:process-control".to_owned(),
        )],
        summary: Some("process control ready".to_owned()),
    }
}

pub(super) fn ready_input(sandbox_backend: SandboxBackendReadiness) -> HostSpawnReadinessInput {
    let command_request_id = CommandRequestId("command:request:spawn-gate".to_owned());
    let authority_map = authority_map();
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
    let supervisor_decision =
        accept_process_supervision_request(crate::ProcessSupervisorAcceptanceRequest {
            project_id: project_id(),
            execution_host_id: host(),
            authority_map: authority_map.clone(),
            readiness,
            evidence_ref: Some(CommandEvidenceRef("evidence:spawn-gate".to_owned())),
            policy_decision_ref: Some(CommandPolicyDecisionRef("policy:accepted".to_owned())),
            first_sequence: ServerEventSequence(1),
            summary: Some("accepted for readiness gate".to_owned()),
        });

    HostSpawnReadinessInput {
        project_id: project_id(),
        execution_host_id: host(),
        authority_readiness: authority_map
            .readiness_for(&host(), &ProjectAuthorityDomain::Execution),
        supervisor_decision,
        requested_sandbox_profile: CommandSandboxProfile::NoFilesystemWrite,
        sandbox_backend,
        artifact_store_backend: artifact_store_backend(ArtifactStoreBackendKind::Filesystem),
        required_artifact_payload_classes: vec![CommandArtifactPayloadClass::SanitizedSummary],
        event_transport_backend: event_transport_backend(
            ProcessEventTransportBackendKind::InProcess,
        ),
        interruption_contract: Some(interruption_contract()),
        process_control_backend: process_control_backend(ProcessControlBackendKind::StdProcess),
        summary: Some("host-spawn readiness gate".to_owned()),
    }
}
