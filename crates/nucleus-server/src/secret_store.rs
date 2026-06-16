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

/// Domain-specific credential ref mapped into the server credential material
/// boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CredentialIntegrationRef {
    ClientAuth(String),
    AdapterRegistry(String),
    ModelRoute(String),
    ScmForge(String),
    Webhook(String),
    CommandPolicy(String),
    NativeHarness(String),
    Custom(String),
}

/// Integration record linking a domain ref to a server credential material ref.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CredentialResolutionIntegrationRecord {
    pub integration_ref: CredentialIntegrationRef,
    pub credential_ref: CredentialMaterialRef,
    pub scope: CredentialResolutionScope,
    pub status: CredentialMaterialStatus,
    pub impact: CredentialResolutionImpact,
    pub repair: Option<CredentialResolutionRepairAction>,
}

/// What a credential resolution status affects.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CredentialResolutionImpact {
    NoBlock,
    BlocksClientAuth,
    BlocksAdapterReadiness,
    BlocksModelRoute,
    BlocksScmForgeAccess,
    BlocksWebhookVerification,
    BlocksCommandExecution,
    RepairRequired,
    Custom(String),
}

/// Repair action for missing or unusable credential material.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CredentialResolutionRepairAction {
    AskUserToPairClient,
    AskUserToLoginProvider,
    AskUserToSelectCredentialRef,
    AskUserToRefreshCredential,
    AskUserToGrantPermission,
    MarkProviderNativeAuthRequired,
    MarkUnsupported,
    Custom(String),
}

/// Resolution blocker surfaced before runtime credential access.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CredentialResolutionBlocker {
    pub credential_ref: CredentialMaterialRef,
    pub status: CredentialMaterialStatus,
    pub impact: CredentialResolutionImpact,
    pub repair: Option<CredentialResolutionRepairAction>,
    pub summary: Option<String>,
}

/// Runtime boundary that may receive resolved credential material later.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CredentialResolutionRuntimeBoundary {
    ServerMemoryOnly,
    ProcessEnvironmentInjection,
    ProcessStdinInjection,
    SdkSidecarRequest,
    ExternalServerRequest,
    ProviderNativeBoundary,
    WebhookVerifier,
    Unsupported,
    Custom(String),
}

/// Readiness of a credential lookup path.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CredentialLookupReadiness {
    Ready,
    MissingPolicy,
    MissingBackend,
    MissingUserPrompt,
    MissingAuditPolicy,
    MissingRedactionPolicy,
    Blocked(CredentialResolutionBlocker),
    Unsupported(String),
}

/// Preflight record before a runtime may request material.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CredentialResolutionPreflight {
    pub request: CredentialResolutionRequest,
    pub runtime_boundary: CredentialResolutionRuntimeBoundary,
    pub lookup_readiness: CredentialLookupReadiness,
    pub audit: CredentialResolutionAuditCapture,
}

/// Sanitized audit capture posture for resolution attempts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CredentialResolutionAuditCapture {
    pub retain_ref: bool,
    pub retain_backend_kind: bool,
    pub retain_scope: bool,
    pub retain_status: bool,
    pub retain_failure_summary: bool,
}

/// Repair work item emitted by credential readiness checks.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CredentialRepairWorkItem {
    pub credential_ref: CredentialMaterialRef,
    pub action: CredentialResolutionRepairAction,
    pub impact: CredentialResolutionImpact,
    pub summary: Option<String>,
}

/// Overall readiness result. This is not a resolution result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CredentialResolutionReadiness {
    pub preflight: CredentialResolutionPreflight,
    pub repair_work: Vec<CredentialRepairWorkItem>,
    pub may_attempt_lookup: bool,
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

    #[test]
    fn integration_record_maps_domain_ref_to_server_credential_ref() {
        let record = CredentialResolutionIntegrationRecord {
            integration_ref: CredentialIntegrationRef::AdapterRegistry(
                "adapter-secret:1".to_owned(),
            ),
            credential_ref: CredentialMaterialRef("credential:adapter:1".to_owned()),
            scope: CredentialResolutionScope::AdapterRuntime,
            status: CredentialMaterialStatus::Missing,
            impact: CredentialResolutionImpact::BlocksAdapterReadiness,
            repair: Some(CredentialResolutionRepairAction::AskUserToSelectCredentialRef),
        };

        assert_eq!(
            record.impact,
            CredentialResolutionImpact::BlocksAdapterReadiness
        );
        assert!(record.repair.is_some());
    }

    #[test]
    fn blocker_distinguishes_credential_access_from_command_approval() {
        let blocker = CredentialResolutionBlocker {
            credential_ref: CredentialMaterialRef("credential:command".to_owned()),
            status: CredentialMaterialStatus::PermissionDenied,
            impact: CredentialResolutionImpact::BlocksCommandExecution,
            repair: Some(CredentialResolutionRepairAction::AskUserToGrantPermission),
            summary: Some("credential policy denied access".to_owned()),
        };

        assert_eq!(
            blocker.impact,
            CredentialResolutionImpact::BlocksCommandExecution
        );
        assert_eq!(blocker.status, CredentialMaterialStatus::PermissionDenied);
    }

    #[test]
    fn preflight_can_be_ready_without_resolving_material() {
        let request = CredentialResolutionRequest {
            credential_ref: CredentialMaterialRef("credential:webhook".to_owned()),
            material_class: CredentialMaterialClass::WebhookSigningSecret,
            backend: SecretBackendKind::HostCredentialProvider,
            scope: CredentialResolutionScope::WebhookVerification,
            access_policy: CredentialAccessPolicy {
                allow_raw_material_to_leave_server: false,
                allow_runtime_injection: false,
                requires_command_approval: false,
                redaction: CredentialRedactionPolicy::RetainRefAndStatus,
            },
        };

        let preflight = CredentialResolutionPreflight {
            request,
            runtime_boundary: CredentialResolutionRuntimeBoundary::WebhookVerifier,
            lookup_readiness: CredentialLookupReadiness::Ready,
            audit: CredentialResolutionAuditCapture {
                retain_ref: true,
                retain_backend_kind: true,
                retain_scope: true,
                retain_status: true,
                retain_failure_summary: true,
            },
        };

        let readiness = CredentialResolutionReadiness {
            preflight,
            repair_work: Vec::new(),
            may_attempt_lookup: true,
        };

        assert!(readiness.may_attempt_lookup);
        assert!(readiness.repair_work.is_empty());
    }

    #[test]
    fn readiness_can_emit_repair_work_without_lookup() {
        let repair = CredentialRepairWorkItem {
            credential_ref: CredentialMaterialRef("credential:provider".to_owned()),
            action: CredentialResolutionRepairAction::AskUserToLoginProvider,
            impact: CredentialResolutionImpact::BlocksAdapterReadiness,
            summary: Some("provider login required".to_owned()),
        };

        assert_eq!(
            repair.impact,
            CredentialResolutionImpact::BlocksAdapterReadiness
        );
        assert_eq!(
            repair.action,
            CredentialResolutionRepairAction::AskUserToLoginProvider
        );
    }
}
