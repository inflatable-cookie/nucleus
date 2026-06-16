//! Compile-only secret store and credential material boundary vocabulary.
//!
//! These records describe credential material references, backend families,
//! resolution scope, audit, rotation, revocation, and redaction posture only.
//! They do not implement a secret store, encryption, backend integration,
//! provider auth, command execution, or credential material access.

/// Non-secret reference to credential material.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CredentialMaterialRef(pub String);

/// Credential material class.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CredentialMaterialClass {
    ClientAuthCredential,
    PairingSecret,
    ProviderApiKey,
    ProviderAccessToken,
    ProviderRefreshToken,
    ModelRouteCredential,
    ScmCredential,
    ForgeCredential,
    SshKey,
    WebhookSigningSecret,
    CommandSecret,
    ProviderNativeAuthState,
    Custom(String),
}

/// Backend family that may hold credential material later.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SecretBackendKind {
    HostCredentialProvider,
    OsKeychain,
    ExternalSecretManager,
    ProviderNativeAuth,
    NucleusSecretStore,
    EnvironmentVariable,
    UserInteractive,
    Custom(String),
}

/// Non-secret status of credential material.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CredentialMaterialStatus {
    Unknown,
    Available,
    Missing,
    Expired,
    Revoked,
    PermissionDenied,
    RequiresUserAction,
    Unsupported,
}

/// Runtime scope allowed to request credential resolution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CredentialResolutionScope {
    ServerOnly,
    ClientAuth,
    AdapterRuntime,
    ModelRouteRuntime,
    ScmForgeRuntime,
    CommandRuntime,
    WebhookVerification,
    ProviderNativeOnly,
    Custom(String),
}

/// Request to resolve credential material by ref.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CredentialResolutionRequest {
    pub credential_ref: CredentialMaterialRef,
    pub material_class: CredentialMaterialClass,
    pub backend: SecretBackendKind,
    pub scope: CredentialResolutionScope,
    pub access_policy: CredentialAccessPolicy,
}

/// Access policy for credential material.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CredentialAccessPolicy {
    pub allow_raw_material_to_leave_server: bool,
    pub allow_runtime_injection: bool,
    pub requires_command_approval: bool,
    pub redaction: CredentialRedactionPolicy,
}

/// Redaction posture for credential-adjacent evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CredentialRedactionPolicy {
    RedactAll,
    RetainRefAndStatus,
    RetainRefStatusAndFailureKind,
    Custom(String),
}

/// Rotation posture for credential material.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CredentialRotationPolicy {
    Manual,
    ProviderManaged,
    ExternalManagerManaged,
    HostManaged,
    Unsupported,
    Custom(String),
}

/// Revocation posture for credential material.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CredentialRevocationPolicy {
    pub credential_ref: CredentialMaterialRef,
    pub invalidates_client_sessions: bool,
    pub invalidates_adapter_instances: bool,
    pub invalidates_model_routes: bool,
    pub blocks_command_execution: bool,
}

/// Sanitized credential audit record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CredentialAuditRecord {
    pub credential_ref: CredentialMaterialRef,
    pub material_class: CredentialMaterialClass,
    pub backend: SecretBackendKind,
    pub scope: CredentialResolutionScope,
    pub status: CredentialMaterialStatus,
    pub summary: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolution_request_names_secret_ref_without_material() {
        let request = CredentialResolutionRequest {
            credential_ref: CredentialMaterialRef("credential:model-route".to_owned()),
            material_class: CredentialMaterialClass::ModelRouteCredential,
            backend: SecretBackendKind::ExternalSecretManager,
            scope: CredentialResolutionScope::ModelRouteRuntime,
            access_policy: CredentialAccessPolicy {
                allow_raw_material_to_leave_server: false,
                allow_runtime_injection: true,
                requires_command_approval: false,
                redaction: CredentialRedactionPolicy::RetainRefStatusAndFailureKind,
            },
        };

        assert_eq!(
            request.material_class,
            CredentialMaterialClass::ModelRouteCredential
        );
        assert!(!request.access_policy.allow_raw_material_to_leave_server);
    }

    #[test]
    fn revocation_policy_fans_out_without_secret_values() {
        let policy = CredentialRevocationPolicy {
            credential_ref: CredentialMaterialRef("credential:forge".to_owned()),
            invalidates_client_sessions: false,
            invalidates_adapter_instances: true,
            invalidates_model_routes: false,
            blocks_command_execution: true,
        };

        assert!(policy.invalidates_adapter_instances);
        assert!(policy.blocks_command_execution);
    }
}
