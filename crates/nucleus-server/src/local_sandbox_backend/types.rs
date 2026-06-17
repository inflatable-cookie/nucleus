use nucleus_command_policy::CommandSandboxProfile;

use crate::host_authority::EngineHostId;
use crate::sandbox_backend::SandboxBackendEvidenceRef;

/// Stable local sandbox backend id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct LocalSandboxBackendId(pub String);

/// Local sandbox backend owner.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalSandboxBackend {
    pub execution_host_id: EngineHostId,
    pub id: LocalSandboxBackendId,
    pub platform: LocalSandboxBackendPlatform,
    pub posture: LocalSandboxBackendPosture,
    pub supported_profiles: Vec<LocalSandboxProfileSupport>,
}

/// Platform scope for first local sandbox readiness.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalSandboxBackendPlatform {
    CurrentHost,
    Unsupported(String),
}

/// Local sandbox posture. Advisory-only is intentionally distinct from
/// enforced readiness.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalSandboxBackendPosture {
    Unsupported,
    AdvisoryOnly,
    Enforced,
}

/// One sandbox profile support claim plus evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalSandboxProfileSupport {
    pub profile: CommandSandboxProfile,
    pub evidence_ref: SandboxBackendEvidenceRef,
}

/// Local sandbox failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalSandboxError {
    HostMismatch {
        expected: EngineHostId,
        actual: EngineHostId,
    },
}
