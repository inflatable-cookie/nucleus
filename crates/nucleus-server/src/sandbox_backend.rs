//! Sandbox backend readiness descriptors.
//!
//! These records describe whether an execution host can honestly enforce
//! sandbox profiles. They do not implement sandboxing, mount policies,
//! containers, process spawning, path checks, or network controls.

use nucleus_command_policy::{CommandSandboxEnforcement, CommandSandboxProfile};

use crate::host_authority::EngineHostId;

/// Stable sandbox backend evidence ref (shared core type).
pub use nucleus_core::EvidenceRef as SandboxBackendEvidenceRef;

/// Host sandbox backend family.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SandboxBackendKind {
    None,
    AdvisoryOnly,
    OsSandbox,
    Container,
    MountPolicy,
    NetworkPolicy,
    Custom(String),
}

/// Sandbox backend readiness descriptor for one execution host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SandboxBackendReadiness {
    pub execution_host_id: EngineHostId,
    pub backend_kind: SandboxBackendKind,
    pub enforced_profiles: Vec<CommandSandboxProfile>,
    pub enforcement: CommandSandboxEnforcement,
    pub evidence_refs: Vec<SandboxBackendEvidenceRef>,
    pub summary: Option<String>,
}

impl SandboxBackendReadiness {
    /// Returns true when the backend can enforce the requested profile.
    pub fn enforces_profile(&self, profile: &CommandSandboxProfile) -> bool {
        self.enforcement == CommandSandboxEnforcement::Enforced
            && self.enforced_profiles.contains(profile)
            && !self.evidence_refs.is_empty()
    }

    /// Returns true when the backend can support future host spawn.
    pub fn supports_future_spawn_for(&self, profile: &CommandSandboxProfile) -> bool {
        self.backend_kind != SandboxBackendKind::None
            && self.backend_kind != SandboxBackendKind::AdvisoryOnly
            && self.enforces_profile(profile)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host() -> EngineHostId {
        EngineHostId("host:local".to_owned())
    }

    #[test]
    fn advisory_only_sandbox_backend_does_not_support_spawn() {
        let readiness = SandboxBackendReadiness {
            execution_host_id: host(),
            backend_kind: SandboxBackendKind::AdvisoryOnly,
            enforced_profiles: vec![CommandSandboxProfile::NoFilesystemWrite],
            enforcement: CommandSandboxEnforcement::AdvisoryOnly,
            evidence_refs: vec![SandboxBackendEvidenceRef("evidence:sandbox".to_owned())],
            summary: Some("label only".to_owned()),
        };

        assert!(!readiness.supports_future_spawn_for(&CommandSandboxProfile::NoFilesystemWrite));
    }

    #[test]
    fn enforced_sandbox_backend_requires_evidence_ref() {
        let readiness = SandboxBackendReadiness {
            execution_host_id: host(),
            backend_kind: SandboxBackendKind::OsSandbox,
            enforced_profiles: vec![CommandSandboxProfile::NoFilesystemWrite],
            enforcement: CommandSandboxEnforcement::Enforced,
            evidence_refs: Vec::new(),
            summary: Some("missing evidence".to_owned()),
        };

        assert!(!readiness.enforces_profile(&CommandSandboxProfile::NoFilesystemWrite));
    }

    #[test]
    fn enforced_sandbox_backend_can_support_named_profile_without_implementing_it() {
        let readiness = SandboxBackendReadiness {
            execution_host_id: host(),
            backend_kind: SandboxBackendKind::OsSandbox,
            enforced_profiles: vec![CommandSandboxProfile::NoFilesystemWrite],
            enforcement: CommandSandboxEnforcement::Enforced,
            evidence_refs: vec![SandboxBackendEvidenceRef(
                "evidence:sandbox:no-write".to_owned(),
            )],
            summary: Some("no-write enforcement is available".to_owned()),
        };

        assert!(readiness.supports_future_spawn_for(&CommandSandboxProfile::NoFilesystemWrite));
        assert!(!readiness.supports_future_spawn_for(&CommandSandboxProfile::ProjectRestricted));
    }
}
