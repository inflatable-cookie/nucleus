//! Adapter health and readiness probe records.

use crate::status::{AdapterHealthStatus, AdapterReadiness};

/// Contract-level probe policy for one adapter instance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterProbePolicy {
    pub requirements: Vec<AdapterProbeRequirement>,
    pub readiness_gate: AdapterReadinessGate,
    pub stale_state_policy: AdapterStaleStatePolicy,
}

/// One probe requirement used before assigning work.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterProbeRequirement {
    pub kind: AdapterProbeKind,
    pub target: AdapterProbeTarget,
    pub cadence: AdapterProbeCadence,
    pub required_before_work: bool,
    pub stale_after_label: Option<String>,
    pub failure_policy: AdapterProbeFailurePolicy,
}

/// Kind of probe nucleus may request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterProbeKind {
    ExternalServerReachability,
    OwnedProcessLiveness,
    SidecarHandshake,
    StdioHandshake,
    PtyLaunchSmokeTest,
    AuthenticationPreflight,
    VersionDiscovery,
    ModelRouteAvailability,
    CapabilityRefresh,
}

/// Runtime target a probe is checking.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterProbeTarget {
    ExternalServer,
    NucleusOwnedLocalServer,
    SdkSidecar,
    AcpStdioProcess,
    WireStdioProcess,
    RpcStdioProcess,
    PtyProcess,
    Unknown,
}

/// When a probe should run.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterProbeCadence {
    OnServerStartup,
    BeforeAssignment,
    Periodic(String),
    OnRuntimeTransition,
    ManualOnly,
}

/// How a failed probe affects health and readiness.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterProbeFailurePolicy {
    pub health_status: AdapterHealthStatus,
    pub readiness: AdapterReadiness,
    pub retain_stale_display_state: bool,
}

/// Readiness gate evaluated before routing work to an adapter instance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterReadinessGate {
    pub required_probe_kinds: Vec<AdapterProbeKind>,
    pub stale_health_blocks_work: bool,
    pub terminal_fallback_allowed: bool,
}

/// How restored health/readiness state may be used after restart.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterStaleStatePolicy {
    pub restored_health_authority: AdapterStateAuthority,
    pub restored_readiness_authority: AdapterStateAuthority,
}

/// Authority level for restored or retained adapter state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterStateAuthority {
    FreshProbeRequired,
    StaleDisplayOnly,
    AuditOnly,
}

/// Result of one probe observation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterProbeEvidence {
    pub kind: AdapterProbeKind,
    pub target: AdapterProbeTarget,
    pub observed_at_label: Option<String>,
    pub result: AdapterProbeResult,
    pub message: Option<String>,
}

/// Probe result before it is folded into health/readiness.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterProbeResult {
    Passed,
    Warning(String),
    Failed(String),
    Unsupported(String),
    Unknown,
}

/// Health/readiness assessment assembled from probe evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterProbeAssessment {
    pub health_status: AdapterHealthStatus,
    pub readiness: AdapterReadiness,
    pub evidence: Vec<AdapterProbeEvidence>,
    pub fresh_enough_for_work: bool,
}
