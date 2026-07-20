//! Adapter registry, configured adapter state, and Nucleus-owned translation
//! layers over shared provider runtimes.

pub mod codex;
pub mod config;
pub mod credentials;
pub mod live_registry;
pub mod persistence;
pub mod probes;
pub mod registry;
pub mod selection;
pub mod status;
pub mod swallowtail_codex;

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
pub use live_registry::AgentAdapterRegistry;
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
pub use swallowtail_codex::{
    run_codex_read_only_smoke, CodexReadOnlySmokeCleanup, CodexReadOnlySmokeOutcome,
    CodexReadOnlySmokeStatus, SwallowtailCodexSessionRuntime, SwallowtailCodexTaskExecutionRuntime,
    CODEX_LIVE_ADAPTER_ID, CODEX_PROVIDER_INSTANCE_ID,
};
