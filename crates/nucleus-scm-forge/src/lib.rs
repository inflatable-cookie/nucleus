//! SCM and forge adapter boundary types.
//!
//! This crate names repository, provider refs, change refs, review refs,
//! task-link, conflict, observation, credential, webhook, and capability
//! surfaces. It does not implement Git commands, forge API clients, webhooks,
//! auth, sync workers, fake adapters, or fixture builders.

pub mod auth;
pub mod capabilities;
pub mod conflicts;
pub mod effects;
pub mod forge;
pub mod git_inspection;
pub mod ids;
pub mod links;
pub mod observations;
pub mod registry;
pub mod reviews;
pub mod runtime_effects;
pub mod runtime_events;
pub mod runtime_states;
pub mod scm;
pub mod session_commands;
pub mod traits;
pub mod webhooks;
pub mod work_sessions;

pub use auth::{
    CredentialFailureKind, CredentialKind, CredentialReference, CredentialReferenceId,
    CredentialResolutionBoundary, CredentialStatus, CredentialUseEvidence,
};
pub use capabilities::{ForgeCapability, ScmCapability, ScmForgeAdapterCapability};
pub use conflicts::{
    ScmConflictId, ScmConflictKind, ScmConflictRecord, ScmConflictResolutionPolicy,
    ScmConflictStatus,
};
pub use effects::{
    AdapterEffectAdapter, AdapterEffectCancellation, AdapterEffectOutcome,
    AdapterEffectOutcomeKind, AdapterEffectRequest, AdapterEffectRequestId,
    AdapterEffectRequestKind, AdapterEffectRetry, ForgeObservationBatch, ScmObservationBatch,
};
pub use forge::{
    ForgeCommentRef, ForgeIssueRef, ForgeProviderKind, ForgePullRequestRef, ForgeRepositoryRef,
};
pub use git_inspection::{
    GitStatusEntry, GitStatusEntryKind, GitStatusSnapshot, ScmHeadState, ScmInspectionAccess,
    ScmPathChangeKind, ScmPathStatus, ScmUpstreamState, ScmWorkingCopyInspection,
    ScmWorkingCopyInspectionIssue,
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
pub use registry::{
    convergence_scm_driver_descriptor, git_scm_driver_descriptor, github_forge_driver_descriptor,
    DriverImplementationStatus, ForgeDriverDescriptor, ForgeDriverId, ScmDriverDescriptor,
    ScmDriverId, ScmForgeDriverRegistry,
};
pub use reviews::{
    ReviewMergePolicy, ReviewOutcome, ReviewWorkflow, ReviewWorkflowId, ReviewWorkflowStatus,
};
pub use runtime_effects::{
    ForgeRuntimeEffectAcceptanceSurface, ForgeRuntimeEffectOutcomeSurface,
    ScmRuntimeEffectAcceptanceSurface, ScmRuntimeEffectOutcomeSurface,
};
pub use runtime_events::{
    AdapterCommandAuthorityRequestRef, AdapterEffectEventKind, AdapterEffectEventPayload,
    AdapterObservationBatchRef, AdapterSanitizedEvidenceRef, AdapterTaskLinkProposalRef,
};
pub use runtime_states::{
    AdapterEffectNonTerminalState, AdapterEffectState, AdapterEffectStateRecord,
    AdapterEffectTerminalState,
};
pub use scm::{
    ScmBranchRef, ScmChangeKind, ScmChangeRef, ScmCommitRef, ScmProviderKind, ScmRemoteRef,
    ScmRepositoryRef, ScmRuntimeConstraint, ScmWorkIsolationMode, ScmWorkSession,
    ScmWorkSessionStatus, ScmWorkflowPrimitive, ScmWorkflowSemantics, ScmWorktreeRef,
};
pub use session_commands::{
    ScmSessionCommandAdmission, ScmSessionCommandAdmissionStatus, ScmSessionCommandEvidenceRef,
    ScmSessionCommandId, ScmSessionCommandKind, ScmSessionCommandRequest, ScmSessionCommandScope,
};
pub use traits::{
    AdapterReadiness, ForgeAdapterSurface, ObservationSourceSurface, ScmAdapterSurface,
};
pub use webhooks::{
    WebhookEndpointId, WebhookVerificationEvidence, WebhookVerificationFailureKind,
    WebhookVerificationMethod, WebhookVerificationPolicy, WebhookVerificationStatus,
};
pub use work_sessions::{
    ScmIsolationSurface, ScmSessionCleanupPolicy, ScmSessionGuardCheck,
    ScmSessionRecoveryRecord, ScmSessionRecoveryRecordId, ScmSessionRecoveryState,
    ScmSessionTestLocation, ScmSessionTestability, ScmWorkingCopyLocation,
    ScmWorkingCopySessionMode, ScmWorkingCopySessionPlan, ScmWorkingSessionExecutionPrep,
    ScmWorkingSessionExecutionPrepStatus,
};
