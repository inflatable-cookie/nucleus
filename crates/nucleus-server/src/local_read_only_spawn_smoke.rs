//! Deterministic local read-only spawn smoke input.
//!
//! The smoke path composes the same readiness descriptors used by the spawn
//! boundary tests and builds one harmless structured command.

use std::path::PathBuf;
use std::time::Duration;

use nucleus_command_policy::{
    CommandApprovalPolicy, CommandArtifactPayloadClass, CommandAuthorityArea,
    CommandCancellationPolicy, CommandCleanupFailurePolicy, CommandEnvironmentPolicy,
    CommandExecutionRequest, CommandInvocation, CommandOutputBoundPolicy, CommandOutputRetention,
    CommandPolicyDecisionRef, CommandPolicyId, CommandProcessInterruptionContract,
    CommandProcessSupervisionReadiness, CommandProcessSupervisionReadinessStatus,
    CommandProcessSupervisionSurface, CommandRequestId, CommandRisk, CommandSandboxProfile,
    CommandScope, CommandTimeoutPolicy, CommandTimeoutStartPolicy,
};
use nucleus_core::RevisionId;
use nucleus_local_store::RevisionExpectation;
use nucleus_projects::ProjectId;

use crate::{
    accept_process_supervision_request, evaluate_host_spawn_readiness_from_discovery,
    unsupported_local_host_runtime_discovery, with_local_artifact_store_readiness,
    with_local_event_transport_readiness, with_local_process_control_readiness,
    with_local_sandbox_readiness, EngineHostId, LocalArtifactStoreBackend, LocalArtifactStoreError,
    LocalEventTransportBackend, LocalProcessControlBackend, LocalReadOnlySpawnInput,
    LocalSandboxBackend, ProcessInterruptionHostContract, ProcessSupervisorAcceptanceDecision,
    ProcessSupervisorAcceptanceRequest, ProjectAuthorityAssignment, ProjectAuthorityDomain,
    ProjectAuthorityMap, ServerReadOnlySpawnInput,
};

/// Inputs that determine the local smoke execution environment.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalReadOnlySpawnSmokeInput {
    pub project_id: ProjectId,
    pub execution_host_id: EngineHostId,
    pub working_directory: PathBuf,
    pub artifact_store_root: PathBuf,
    pub first_sequence: crate::ServerEventSequence,
    pub evidence_revision_id: RevisionId,
    pub evidence_revision: RevisionExpectation,
}

/// Smoke input construction failures.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalReadOnlySpawnSmokeError {
    ArtifactStore(LocalArtifactStoreError),
    EventTransport(String),
    Sandbox(String),
    ProcessControl(String),
}

/// Build one server-owned read-only spawn request for the CLI smoke path.
pub fn build_local_read_only_spawn_smoke_input(
    input: LocalReadOnlySpawnSmokeInput,
) -> Result<ServerReadOnlySpawnInput, LocalReadOnlySpawnSmokeError> {
    let artifact_backend =
        LocalArtifactStoreBackend::new(input.execution_host_id.clone(), &input.artifact_store_root);
    artifact_backend
        .prepare_metadata_store()
        .map_err(LocalReadOnlySpawnSmokeError::ArtifactStore)?;
    let discovery = compose_readiness_discovery(&input, &artifact_backend)?;
    let authority = authority_map(&input)
        .readiness_for(&input.execution_host_id, &ProjectAuthorityDomain::Execution);
    let gate =
        evaluate_host_spawn_readiness_from_discovery(crate::LocalHostRuntimeDiscoveryGateInput {
            discovery,
            project_id: input.project_id.clone(),
            authority_readiness: authority,
            supervisor_decision: accepted_supervisor_decision(&input),
            requested_sandbox_profile: CommandSandboxProfile::NoFilesystemWrite,
            required_artifact_payload_classes: vec![CommandArtifactPayloadClass::SanitizedSummary],
            interruption_contract: Some(interruption_contract(&input)),
            summary: Some("local read-only spawn smoke gate".to_owned()),
        });
    let request = smoke_request(&input.working_directory);
    let invocation = smoke_invocation(&input.working_directory);

    Ok(ServerReadOnlySpawnInput {
        spawn: LocalReadOnlySpawnInput {
            project_id: input.project_id,
            execution_host_id: input.execution_host_id,
            request,
            invocation,
            host_gate: gate,
            first_sequence: input.first_sequence,
        },
        evidence_revision_id: input.evidence_revision_id,
        evidence_revision: input.evidence_revision,
    })
}

fn compose_readiness_discovery(
    input: &LocalReadOnlySpawnSmokeInput,
    artifact_backend: &LocalArtifactStoreBackend,
) -> Result<crate::LocalHostRuntimeDiscovery, LocalReadOnlySpawnSmokeError> {
    let artifact_discovery = with_local_artifact_store_readiness(
        unsupported_local_host_runtime_discovery(input.execution_host_id.clone()),
        artifact_backend.readiness(),
    )
    .map_err(LocalReadOnlySpawnSmokeError::ArtifactStore)?;
    let event_discovery = with_local_event_transport_readiness(
        artifact_discovery,
        LocalEventTransportBackend::new(input.execution_host_id.clone()).readiness(),
    )
    .map_err(|error| LocalReadOnlySpawnSmokeError::EventTransport(format!("{error:?}")))?;
    let sandbox_discovery = with_local_sandbox_readiness(
        event_discovery,
        LocalSandboxBackend::read_only(input.execution_host_id.clone()).readiness(),
    )
    .map_err(|error| LocalReadOnlySpawnSmokeError::Sandbox(format!("{error:?}")))?;

    with_local_process_control_readiness(
        sandbox_discovery,
        LocalProcessControlBackend::read_only(input.execution_host_id.clone()).readiness(),
    )
    .map_err(|error| LocalReadOnlySpawnSmokeError::ProcessControl(format!("{error:?}")))
}

fn smoke_request(working_directory: &std::path::Path) -> CommandExecutionRequest {
    CommandExecutionRequest {
        id: CommandRequestId("command:request:nucleusd-read-only-spawn-smoke".to_owned()),
        policy_id: Some(CommandPolicyId(
            "command:policy:local-readonly-spawn-smoke".to_owned(),
        )),
        authority_area: CommandAuthorityArea::Validation,
        scope: CommandScope::ReadOnlyInspection,
        risk: CommandRisk::Low,
        sandbox: CommandSandboxProfile::NoFilesystemWrite,
        approval: CommandApprovalPolicy::AutoAllowed,
        command_display: Some("printf nucleus-read-only-spawn-smoke".to_owned()),
        working_directory_hint: Some(working_directory.display().to_string()),
    }
}

fn smoke_invocation(working_directory: &std::path::Path) -> CommandInvocation {
    CommandInvocation {
        command_request_id: CommandRequestId(
            "command:request:nucleusd-read-only-spawn-smoke".to_owned(),
        ),
        executable: "printf".to_owned(),
        argv: vec!["nucleus-read-only-spawn-smoke".to_owned()],
        working_directory: working_directory.to_path_buf(),
        timeout: Duration::from_secs(2),
        stdout_limit_bytes: 16,
        stderr_limit_bytes: 16,
        environment_policy: CommandEnvironmentPolicy::MinimalInheritedSafe,
        sandbox: CommandSandboxProfile::NoFilesystemWrite,
        output_retention: CommandOutputRetention::SummaryOnly,
    }
}

fn authority_map(input: &LocalReadOnlySpawnSmokeInput) -> ProjectAuthorityMap {
    ProjectAuthorityMap {
        project_id: input.project_id.clone(),
        assignments: vec![ProjectAuthorityAssignment {
            domain: ProjectAuthorityDomain::Execution,
            authoritative_host_id: input.execution_host_id.clone(),
            fallback_host_ids: Vec::new(),
            mutation_allowed: true,
            note: Some("local smoke execution authority".to_owned()),
        }],
    }
}

fn accepted_supervisor_decision(
    input: &LocalReadOnlySpawnSmokeInput,
) -> ProcessSupervisorAcceptanceDecision {
    let command_request_id =
        CommandRequestId("command:request:nucleusd-read-only-spawn-smoke".to_owned());
    let readiness = CommandProcessSupervisionReadiness {
        command_request_id: command_request_id.clone(),
        invocation: Some(smoke_invocation(&input.working_directory)),
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
        summary: Some("read-only spawn smoke supervision ready".to_owned()),
    };

    accept_process_supervision_request(ProcessSupervisorAcceptanceRequest {
        project_id: input.project_id.clone(),
        execution_host_id: input.execution_host_id.clone(),
        authority_map: authority_map(input),
        readiness,
        evidence_ref: None,
        policy_decision_ref: Some(CommandPolicyDecisionRef(
            "policy:read-only-spawn-smoke:accepted".to_owned(),
        )),
        first_sequence: crate::ServerEventSequence(input.first_sequence.0.saturating_sub(40)),
        summary: Some("accepted for read-only spawn smoke".to_owned()),
    })
}

fn interruption_contract(input: &LocalReadOnlySpawnSmokeInput) -> ProcessInterruptionHostContract {
    ProcessInterruptionHostContract {
        execution_host_id: input.execution_host_id.clone(),
        contract: CommandProcessInterruptionContract {
            timeout_policy: CommandTimeoutPolicy::RequiredFinite,
            timeout_start_policy: CommandTimeoutStartPolicy::BeforeSpawnAttempt,
            cancellation_policy: CommandCancellationPolicy::Cooperative,
            cleanup_failure_policy: CommandCleanupFailurePolicy::EmitCleanupFailedEvent,
            finite_timeout_required: true,
            terminal_event_required: true,
            retry_classification_policy_aware: true,
            summary: Some("read-only spawn smoke interruption contract".to_owned()),
        },
        implementation_ref: Some("process-control:read-only".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use nucleus_local_store::RevisionExpectation;

    use super::*;

    #[test]
    fn smoke_input_builds_ready_host_gate() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let input = build_local_read_only_spawn_smoke_input(LocalReadOnlySpawnSmokeInput {
            project_id: ProjectId("project:smoke".to_owned()),
            execution_host_id: EngineHostId("host:local".to_owned()),
            working_directory: std::env::current_dir().expect("current dir"),
            artifact_store_root: temp_dir.path().join("artifacts"),
            first_sequence: crate::ServerEventSequence(100),
            evidence_revision_id: RevisionId("rev:spawn-smoke:1".to_owned()),
            evidence_revision: RevisionExpectation::MustNotExist,
        })
        .expect("build input");

        assert_eq!(
            input.spawn.host_gate.status,
            crate::HostSpawnReadinessStatus::Ready
        );
        assert_eq!(input.spawn.invocation.executable, "printf");
        assert_eq!(input.spawn.invocation.stdout_limit_bytes, 16);
    }
}
