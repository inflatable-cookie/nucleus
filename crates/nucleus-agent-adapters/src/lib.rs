//! Adapter registry and configured adapter instance types.
//!
//! This crate names adapter registration state only. It does not implement
//! provider adapters, process spawning, SDK bridges, ACP clients, or CLI/PTY
//! control yet.

pub mod codex;
pub mod codex_runtime;
pub mod live_registry;
pub mod config;
pub mod credentials;
pub mod persistence;
pub mod probes;
pub mod registry;
pub mod selection;
pub mod status;

pub use codex_runtime::{CodexSessionRuntime, CODEX_LIVE_ADAPTER_ID};
pub use live_registry::AgentAdapterRegistry;
pub use codex::{
    codex_app_server_descriptor, codex_app_server_registry, CodexAppServerDescriptor,
    CodexAppServerMethodSet, CodexAppServerSchemaEvidence,
};
pub use config::{AdapterConfigEntry, AdapterConfigScope, AdapterConfigValue};
pub use credentials::{
    AdapterCredentialAuditPolicy, AdapterCredentialResolutionRecord,
    AdapterCredentialResolutionStatus, AdapterSecretPurpose, AdapterSecretRef,
    AdapterSecretResolutionBoundary, AdapterSecretResolutionPolicy, AdapterSecretScope,
    AdapterSecretSource, RawSecretExposurePolicy,
};
pub use persistence::{
    AdapterRegistryPersistedField, AdapterRegistryPersistenceBackend,
    AdapterRegistryPersistencePolicy, AdapterRegistryRecomputedField, AdapterRegistryRepairPolicy,
    AdapterRegistrySnapshot,
};
pub use probes::{
    AdapterProbeAssessment, AdapterProbeCadence, AdapterProbeEvidence, AdapterProbeFailurePolicy,
    AdapterProbeKind, AdapterProbePolicy, AdapterProbeRequirement, AdapterProbeResult,
    AdapterProbeTarget, AdapterReadinessGate, AdapterStaleStatePolicy, AdapterStateAuthority,
};
pub use registry::{AdapterInstanceRecord, AdapterRegistry, AdapterRegistryId};
pub use selection::{
    AdapterCapabilityKey, AdapterCapabilityRequirement, AdapterInstanceId, AdapterSelectionOutcome,
    AdapterSelectionReason, AdapterSelectionRequest, AdapterSelectionScope,
    ResolvedAdapterConfigRef, ResolvedAdapterConfigValueKind,
};
pub use status::{AdapterHealth, AdapterLifecycleStatus, AdapterReadiness};
