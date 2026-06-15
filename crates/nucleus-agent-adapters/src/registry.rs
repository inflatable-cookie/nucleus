//! Adapter registry records.

use nucleus_agent_protocol::{
    AdapterCapabilities, AdapterIdentity, AdapterRuntimeOwnership, ModelRoute,
};

use crate::config::AdapterConfigEntry;
use crate::status::{AdapterHealth, AdapterLifecycleStatus, AdapterReadiness};

/// Stable registry id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct AdapterRegistryId(pub String);

/// Registry of configured adapter instances known to one server.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterRegistry {
    pub id: AdapterRegistryId,
    pub instances: Vec<AdapterInstanceRecord>,
}

/// Configured adapter instance record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterInstanceRecord {
    pub identity: AdapterIdentity,
    pub capabilities: AdapterCapabilities,
    pub config: Vec<AdapterConfigEntry>,
    pub model_routes: Vec<ModelRoute>,
    pub runtime_ownership: AdapterRuntimeOwnership,
    pub readiness: AdapterReadiness,
    pub lifecycle_status: AdapterLifecycleStatus,
    pub health: AdapterHealth,
}
