//! Credential reference and sanitized auth evidence types.

/// Stable credential reference id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CredentialReferenceId(pub String);

/// Non-secret reference to credential material.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CredentialReference {
    pub id: CredentialReferenceId,
    pub kind: CredentialKind,
    pub resolution_boundary: CredentialResolutionBoundary,
    pub status: CredentialStatus,
    pub display_hint: Option<String>,
}

/// Credential material kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CredentialKind {
    LocalScmCommand,
    ForgeApiToken,
    ForgeAppInstallation,
    SshKey,
    WebhookSigningSecret,
    HostCredentialProvider,
    ExternalSecretManager,
    ProviderNativeAuthState,
    Custom(String),
}

/// Boundary responsible for resolving a credential reference.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CredentialResolutionBoundary {
    ServerSecretStore,
    HostCredentialProvider,
    ProviderNativeAuth,
    ExternalSecretManager,
    UserInteractive,
    Unresolved,
}

/// Safe credential reference status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CredentialStatus {
    Unknown,
    Available,
    Missing,
    Expired,
    PermissionDenied,
    Invalid,
    RequiresUserAction,
}

/// Sanitized auth evidence retained by Nucleus.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CredentialUseEvidence {
    pub credential_ref: CredentialReferenceId,
    pub boundary: CredentialResolutionBoundary,
    pub status: CredentialStatus,
    pub failure_kind: Option<CredentialFailureKind>,
    pub summary: Option<String>,
}

/// Sanitized credential failure kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CredentialFailureKind {
    Missing,
    Expired,
    PermissionDenied,
    ProviderRejected,
    NetworkFailure,
    Misconfigured,
    Unknown,
}
