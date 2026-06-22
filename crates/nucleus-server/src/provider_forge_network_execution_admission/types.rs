use serde::{Deserialize, Serialize};

use crate::{
    ForgePullRequestProvider, ForgePullRequestRunnerRequestAdapterSet, ForgePullRequestTextSource,
    GitPushRemoteTarget,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgeNetworkExecutionAdmissionInput {
    pub request_set: ForgePullRequestRunnerRequestAdapterSet,
    pub operation_family: ForgeNetworkExecutionOperationFamily,
    pub credential_ref: Option<ForgeNetworkExecutionCredentialRef>,
    pub network_authority_ref: Option<String>,
    pub operator_approval_ref: Option<String>,
    pub idempotency_key: Option<String>,
    pub retry_policy_ref: Option<String>,
    pub recovery_policy_ref: Option<String>,
    pub sanitization_policy_ref: Option<String>,
    pub raw_provider_payload_retention_requested: bool,
    pub real_credential_resolution_requested: bool,
    pub provider_network_call_requested: bool,
    pub callback_execution_requested: bool,
    pub interruption_execution_requested: bool,
    pub recovery_execution_requested: bool,
    pub task_mutation_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeNetworkExecutionAdmissionSet {
    pub admission_set_id: String,
    pub admissions: Vec<ForgeNetworkExecutionAdmissionRecord>,
    pub skipped_request_adapter_ids: Vec<String>,
    pub stopped_preflight_permitted: bool,
    pub credential_resolution_performed: bool,
    pub provider_network_call_performed: bool,
    pub forge_effect_executed: bool,
    pub provider_effect_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeNetworkExecutionAdmissionRecord {
    pub admission_id: String,
    pub request_adapter_id: String,
    pub upstream_admission_id: String,
    pub request_id: String,
    pub task_id: String,
    pub repo_id: String,
    pub operator_ref: String,
    pub operation_family: ForgeNetworkExecutionOperationFamily,
    pub credential_ref: Option<ForgeNetworkExecutionCredentialRef>,
    pub network_authority_ref: Option<String>,
    pub operator_approval_ref: Option<String>,
    pub idempotency_key: Option<String>,
    pub retry_policy_ref: Option<String>,
    pub recovery_policy_ref: Option<String>,
    pub sanitization_policy_ref: Option<String>,
    pub forge_provider: Option<ForgePullRequestProvider>,
    pub remote_target: Option<GitPushRemoteTarget>,
    pub base_branch: Option<String>,
    pub head_branch: Option<String>,
    pub title_source: Option<ForgePullRequestTextSource>,
    pub body_source: Option<ForgePullRequestTextSource>,
    pub status: ForgeNetworkExecutionAdmissionStatus,
    pub blockers: Vec<ForgeNetworkExecutionAdmissionBlocker>,
    pub stopped_preflight_permitted: bool,
    pub credential_resolution_performed: bool,
    pub provider_network_call_performed: bool,
    pub forge_effect_executed: bool,
    pub provider_effect_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeNetworkExecutionCredentialRef {
    pub credential_ref_id: String,
    pub credential_kind: ForgeNetworkCredentialKind,
    pub resolution_boundary: ForgeNetworkCredentialResolutionBoundary,
    pub status: ForgeNetworkCredentialStatus,
    pub allowed_operation_families: Vec<ForgeNetworkExecutionOperationFamily>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeNetworkCredentialKind {
    ForgeApiToken,
    ForgeAppInstallation,
    SshKey,
    HostCredentialProvider,
    ProviderNativeAuthState,
    Custom,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeNetworkCredentialResolutionBoundary {
    ServerSecretStore,
    HostCredentialProvider,
    ProviderNativeAuth,
    ExternalSecretManager,
    UserInteractiveFlow,
    Unresolved,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeNetworkCredentialStatus {
    Ready,
    Unresolved,
    Expired,
    Revoked,
    PermissionDenied,
    RequiresUserAction,
    Unsupported,
    MissingScope,
    ProviderUnavailable,
    RepairRequired,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeNetworkExecutionOperationFamily {
    ProviderAuthStatusRefresh,
    RepositoryMetadataRefresh,
    PullRequestRefresh,
    IssueRefresh,
    CommentRefresh,
    ReviewWorkflowRefresh,
    StatusCheckRefresh,
    PullRequestCreate,
    PullRequestUpdate,
    CommentCreate,
    ReviewRequestUpdate,
    LabelOrMetadataUpdate,
    StatusCheckUpdate,
    Merge,
    CloseWithoutReviewOutcome,
    BranchProtectionMutation,
    RepositorySettingMutation,
    ForcePush,
    DestructiveBranchDeletion,
    ProviderPermissionMutation,
}

impl ForgeNetworkExecutionOperationFamily {
    pub fn is_mutating(&self) -> bool {
        matches!(
            self,
            Self::PullRequestCreate
                | Self::PullRequestUpdate
                | Self::CommentCreate
                | Self::ReviewRequestUpdate
                | Self::LabelOrMetadataUpdate
                | Self::StatusCheckUpdate
                | Self::Merge
                | Self::CloseWithoutReviewOutcome
                | Self::BranchProtectionMutation
                | Self::RepositorySettingMutation
                | Self::ForcePush
                | Self::DestructiveBranchDeletion
                | Self::ProviderPermissionMutation
        )
    }

    pub fn is_deferred(&self) -> bool {
        matches!(
            self,
            Self::Merge
                | Self::CloseWithoutReviewOutcome
                | Self::BranchProtectionMutation
                | Self::RepositorySettingMutation
                | Self::ForcePush
                | Self::DestructiveBranchDeletion
                | Self::ProviderPermissionMutation
        )
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeNetworkExecutionAdmissionStatus {
    ReadyForStoppedPreflight,
    Blocked,
    RepairRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeNetworkExecutionAdmissionBlocker {
    ProviderRequestNotPrepared,
    MissingForgeProvider,
    MissingCredentialRef,
    CredentialNotReady,
    CredentialOperationNotAllowed,
    MissingNetworkAuthorityRef,
    MissingOperatorApprovalRef,
    MissingIdempotencyKey,
    MissingRetryPolicyRef,
    MissingRecoveryPolicyRef,
    MissingSanitizationPolicyRef,
    DeferredOperationFamily,
    RawProviderPayloadRetentionRequested,
    RealCredentialResolutionRequested,
    ProviderNetworkCallRequested,
    CallbackExecutionRequested,
    InterruptionExecutionRequested,
    RecoveryExecutionRequested,
    TaskMutationRequested,
}
