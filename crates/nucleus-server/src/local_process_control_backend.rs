//! Local process-control backend boundary.
//!
//! This module names local process-control readiness for a future bounded
//! read-only spawn slice. It does not spawn processes, start async runtimes,
//! cancel child processes, kill process trees, run cleanup, or open PTYs.

use crate::host_authority::EngineHostId;
use crate::local_host_runtime_discovery::{
    LocalHostRuntimeDiscovery, LocalHostRuntimeDiscoveryEvidenceRef,
    LocalHostRuntimeDiscoveryFinding, LocalHostRuntimeDiscoveryStatus,
};
use crate::process_control_backend::{
    ProcessControlBackendEvidenceRef, ProcessControlBackendKind, ProcessControlBackendReadiness,
};

mod types;

pub use types::{
    LocalProcessControlBackend, LocalProcessControlBackendId, LocalProcessControlError,
    LocalProcessControlReadinessProfile, LocalProcessControlRuntime,
};

impl LocalProcessControlBackend {
    /// Create readiness for the first bounded read-only process-control slice.
    pub fn read_only(execution_host_id: EngineHostId) -> Self {
        Self {
            execution_host_id: execution_host_id.clone(),
            id: LocalProcessControlBackendId(format!(
                "process-control:{}:read-only",
                execution_host_id.0
            )),
            runtime: LocalProcessControlRuntime::StdProcess,
            profile: LocalProcessControlReadinessProfile {
                spawn_ready: true,
                finite_timeout_ready: true,
                cooperative_cancellation_ready: true,
                cleanup_failure_reporting_ready: true,
                shell_passthrough_allowed: false,
                pty_allowed: false,
                evidence_ref: ProcessControlBackendEvidenceRef(format!(
                    "evidence:{}:process-control:read-only",
                    execution_host_id.0
                )),
            },
        }
    }

    /// Report process-control readiness without spawning.
    pub fn readiness(&self) -> ProcessControlBackendReadiness {
        ProcessControlBackendReadiness {
            execution_host_id: self.execution_host_id.clone(),
            backend_kind: self.backend_kind(),
            spawn_ready: self.profile.spawn_ready
                && !self.profile.shell_passthrough_allowed
                && !self.profile.pty_allowed,
            timeout_ready: self.profile.finite_timeout_ready,
            cancellation_ready: self.profile.cooperative_cancellation_ready,
            cleanup_ready: self.profile.cleanup_failure_reporting_ready,
            implementation_evidence_refs: self.implementation_evidence_refs(),
            summary: Some(if self.is_ready_for_read_only_spawn() {
                "local read-only process-control readiness available".to_owned()
            } else {
                "local process-control readiness incomplete".to_owned()
            }),
        }
    }

    /// Returns true when the backend can satisfy the first read-only spawn
    /// control requirements.
    pub fn is_ready_for_read_only_spawn(&self) -> bool {
        self.profile.spawn_ready
            && self.profile.finite_timeout_ready
            && self.profile.cooperative_cancellation_ready
            && self.profile.cleanup_failure_reporting_ready
            && !self.profile.shell_passthrough_allowed
            && !self.profile.pty_allowed
    }

    fn backend_kind(&self) -> ProcessControlBackendKind {
        match self.runtime {
            LocalProcessControlRuntime::StdProcess => ProcessControlBackendKind::StdProcess,
            LocalProcessControlRuntime::TokioProcess => ProcessControlBackendKind::TokioProcess,
            LocalProcessControlRuntime::Unsupported => ProcessControlBackendKind::None,
        }
    }

    fn implementation_evidence_refs(&self) -> Vec<ProcessControlBackendEvidenceRef> {
        if self.runtime == LocalProcessControlRuntime::Unsupported {
            Vec::new()
        } else {
            vec![self.profile.evidence_ref.clone()]
        }
    }
}

/// Compose concrete local process-control readiness into discovery output.
pub fn with_local_process_control_readiness(
    mut discovery: LocalHostRuntimeDiscovery,
    readiness: ProcessControlBackendReadiness,
) -> Result<LocalHostRuntimeDiscovery, LocalProcessControlError> {
    if readiness.execution_host_id != discovery.execution_host_id {
        return Err(LocalProcessControlError::HostMismatch {
            expected: discovery.execution_host_id,
            actual: readiness.execution_host_id,
        });
    }

    discovery.process_control_backend = readiness;
    discovery.findings.retain(|finding| {
        !matches!(
            finding,
            LocalHostRuntimeDiscoveryFinding::ProcessControlBackendUnsupported(_)
        )
    });
    discovery
        .evidence_refs
        .push(LocalHostRuntimeDiscoveryEvidenceRef(format!(
            "evidence:{}:local-host-runtime:process-control:ready",
            discovery.execution_host_id.0
        )));
    discovery.status = if discovery.findings.is_empty() {
        LocalHostRuntimeDiscoveryStatus::Ready
    } else {
        LocalHostRuntimeDiscoveryStatus::Degraded
    };
    discovery.summary =
        Some("local host runtime discovery with process-control readiness".to_owned());

    Ok(discovery)
}

#[cfg(test)]
mod tests;
