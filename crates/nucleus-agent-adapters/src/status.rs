//! Adapter readiness and status types.

/// Whether an adapter instance is ready to receive work.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterReadiness {
    Ready,
    NeedsConfiguration(Vec<String>),
    NeedsAuthentication,
    UnsupportedHost(String),
    Unknown,
}

/// Lifecycle status of a configured adapter instance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterLifecycleStatus {
    Registered,
    Available,
    Starting,
    Running,
    Degraded(String),
    Stopped,
    Disabled,
}

/// Health snapshot for a configured adapter instance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterHealth {
    pub status: AdapterHealthStatus,
    pub checked_at_label: Option<String>,
    pub message: Option<String>,
}

/// Coarse health state before active probes exist.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterHealthStatus {
    Healthy,
    Warning,
    Error,
    Unknown,
}
