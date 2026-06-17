//! Sanitized runtime readiness diagnostics for control-plane clients.
//!
//! These records project existing readiness descriptors into a client-safe read
//! model. They do not probe hosts, grant command authority, spawn processes,
//! expose credentials, or return artifact payloads.

use crate::artifact_store_backend::ArtifactStoreBackendKind;
use crate::host_authority::EngineHostId;
use crate::local_host_runtime_discovery::{
    LocalHostRuntimeDiscovery, LocalHostRuntimeDiscoveryFinding, LocalHostRuntimeDiscoveryStatus,
};
use crate::process_control_backend::ProcessControlBackendKind;
use crate::process_event_transport_backend::ProcessEventTransportBackendKind;
use crate::sandbox_backend::SandboxBackendKind;

/// Runtime surface described by a readiness diagnostics record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeReadinessSurface {
    LocalHostCommandExecution,
}

/// Client-facing readiness status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeReadinessStatus {
    Ready,
    Degraded,
    Unsupported,
}

/// Sanitized blocker that explains why a runtime surface is not ready.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeReadinessBlocker {
    pub source: String,
    pub code: String,
    pub message: String,
}

/// Client-safe readiness diagnostics record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeReadinessDiagnostics {
    pub host_id: EngineHostId,
    pub surface: RuntimeReadinessSurface,
    pub status: RuntimeReadinessStatus,
    pub blockers: Vec<RuntimeReadinessBlocker>,
    pub evidence_refs: Vec<String>,
    pub repair_hints: Vec<String>,
    pub summary: Option<String>,
}

/// Project local host runtime discovery into sanitized diagnostics.
pub fn local_host_runtime_readiness_diagnostics(
    discovery: &LocalHostRuntimeDiscovery,
) -> RuntimeReadinessDiagnostics {
    let mut blockers = discovery
        .findings
        .iter()
        .map(blocker_from_finding)
        .collect::<Vec<_>>();
    blockers.extend(
        discovery
            .descriptor_host_mismatches()
            .iter()
            .map(blocker_from_finding),
    );

    RuntimeReadinessDiagnostics {
        host_id: discovery.execution_host_id.clone(),
        surface: RuntimeReadinessSurface::LocalHostCommandExecution,
        status: status_from_discovery(&discovery.status),
        blockers,
        evidence_refs: evidence_refs(discovery),
        repair_hints: repair_hints(discovery),
        summary: discovery.summary.clone(),
    }
}

fn status_from_discovery(status: &LocalHostRuntimeDiscoveryStatus) -> RuntimeReadinessStatus {
    match status {
        LocalHostRuntimeDiscoveryStatus::Ready => RuntimeReadinessStatus::Ready,
        LocalHostRuntimeDiscoveryStatus::Degraded => RuntimeReadinessStatus::Degraded,
        LocalHostRuntimeDiscoveryStatus::Unsupported => RuntimeReadinessStatus::Unsupported,
    }
}

fn blocker_from_finding(finding: &LocalHostRuntimeDiscoveryFinding) -> RuntimeReadinessBlocker {
    match finding {
        LocalHostRuntimeDiscoveryFinding::SandboxBackendUnsupported(kind) => blocker(
            "sandbox_backend",
            "sandbox_backend_unsupported",
            format!("sandbox backend is unsupported: {}", sandbox_kind(kind)),
        ),
        LocalHostRuntimeDiscoveryFinding::ArtifactStoreBackendUnsupported(kind) => blocker(
            "artifact_store_backend",
            "artifact_store_backend_unsupported",
            format!(
                "artifact store backend is unsupported: {}",
                artifact_kind(kind)
            ),
        ),
        LocalHostRuntimeDiscoveryFinding::EventTransportBackendUnsupported(kind) => blocker(
            "event_transport_backend",
            "event_transport_backend_unsupported",
            format!(
                "process event transport is unsupported: {}",
                event_transport_kind(kind)
            ),
        ),
        LocalHostRuntimeDiscoveryFinding::ProcessControlBackendUnsupported(kind) => blocker(
            "process_control_backend",
            "process_control_backend_unsupported",
            format!(
                "process control backend is unsupported: {}",
                process_control_kind(kind)
            ),
        ),
        LocalHostRuntimeDiscoveryFinding::DescriptorHostMismatch { expected, actual } => blocker(
            "host_descriptor",
            "descriptor_host_mismatch",
            format!(
                "runtime descriptor belongs to {}, expected {}",
                actual.0, expected.0
            ),
        ),
        LocalHostRuntimeDiscoveryFinding::EvidenceMissing(label) => blocker(
            "evidence",
            "evidence_missing",
            format!("readiness evidence is missing for {label}"),
        ),
        LocalHostRuntimeDiscoveryFinding::Custom(message) => {
            blocker("custom", "custom_readiness_blocker", message.clone())
        }
    }
}

fn blocker(source: &str, code: &str, message: String) -> RuntimeReadinessBlocker {
    RuntimeReadinessBlocker {
        source: source.to_owned(),
        code: code.to_owned(),
        message,
    }
}

fn evidence_refs(discovery: &LocalHostRuntimeDiscovery) -> Vec<String> {
    let mut refs = Vec::new();
    refs.extend(discovery.evidence_refs.iter().map(|item| item.0.clone()));
    refs.extend(
        discovery
            .sandbox_backend
            .evidence_refs
            .iter()
            .map(|item| item.0.clone()),
    );
    refs.extend(
        discovery
            .artifact_store_backend
            .retention_evidence_refs
            .iter()
            .map(|item| item.0.clone()),
    );
    refs.extend(
        discovery
            .artifact_store_backend
            .redaction_evidence_refs
            .iter()
            .map(|item| item.0.clone()),
    );
    refs.extend(
        discovery
            .event_transport_backend
            .delivery_evidence_refs
            .iter()
            .map(|item| item.0.clone()),
    );
    refs.extend(
        discovery
            .event_transport_backend
            .replay_evidence_refs
            .iter()
            .map(|item| item.0.clone()),
    );
    refs.extend(
        discovery
            .process_control_backend
            .implementation_evidence_refs
            .iter()
            .map(|item| item.0.clone()),
    );
    refs
}

fn repair_hints(discovery: &LocalHostRuntimeDiscovery) -> Vec<String> {
    if discovery.status == LocalHostRuntimeDiscoveryStatus::Ready {
        return Vec::new();
    }

    vec![
        "configure a sandbox backend before enabling command execution".to_owned(),
        "configure artifact metadata storage for command output summaries".to_owned(),
        "configure an event transport with replay before process supervision".to_owned(),
        "configure process control with timeout, cancellation, and cleanup support".to_owned(),
    ]
}

fn sandbox_kind(kind: &SandboxBackendKind) -> &'static str {
    match kind {
        SandboxBackendKind::None => "none",
        SandboxBackendKind::AdvisoryOnly => "advisory_only",
        SandboxBackendKind::OsSandbox => "os_sandbox",
        SandboxBackendKind::Container => "container",
        SandboxBackendKind::MountPolicy => "mount_policy",
        SandboxBackendKind::NetworkPolicy => "network_policy",
        SandboxBackendKind::Custom(_) => "custom",
    }
}

fn artifact_kind(kind: &ArtifactStoreBackendKind) -> &'static str {
    match kind {
        ArtifactStoreBackendKind::None => "none",
        ArtifactStoreBackendKind::Filesystem => "filesystem",
        ArtifactStoreBackendKind::EmbeddedDatabase => "embedded_database",
        ArtifactStoreBackendKind::ObjectStore => "object_store",
        ArtifactStoreBackendKind::ProjectLocalFiles => "project_local_files",
        ArtifactStoreBackendKind::RemoteStore => "remote_store",
        ArtifactStoreBackendKind::Custom(_) => "custom",
    }
}

fn event_transport_kind(kind: &ProcessEventTransportBackendKind) -> &'static str {
    match kind {
        ProcessEventTransportBackendKind::None => "none",
        ProcessEventTransportBackendKind::InProcess => "in_process",
        ProcessEventTransportBackendKind::LocalIpc => "local_ipc",
        ProcessEventTransportBackendKind::ServerEventBus => "server_event_bus",
        ProcessEventTransportBackendKind::RemoteStream => "remote_stream",
        ProcessEventTransportBackendKind::Custom(_) => "custom",
    }
}

fn process_control_kind(kind: &ProcessControlBackendKind) -> &'static str {
    match kind {
        ProcessControlBackendKind::None => "none",
        ProcessControlBackendKind::StdProcess => "std_process",
        ProcessControlBackendKind::TokioProcess => "tokio_process",
        ProcessControlBackendKind::SystemService => "system_service",
        ProcessControlBackendKind::Custom(_) => "custom",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::unsupported_local_host_runtime_discovery;

    #[test]
    fn local_host_runtime_diagnostics_are_sanitized_and_evidence_backed() {
        let diagnostics = local_host_runtime_readiness_diagnostics(
            &unsupported_local_host_runtime_discovery(EngineHostId("host:local".to_owned())),
        );

        assert_eq!(diagnostics.host_id.0, "host:local");
        assert_eq!(
            diagnostics.surface,
            RuntimeReadinessSurface::LocalHostCommandExecution
        );
        assert_eq!(diagnostics.status, RuntimeReadinessStatus::Unsupported);
        assert_eq!(diagnostics.blockers.len(), 4);
        assert!(diagnostics
            .blockers
            .iter()
            .any(|blocker| blocker.code == "process_control_backend_unsupported"));
        assert!(diagnostics
            .evidence_refs
            .iter()
            .any(|item| item == "evidence:host:local:local-host-runtime:unsupported"));
        assert!(diagnostics
            .repair_hints
            .iter()
            .any(|hint| hint.contains("process control")));

        let debug = format!("{diagnostics:?}");
        for forbidden in [
            "raw_stdout",
            "raw_stderr",
            "credential",
            "secret",
            "payload bytes",
            "environment",
        ] {
            assert!(
                !debug.contains(forbidden),
                "diagnostics should not contain {forbidden}"
            );
        }
    }
}
