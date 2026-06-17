//! Local sandbox backend boundary.
//!
//! This module names a local sandbox backend and reports readiness for a narrow
//! read-only command profile. It does not spawn processes, enforce OS policy,
//! create containers, rewrite mounts, inspect paths, or run shell commands.

use nucleus_command_policy::{CommandSandboxEnforcement, CommandSandboxProfile};

use crate::host_authority::EngineHostId;
use crate::local_host_runtime_discovery::{
    LocalHostRuntimeDiscovery, LocalHostRuntimeDiscoveryEvidenceRef,
    LocalHostRuntimeDiscoveryFinding, LocalHostRuntimeDiscoveryStatus,
};
use crate::sandbox_backend::{
    SandboxBackendEvidenceRef, SandboxBackendKind, SandboxBackendReadiness,
};

mod types;

pub use types::{
    LocalSandboxBackend, LocalSandboxBackendId, LocalSandboxBackendPlatform,
    LocalSandboxBackendPosture, LocalSandboxError, LocalSandboxProfileSupport,
};

impl LocalSandboxBackend {
    /// Create a local backend that can claim enforced read-only sandbox
    /// readiness. This is still readiness vocabulary, not process execution.
    pub fn read_only(execution_host_id: EngineHostId) -> Self {
        Self {
            execution_host_id: execution_host_id.clone(),
            id: LocalSandboxBackendId(format!("sandbox:{}:read-only", execution_host_id.0)),
            platform: LocalSandboxBackendPlatform::CurrentHost,
            posture: LocalSandboxBackendPosture::Enforced,
            supported_profiles: vec![LocalSandboxProfileSupport {
                profile: CommandSandboxProfile::NoFilesystemWrite,
                evidence_ref: SandboxBackendEvidenceRef(format!(
                    "evidence:{}:sandbox:no-filesystem-write",
                    execution_host_id.0
                )),
            }],
        }
    }

    /// Create a local advisory-only backend. This must not satisfy spawn
    /// readiness even when it names the target profile.
    pub fn advisory_only(execution_host_id: EngineHostId) -> Self {
        Self {
            execution_host_id: execution_host_id.clone(),
            id: LocalSandboxBackendId(format!("sandbox:{}:advisory", execution_host_id.0)),
            platform: LocalSandboxBackendPlatform::CurrentHost,
            posture: LocalSandboxBackendPosture::AdvisoryOnly,
            supported_profiles: vec![LocalSandboxProfileSupport {
                profile: CommandSandboxProfile::NoFilesystemWrite,
                evidence_ref: SandboxBackendEvidenceRef(format!(
                    "evidence:{}:sandbox:advisory:no-filesystem-write",
                    execution_host_id.0
                )),
            }],
        }
    }

    /// Create an unsupported local backend descriptor.
    pub fn unsupported(execution_host_id: EngineHostId) -> Self {
        Self {
            execution_host_id: execution_host_id.clone(),
            id: LocalSandboxBackendId(format!("sandbox:{}:unsupported", execution_host_id.0)),
            platform: LocalSandboxBackendPlatform::CurrentHost,
            posture: LocalSandboxBackendPosture::Unsupported,
            supported_profiles: Vec::new(),
        }
    }

    /// Report sandbox readiness from the local backend posture.
    pub fn readiness(&self) -> SandboxBackendReadiness {
        let enforced_profiles = if self.posture == LocalSandboxBackendPosture::Enforced {
            self.supported_profiles
                .iter()
                .map(|support| support.profile.clone())
                .collect()
        } else {
            Vec::new()
        };
        let evidence_refs = if self.posture == LocalSandboxBackendPosture::Unsupported {
            Vec::new()
        } else {
            self.supported_profiles
                .iter()
                .map(|support| support.evidence_ref.clone())
                .collect()
        };

        SandboxBackendReadiness {
            execution_host_id: self.execution_host_id.clone(),
            backend_kind: self.backend_kind(),
            enforced_profiles,
            enforcement: self.enforcement(),
            evidence_refs,
            summary: Some(self.summary()),
        }
    }

    fn backend_kind(&self) -> SandboxBackendKind {
        match self.posture {
            LocalSandboxBackendPosture::Unsupported => SandboxBackendKind::None,
            LocalSandboxBackendPosture::AdvisoryOnly => SandboxBackendKind::AdvisoryOnly,
            LocalSandboxBackendPosture::Enforced => SandboxBackendKind::OsSandbox,
        }
    }

    fn enforcement(&self) -> CommandSandboxEnforcement {
        match self.posture {
            LocalSandboxBackendPosture::Unsupported => CommandSandboxEnforcement::Unsupported,
            LocalSandboxBackendPosture::AdvisoryOnly => CommandSandboxEnforcement::AdvisoryOnly,
            LocalSandboxBackendPosture::Enforced => CommandSandboxEnforcement::Enforced,
        }
    }

    fn summary(&self) -> String {
        match self.posture {
            LocalSandboxBackendPosture::Unsupported => "local sandbox unsupported".to_owned(),
            LocalSandboxBackendPosture::AdvisoryOnly => "local sandbox advisory only".to_owned(),
            LocalSandboxBackendPosture::Enforced => {
                "local read-only sandbox readiness available".to_owned()
            }
        }
    }
}

/// Compose concrete local sandbox readiness into discovery output.
pub fn with_local_sandbox_readiness(
    mut discovery: LocalHostRuntimeDiscovery,
    readiness: SandboxBackendReadiness,
) -> Result<LocalHostRuntimeDiscovery, LocalSandboxError> {
    if readiness.execution_host_id != discovery.execution_host_id {
        return Err(LocalSandboxError::HostMismatch {
            expected: discovery.execution_host_id,
            actual: readiness.execution_host_id,
        });
    }

    discovery.sandbox_backend = readiness;
    discovery.findings.retain(|finding| {
        !matches!(
            finding,
            LocalHostRuntimeDiscoveryFinding::SandboxBackendUnsupported(_)
        )
    });
    discovery
        .evidence_refs
        .push(LocalHostRuntimeDiscoveryEvidenceRef(format!(
            "evidence:{}:local-host-runtime:sandbox:ready",
            discovery.execution_host_id.0
        )));
    discovery.status = if discovery.findings.is_empty() {
        LocalHostRuntimeDiscoveryStatus::Ready
    } else {
        LocalHostRuntimeDiscoveryStatus::Degraded
    };
    discovery.summary = Some("local host runtime discovery with sandbox readiness".to_owned());

    Ok(discovery)
}

#[cfg(test)]
mod tests;
