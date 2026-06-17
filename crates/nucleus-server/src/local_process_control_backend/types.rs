use crate::host_authority::EngineHostId;
use crate::process_control_backend::ProcessControlBackendEvidenceRef;

/// Stable local process-control backend id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct LocalProcessControlBackendId(pub String);

/// Local process-control backend owner.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalProcessControlBackend {
    pub execution_host_id: EngineHostId,
    pub id: LocalProcessControlBackendId,
    pub runtime: LocalProcessControlRuntime,
    pub profile: LocalProcessControlReadinessProfile,
}

/// Runtime family for the process-control backend.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalProcessControlRuntime {
    StdProcess,
    TokioProcess,
    Unsupported,
}

/// Readiness profile for the first bounded read-only process-control slice.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalProcessControlReadinessProfile {
    pub spawn_ready: bool,
    pub finite_timeout_ready: bool,
    pub cooperative_cancellation_ready: bool,
    pub cleanup_failure_reporting_ready: bool,
    pub shell_passthrough_allowed: bool,
    pub pty_allowed: bool,
    pub evidence_ref: ProcessControlBackendEvidenceRef,
}

/// Local process-control failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalProcessControlError {
    HostMismatch {
        expected: EngineHostId,
        actual: EngineHostId,
    },
}
