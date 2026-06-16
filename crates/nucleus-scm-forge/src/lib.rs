//! SCM and forge adapter boundary types.
//!
//! This crate names repository, branch, commit, pull request, issue, comment,
//! task-link, observation, and capability surfaces. It does not implement Git
//! commands, forge API clients, webhooks, auth, or sync workers.

pub mod auth;
pub mod capabilities;
pub mod forge;
pub mod ids;
pub mod links;
pub mod observations;
pub mod scm;
pub mod webhooks;

pub use auth::{
    CredentialFailureKind, CredentialKind, CredentialReference, CredentialReferenceId,
    CredentialResolutionBoundary, CredentialStatus, CredentialUseEvidence,
};
pub use capabilities::{ForgeCapability, ScmCapability, ScmForgeAdapterCapability};
pub use forge::{
    ForgeCommentRef, ForgeIssueRef, ForgeProviderKind, ForgePullRequestRef, ForgeRepositoryRef,
};
pub use ids::{
    ForgeAdapterInstanceId, ForgeProviderRef, ScmAdapterInstanceId, ScmProviderRef,
    ScmRepositoryRefId, ScmWorkSessionId, ScmWorktreeRefId,
};
pub use links::{
    ForgeTaskLink, ForgeTaskLinkKind, ScmTaskLink, ScmTaskLinkKind, TaskLinkSource, TaskLinkStatus,
};
pub use observations::{
    ForgeObservation, ForgeObservationId, ForgeObservationKind, ForgeRefreshMode,
    ObservationDedupeKey, ObservationEffect, ScmObservation, ScmObservationId, ScmObservationKind,
};
pub use scm::{
    ScmBranchRef, ScmChangeKind, ScmChangeRef, ScmCommitRef, ScmProviderKind, ScmRemoteRef,
    ScmRepositoryRef, ScmRuntimeConstraint, ScmWorkIsolationMode, ScmWorkSession,
    ScmWorkSessionStatus, ScmWorktreeRef,
};
pub use webhooks::{
    WebhookEndpointId, WebhookVerificationEvidence, WebhookVerificationFailureKind,
    WebhookVerificationMethod, WebhookVerificationPolicy, WebhookVerificationStatus,
};
