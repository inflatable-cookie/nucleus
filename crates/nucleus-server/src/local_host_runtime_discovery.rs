//! Local host runtime capability discovery vocabulary.
//!
//! These records describe discovered host runtime capabilities. They do not
//! probe the machine, spawn processes, enforce sandboxes, store artifacts,
//! publish events, or control child processes.

use nucleus_command_policy::{
    CommandArtifactPayloadClass, CommandSandboxEnforcement, CommandSandboxProfile,
};
use nucleus_projects::ProjectId;

use crate::artifact_store_backend::{
    ArtifactStoreBackendEvidenceRef, ArtifactStoreBackendKind, ArtifactStoreBackendReadiness,
};
use crate::host_authority::{EngineHostId, HostAuthorityReadiness};
use crate::host_spawn_readiness::{
    evaluate_host_spawn_readiness, HostSpawnReadinessGate, HostSpawnReadinessInput,
};
use crate::process_control_backend::{
    ProcessControlBackendEvidenceRef, ProcessControlBackendKind, ProcessControlBackendReadiness,
};
use crate::process_event_transport_backend::{
    ProcessEventTransportBackendKind, ProcessEventTransportEvidenceRef,
    ProcessEventTransportReadiness,
};
use crate::sandbox_backend::{
    SandboxBackendEvidenceRef, SandboxBackendKind, SandboxBackendReadiness,
};
use crate::{ProcessInterruptionHostContract, ProcessSupervisorAcceptanceDecision};

/// Stable evidence ref for local host runtime discovery.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct LocalHostRuntimeDiscoveryEvidenceRef(pub String);

/// Overall readiness status reported by local host runtime discovery.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalHostRuntimeDiscoveryStatus {
    Ready,
    Degraded,
    Unsupported,
}

/// Discovery finding that explains unsupported or degraded capability.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalHostRuntimeDiscoveryFinding {
    SandboxBackendUnsupported(SandboxBackendKind),
    ArtifactStoreBackendUnsupported(ArtifactStoreBackendKind),
    EventTransportBackendUnsupported(ProcessEventTransportBackendKind),
    ProcessControlBackendUnsupported(ProcessControlBackendKind),
    DescriptorHostMismatch {
        expected: EngineHostId,
        actual: EngineHostId,
    },
    EvidenceMissing(String),
    Custom(String),
}

/// Descriptor group produced by local host runtime discovery.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalHostRuntimeDiscovery {
    pub execution_host_id: EngineHostId,
    pub status: LocalHostRuntimeDiscoveryStatus,
    pub sandbox_backend: SandboxBackendReadiness,
    pub artifact_store_backend: ArtifactStoreBackendReadiness,
    pub event_transport_backend: ProcessEventTransportReadiness,
    pub process_control_backend: ProcessControlBackendReadiness,
    pub evidence_refs: Vec<LocalHostRuntimeDiscoveryEvidenceRef>,
    pub findings: Vec<LocalHostRuntimeDiscoveryFinding>,
    pub summary: Option<String>,
}

/// Explicit inputs needed to compose discovery output with the spawn gate.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalHostRuntimeDiscoveryGateInput {
    pub discovery: LocalHostRuntimeDiscovery,
    pub project_id: ProjectId,
    pub authority_readiness: HostAuthorityReadiness,
    pub supervisor_decision: ProcessSupervisorAcceptanceDecision,
    pub requested_sandbox_profile: CommandSandboxProfile,
    pub required_artifact_payload_classes: Vec<CommandArtifactPayloadClass>,
    pub interruption_contract: Option<ProcessInterruptionHostContract>,
    pub summary: Option<String>,
}

impl LocalHostRuntimeDiscovery {
    /// Returns true when all backend descriptors are for the discovered host.
    pub fn descriptors_match_host(&self) -> bool {
        self.sandbox_backend.execution_host_id == self.execution_host_id
            && self.artifact_store_backend.execution_host_id == self.execution_host_id
            && self.event_transport_backend.execution_host_id == self.execution_host_id
            && self.process_control_backend.execution_host_id == self.execution_host_id
    }

    /// Returns descriptor host mismatch findings without performing discovery.
    pub fn descriptor_host_mismatches(&self) -> Vec<LocalHostRuntimeDiscoveryFinding> {
        let mut findings = Vec::new();

        if self.sandbox_backend.execution_host_id != self.execution_host_id {
            findings.push(LocalHostRuntimeDiscoveryFinding::DescriptorHostMismatch {
                expected: self.execution_host_id.clone(),
                actual: self.sandbox_backend.execution_host_id.clone(),
            });
        }

        if self.artifact_store_backend.execution_host_id != self.execution_host_id {
            findings.push(LocalHostRuntimeDiscoveryFinding::DescriptorHostMismatch {
                expected: self.execution_host_id.clone(),
                actual: self.artifact_store_backend.execution_host_id.clone(),
            });
        }

        if self.event_transport_backend.execution_host_id != self.execution_host_id {
            findings.push(LocalHostRuntimeDiscoveryFinding::DescriptorHostMismatch {
                expected: self.execution_host_id.clone(),
                actual: self.event_transport_backend.execution_host_id.clone(),
            });
        }

        if self.process_control_backend.execution_host_id != self.execution_host_id {
            findings.push(LocalHostRuntimeDiscoveryFinding::DescriptorHostMismatch {
                expected: self.execution_host_id.clone(),
                actual: self.process_control_backend.execution_host_id.clone(),
            });
        }

        findings
    }

    /// Returns true when discovery is explicitly unsupported.
    pub fn is_unsupported(&self) -> bool {
        self.status == LocalHostRuntimeDiscoveryStatus::Unsupported
    }

    /// Returns true when discovery has enough descriptor evidence to enter a
    /// later host-spawn readiness gate.
    pub fn has_descriptor_evidence(&self) -> bool {
        !self.evidence_refs.is_empty() && self.descriptors_match_host()
    }
}

/// Evaluate host-spawn readiness using descriptors produced by discovery.
pub fn evaluate_host_spawn_readiness_from_discovery(
    input: LocalHostRuntimeDiscoveryGateInput,
) -> HostSpawnReadinessGate {
    evaluate_host_spawn_readiness(HostSpawnReadinessInput {
        project_id: input.project_id,
        execution_host_id: input.discovery.execution_host_id,
        authority_readiness: input.authority_readiness,
        supervisor_decision: input.supervisor_decision,
        requested_sandbox_profile: input.requested_sandbox_profile,
        sandbox_backend: input.discovery.sandbox_backend,
        artifact_store_backend: input.discovery.artifact_store_backend,
        required_artifact_payload_classes: input.required_artifact_payload_classes,
        event_transport_backend: input.discovery.event_transport_backend,
        interruption_contract: input.interruption_contract,
        process_control_backend: input.discovery.process_control_backend,
        summary: input.summary,
    })
}

/// Returns a deterministic unsupported local host runtime discovery fixture.
pub fn unsupported_local_host_runtime_discovery(
    execution_host_id: EngineHostId,
) -> LocalHostRuntimeDiscovery {
    let evidence_prefix = execution_host_id.0.clone();

    LocalHostRuntimeDiscovery {
        execution_host_id: execution_host_id.clone(),
        status: LocalHostRuntimeDiscoveryStatus::Unsupported,
        sandbox_backend: SandboxBackendReadiness {
            execution_host_id: execution_host_id.clone(),
            backend_kind: SandboxBackendKind::None,
            enforced_profiles: Vec::new(),
            enforcement: CommandSandboxEnforcement::Unsupported,
            evidence_refs: vec![SandboxBackendEvidenceRef(format!(
                "evidence:{evidence_prefix}:sandbox:unsupported"
            ))],
            summary: Some("sandbox backend unsupported".to_owned()),
        },
        artifact_store_backend: ArtifactStoreBackendReadiness {
            execution_host_id: execution_host_id.clone(),
            backend_kind: ArtifactStoreBackendKind::None,
            supported_payload_classes: Vec::new(),
            payload_storage_ready: false,
            retention_evidence_refs: vec![ArtifactStoreBackendEvidenceRef(format!(
                "evidence:{evidence_prefix}:artifact-store:retention:unsupported"
            ))],
            redaction_evidence_refs: vec![ArtifactStoreBackendEvidenceRef(format!(
                "evidence:{evidence_prefix}:artifact-store:redaction:unsupported"
            ))],
            summary: Some("artifact store unsupported".to_owned()),
        },
        event_transport_backend: ProcessEventTransportReadiness {
            execution_host_id: execution_host_id.clone(),
            backend_kind: ProcessEventTransportBackendKind::None,
            supported_event_kinds: Vec::new(),
            delivery_evidence_refs: vec![ProcessEventTransportEvidenceRef(format!(
                "evidence:{evidence_prefix}:event-transport:delivery:unsupported"
            ))],
            replay_evidence_refs: vec![ProcessEventTransportEvidenceRef(format!(
                "evidence:{evidence_prefix}:event-transport:replay:unsupported"
            ))],
            summary: Some("process event transport unsupported".to_owned()),
        },
        process_control_backend: ProcessControlBackendReadiness {
            execution_host_id,
            backend_kind: ProcessControlBackendKind::None,
            spawn_ready: false,
            timeout_ready: false,
            cancellation_ready: false,
            cleanup_ready: false,
            implementation_evidence_refs: vec![ProcessControlBackendEvidenceRef(format!(
                "evidence:{evidence_prefix}:process-control:unsupported"
            ))],
            summary: Some("process control unsupported".to_owned()),
        },
        evidence_refs: vec![LocalHostRuntimeDiscoveryEvidenceRef(format!(
            "evidence:{evidence_prefix}:local-host-runtime:unsupported"
        ))],
        findings: vec![
            LocalHostRuntimeDiscoveryFinding::SandboxBackendUnsupported(SandboxBackendKind::None),
            LocalHostRuntimeDiscoveryFinding::ArtifactStoreBackendUnsupported(
                ArtifactStoreBackendKind::None,
            ),
            LocalHostRuntimeDiscoveryFinding::EventTransportBackendUnsupported(
                ProcessEventTransportBackendKind::None,
            ),
            LocalHostRuntimeDiscoveryFinding::ProcessControlBackendUnsupported(
                ProcessControlBackendKind::None,
            ),
        ],
        summary: Some("local host runtime unsupported".to_owned()),
    }
}

#[cfg(test)]
mod tests;
