//! Non-spawning host process readiness gate.
//!
//! This module composes host authority, supervisor acceptance, sandbox,
//! artifact, event transport, interruption, and process-control readiness into
//! one value. It does not spawn processes, enforce sandboxes, store artifacts,
//! publish events, or control child processes.

use nucleus_command_policy::{
    CommandArtifactPayloadClass, CommandProcessSupervisionStatus, CommandSandboxProfile,
};
use nucleus_projects::ProjectId;

use crate::artifact_store_backend::{ArtifactStoreBackendKind, ArtifactStoreBackendReadiness};
use crate::host_authority::{EngineHostId, HostAuthorityReadiness, HostAuthorityReadinessStatus};
use crate::process_control_backend::{ProcessControlBackendKind, ProcessControlBackendReadiness};
use crate::process_event_transport_backend::{
    ProcessEventTransportBackendKind, ProcessEventTransportReadiness,
};
use crate::process_interruption::ProcessInterruptionHostContract;
use crate::process_supervisor::ProcessSupervisorAcceptanceDecision;
use crate::sandbox_backend::{SandboxBackendKind, SandboxBackendReadiness};

/// Input refs and readiness values for host-spawn gate evaluation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostSpawnReadinessInput {
    pub project_id: ProjectId,
    pub execution_host_id: EngineHostId,
    pub authority_readiness: HostAuthorityReadiness,
    pub supervisor_decision: ProcessSupervisorAcceptanceDecision,
    pub requested_sandbox_profile: CommandSandboxProfile,
    pub sandbox_backend: SandboxBackendReadiness,
    pub artifact_store_backend: ArtifactStoreBackendReadiness,
    pub required_artifact_payload_classes: Vec<CommandArtifactPayloadClass>,
    pub event_transport_backend: ProcessEventTransportReadiness,
    pub interruption_contract: Option<ProcessInterruptionHostContract>,
    pub process_control_backend: ProcessControlBackendReadiness,
    pub summary: Option<String>,
}

/// Host-spawn readiness gate result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostSpawnReadinessGate {
    pub project_id: ProjectId,
    pub execution_host_id: EngineHostId,
    pub status: HostSpawnReadinessStatus,
    pub blockers: Vec<HostSpawnReadinessBlocker>,
    pub summary: Option<String>,
}

/// Host-spawn readiness status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostSpawnReadinessStatus {
    Ready,
    Blocked,
}

/// Reason host spawning remains blocked.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostSpawnReadinessBlocker {
    ExecutionAuthorityNotReady(HostAuthorityReadinessStatus),
    SupervisorNotAccepted(CommandProcessSupervisionStatus),
    SandboxBackendNotReady(SandboxBackendKind),
    ArtifactStoreBackendNotReady(ArtifactStoreBackendKind),
    EventTransportBackendNotReady(ProcessEventTransportBackendKind),
    InterruptionContractMissing,
    InterruptionContractNotReady,
    ProcessControlBackendNotReady(ProcessControlBackendKind),
    Custom(String),
}

/// Evaluate a host-spawn readiness gate without spawning.
pub fn evaluate_host_spawn_readiness(input: HostSpawnReadinessInput) -> HostSpawnReadinessGate {
    let mut blockers = Vec::new();

    if !input.authority_readiness.is_ready() {
        blockers.push(HostSpawnReadinessBlocker::ExecutionAuthorityNotReady(
            input.authority_readiness.status.clone(),
        ));
    }

    match &input.supervisor_decision {
        ProcessSupervisorAcceptanceDecision::Accepted(_) => {}
        ProcessSupervisorAcceptanceDecision::Rejected(rejection) => {
            blockers.push(HostSpawnReadinessBlocker::SupervisorNotAccepted(
                rejection.event.payload.status.clone(),
            ));
        }
    }

    if !input
        .sandbox_backend
        .supports_future_spawn_for(&input.requested_sandbox_profile)
    {
        blockers.push(HostSpawnReadinessBlocker::SandboxBackendNotReady(
            input.sandbox_backend.backend_kind.clone(),
        ));
    }

    if !input
        .artifact_store_backend
        .supports_payload_classes(&input.required_artifact_payload_classes)
    {
        blockers.push(HostSpawnReadinessBlocker::ArtifactStoreBackendNotReady(
            input.artifact_store_backend.backend_kind.clone(),
        ));
    }

    if !input
        .event_transport_backend
        .supports_required_spawn_events()
    {
        blockers.push(HostSpawnReadinessBlocker::EventTransportBackendNotReady(
            input.event_transport_backend.backend_kind.clone(),
        ));
    }

    match input.interruption_contract {
        None => blockers.push(HostSpawnReadinessBlocker::InterruptionContractMissing),
        Some(contract) if !contract.supports_future_spawn() => {
            blockers.push(HostSpawnReadinessBlocker::InterruptionContractNotReady)
        }
        Some(_) => {}
    }

    if !input.process_control_backend.supports_future_spawn() {
        blockers.push(HostSpawnReadinessBlocker::ProcessControlBackendNotReady(
            input.process_control_backend.backend_kind.clone(),
        ));
    }

    let status = if blockers.is_empty() {
        HostSpawnReadinessStatus::Ready
    } else {
        HostSpawnReadinessStatus::Blocked
    };

    HostSpawnReadinessGate {
        project_id: input.project_id,
        execution_host_id: input.execution_host_id,
        status,
        blockers,
        summary: input.summary,
    }
}

#[cfg(test)]
mod fixtures;
#[cfg(test)]
mod tests;
