//! Adapter registry persistence boundary records.

use std::time::SystemTime;

use crate::registry::{AdapterRegistry, AdapterRegistryId};

/// Durable snapshot of an adapter registry.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterRegistrySnapshot {
    pub registry_id: AdapterRegistryId,
    pub generation: u64,
    pub recorded_at: Option<SystemTime>,
    pub registry: AdapterRegistry,
    pub persisted_fields: Vec<AdapterRegistryPersistedField>,
    pub recomputed_fields: Vec<AdapterRegistryRecomputedField>,
}

/// Registry data that must survive server restarts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterRegistryPersistedField {
    RegistryId,
    InstanceIdentity,
    InstanceConfigWithoutSecrets,
    SecretReferences,
    ModelRoutes,
    RuntimeOwnership,
    ProbePolicy,
    LifecycleStatus,
}

/// Registry data that must be probed or rediscovered.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterRegistryRecomputedField {
    CapabilitySnapshot,
    Readiness,
    HealthSnapshot,
    ProbeEvidence,
    CredentialResolutionRecord,
    VersionDiscovery,
    AuthenticationPreflight,
}

/// Persistence expectation for one configured registry.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterRegistryPersistencePolicy {
    pub backend: AdapterRegistryPersistenceBackend,
    pub snapshot_required: bool,
    pub secret_material_allowed: bool,
    pub repair_on_missing_instance: AdapterRegistryRepairPolicy,
}

/// Storage backend family without selecting a concrete engine.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterRegistryPersistenceBackend {
    Unselected,
    ServerStateStore,
    ProjectScopedStateStore,
    ExternalProfileStore,
}

/// How registry recovery should handle missing configured instances.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterRegistryRepairPolicy {
    MarkUnavailable,
    RequireUserRepair,
    DropOnlyWhenExplicitlyRemoved,
}
