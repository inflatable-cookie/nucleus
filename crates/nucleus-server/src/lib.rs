//! Server boundary and control-plane API composition types.
//!
//! This crate names the server authority surface only. It does not implement
//! networking, storage, authentication, process control, or runtime routing yet.

pub mod authority;
pub mod client_auth;
pub mod clients;
pub mod command_runtime_readiness;
pub mod commands;
pub mod deployment;
pub mod events;
pub mod ids;
pub mod runtime_effect_events;
pub mod runtime_effect_replay;
pub mod runtime_effect_retention;
pub mod runtime_effect_storage;
pub mod runtime_effect_subscriptions;
pub mod runtime_effect_transport;
pub mod secret_store;

pub use authority::{AuthorityArea, ServerAuthority};
pub use client_auth::{
    ClientAuthDeploymentPolicy, ClientAuthPosture, ClientAuthRecordId, ClientAuthSessionId,
    ClientAuthSessionRecord, ClientPairingId, ClientPairingMode, ClientPairingRecord,
    ClientRevocationRecord,
};
pub use clients::{ClientConnection, ClientIdentity, ClientKind};
pub use command_runtime_readiness::{
    ServerCommandRuntimeReadiness, ServerCommandRuntimeReadinessDisposition,
};
pub use commands::{
    AgentSessionCommand, ProjectCommand, ServerCommand, TaskCommand, WorkspaceCommand,
};
pub use deployment::{AccessEndpoint, DeploymentMode, ServerRuntime};
pub use events::{ServerEvent, ServerEventKind};
pub use ids::{ClientId, ServerCommandId, ServerEventId};
pub use runtime_effect_events::{
    RuntimeEffectServerEvent, RuntimeEffectServerEventKind, ServerEventSequence,
};
pub use runtime_effect_replay::{
    RuntimeEffectClientOrderingToken, RuntimeEffectReplayQueryRequest,
    RuntimeEffectReplayQueryResponse, RuntimeEffectReplayQueryResult,
    RuntimeEffectReplayQueryStatus, RuntimeEffectReplayRefResolution,
    RuntimeEffectReplayStorageGeneration, RuntimeEffectReplayUnsupportedReason,
};
pub use runtime_effect_retention::{
    RuntimeEffectCompactionPosture, RuntimeEffectReplayDeploymentProfile,
    RuntimeEffectReplayDurability, RuntimeEffectRetainedRef, RuntimeEffectRetentionPolicy,
    RuntimeEffectSummaryRetention,
};
pub use runtime_effect_storage::{
    RuntimeEffectLatestStateLookup, RuntimeEffectRecoveryLookup, RuntimeEffectReplayCheckpoint,
    RuntimeEffectReplayCheckpointId, RuntimeEffectRetryLineageRef, RuntimeEffectStorageQuery,
    RuntimeEffectStorageRecordId, RuntimeEffectStorageRef, RuntimeEffectStoredEffectState,
    RuntimeEffectStoredEventKind, RuntimeEffectStoredEventRecord,
};
pub use runtime_effect_subscriptions::{
    RuntimeEffectBackpressurePosture, RuntimeEffectDeliveryAcknowledgement,
    RuntimeEffectDisconnectReason, RuntimeEffectReconnectRequirement,
    RuntimeEffectSubscriptionHandshake, RuntimeEffectSubscriptionId,
    RuntimeEffectSubscriptionState,
};
pub use runtime_effect_transport::{
    RuntimeEffectTransportAuthBlocker, RuntimeEffectTransportBoundaryGuarantee,
    RuntimeEffectTransportCapability, RuntimeEffectTransportFamily, RuntimeEffectTransportProfile,
    RuntimeEffectTransportSelectionCriteria,
};
pub use secret_store::{
    CredentialAccessPolicy, CredentialAuditRecord, CredentialIntegrationRef,
    CredentialLookupReadiness, CredentialMaterialClass, CredentialMaterialRef,
    CredentialMaterialStatus, CredentialRedactionPolicy, CredentialRepairWorkItem,
    CredentialResolutionAuditCapture, CredentialResolutionBlocker, CredentialResolutionImpact,
    CredentialResolutionIntegrationRecord, CredentialResolutionPreflight,
    CredentialResolutionReadiness, CredentialResolutionRepairAction, CredentialResolutionRequest,
    CredentialResolutionRuntimeBoundary, CredentialResolutionScope, CredentialRevocationPolicy,
    CredentialRotationPolicy, SecretBackendKind,
};
