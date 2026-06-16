//! Server boundary and control-plane API composition types.
//!
//! This crate names the server authority surface. It does not implement
//! networking, authentication, process control, or runtime routing yet.

pub mod authority;
pub mod client_auth;
pub mod clients;
pub mod command_artifacts;
pub mod command_runtime_readiness;
pub mod commands;
pub mod control_api;
pub mod control_serialization_readiness;
pub mod deployment;
pub mod event_replay;
pub mod events;
pub mod ids;
pub mod local_transport;
pub mod request_handler;
pub mod runtime_effect_events;
pub mod runtime_effect_replay;
pub mod runtime_effect_retention;
pub mod runtime_effect_storage;
pub mod runtime_effect_subscriptions;
pub mod runtime_effect_transport;
pub mod scheduler;
pub mod secret_store;
pub mod state;
pub mod tauri_ipc_command;
pub mod tauri_ipc_readiness;
pub mod transport_readiness;

pub use authority::{AuthorityArea, ServerAuthority};
pub use client_auth::{
    ClientAuthDeploymentPolicy, ClientAuthPosture, ClientAuthReadiness, ClientAuthReadinessBlocker,
    ClientAuthReadinessStatus, ClientAuthRecordId, ClientAuthSessionId, ClientAuthSessionRecord,
    ClientPairingId, ClientPairingMode, ClientPairingRecord, ClientRevocationRecord,
};
pub use clients::{ClientConnection, ClientIdentity, ClientKind};
pub use command_artifacts::{ServerCommandArtifactRecord, ServerCommandArtifactResolution};
pub use command_runtime_readiness::{
    ServerCommandRuntimeReadiness, ServerCommandRuntimeReadinessDisposition,
};
pub use commands::{
    AgentSessionCommand, ProjectCommand, ServerCommand, TaskCommand, WorkspaceCommand,
};
pub use control_api::{
    AdapterSessionQuery, ModelRouteQuery, RuntimeMetadataQuery, ServerCommandReceipt,
    ServerCommandReceiptStatus, ServerControlError, ServerControlRequest, ServerControlRequestKind,
    ServerControlResponse, ServerControlResponseBody, ServerControlResponseStatus, ServerQuery,
    ServerQueryKind, ServerQueryResult, ServerStateRecordSet, StateRecordQuery,
    StateRecordQueryScope,
};
pub use control_serialization_readiness::{
    ControlApiEnvelopeField, ControlApiEnvelopeShape, ControlApiSerializationReadiness,
    ControlApiSerializationReadinessBlocker, ControlApiSerializationReadinessPlan,
    ControlApiSerializationReadinessStatus,
};
pub use deployment::{AccessEndpoint, DeploymentMode, ServerRuntime};
pub use event_replay::{
    ServerEventReplayError, ServerEventReplayQuery, ServerEventReplayQueryScope,
    ServerEventReplayResponse, ServerEventReplayService, ServerEventReplayStatus,
    ServerEventReplayWindow,
};
pub use events::{ServerEvent, ServerEventKind};
pub use ids::{ClientId, ServerCommandId, ServerControlRequestId, ServerEventId, ServerQueryId};
pub use local_transport::{
    InProcessControlClientFixture, InProcessControlHandlerFixture, LocalControlTransport,
    LocalControlTransportBoundary, LocalControlTransportError, LocalControlTransportExchange,
};
pub use request_handler::{LocalControlRequestHandler, LocalControlRequestHandlerBoundary};
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
pub use scheduler::{
    RuntimeSchedulerAdmissionDecision, RuntimeSchedulerAdmissionRejection, RuntimeSchedulerQueue,
    RuntimeSchedulerQueuedItem, RuntimeSchedulerRequest, RuntimeSchedulerRequestId,
    RuntimeSchedulerRequestKind, RuntimeSchedulerRequestRefs,
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
pub use state::{ServerStateDomain, ServerStateDomainService, ServerStateService};
pub use tauri_ipc_command::{
    TauriIpcCommandBoundary, TauriIpcCommandBoundaryError, TauriIpcCommandBoundaryHandler,
    TauriIpcCommandBoundaryPosture, TauriIpcCommandExchange, TauriIpcCommandHandlerFixture,
};
pub use tauri_ipc_readiness::{
    TauriIpcCommandSchema, TauriIpcCommandShape, TauriIpcSchemaReadiness,
    TauriIpcSchemaReadinessBlocker, TauriIpcSchemaReadinessStatus,
};
pub use transport_readiness::{
    DesktopBootstrapRequirement, DesktopBootstrapStatus, LocalClientBootstrapProfile,
    LocalTransportCandidate, LocalTransportReadiness, LocalTransportReadinessBlocker,
    LocalTransportReadinessStatus,
};
