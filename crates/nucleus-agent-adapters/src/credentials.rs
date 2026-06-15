//! Adapter secret reference and credential boundary records.

/// Reference to secret material without carrying the secret value.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterSecretRef {
    pub id: String,
    pub source: AdapterSecretSource,
    pub purpose: AdapterSecretPurpose,
    pub scope: AdapterSecretScope,
    pub label: Option<String>,
}

/// Where secret material is expected to live.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterSecretSource {
    HostCredentialProvider(String),
    NucleusSecretStore,
    ProviderNativeAuthState,
    EnvironmentVariable(String),
    ExternalSecretManager(String),
    Unknown,
}

/// Why an adapter may need secret material.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterSecretPurpose {
    ApiKey,
    AccessToken,
    RefreshToken,
    ExternalServerCredential,
    LocalCliAuthState,
    SdkSidecarCredential,
    McpServerCredential,
    Custom(String),
}

/// Scope attached to a secret reference.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterSecretScope {
    Driver,
    Instance,
    Project(String),
    Session(String),
}

/// Policy for when a secret reference may be resolved.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterSecretResolutionPolicy {
    pub allowed_boundary: AdapterSecretResolutionBoundary,
    pub raw_secret_exposure: RawSecretExposurePolicy,
    pub audit: AdapterCredentialAuditPolicy,
}

/// Runtime boundary allowed to receive resolved secret material.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterSecretResolutionBoundary {
    ServerOnly,
    OwnedProcessEnvironment,
    OwnedProcessStdin,
    SdkSidecar,
    ExternalServerRequest,
    HostCredentialProviderOnly,
    Unsupported,
}

/// Whether raw secret values may leave the server process.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RawSecretExposurePolicy {
    NeverExpose,
    RuntimeBoundaryOnly,
    ProviderNativeAuthOnly,
}

/// Audit fields allowed around credential use.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterCredentialAuditPolicy {
    pub retain_reference_id: bool,
    pub retain_source_kind: bool,
    pub retain_resolution_boundary: bool,
    pub retain_failure_reason: bool,
}

/// Result of resolving a secret reference, without secret material.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterCredentialResolutionRecord {
    pub secret_ref: AdapterSecretRef,
    pub boundary: AdapterSecretResolutionBoundary,
    pub status: AdapterCredentialResolutionStatus,
    pub observed_at_label: Option<String>,
}

/// Non-secret status of credential resolution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterCredentialResolutionStatus {
    Available,
    Missing,
    PermissionDenied,
    ProviderNativeStateRequired,
    UnsupportedSource,
    Unknown,
}
