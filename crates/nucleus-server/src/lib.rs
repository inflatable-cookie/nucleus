//! Server boundary and control-plane API composition types.
//!
//! This crate names the server authority surface. It does not implement
//! networking, authentication, process control, or runtime routing yet.

pub mod artifact_store_backend;
pub mod authority;
pub mod checkpoint_diff_state;
pub mod client_auth;
pub mod client_auth_posture;
pub mod client_protocol;
pub mod clients;
pub mod codex_runtime_validation;
pub mod codex_supervision;
pub mod codex_task_runtime;
pub mod codex_wait_state;
pub mod command_artifacts;
pub mod command_evidence_state;
pub mod command_runtime_readiness;
pub mod commands;
pub mod control_api;
pub mod control_envelope_dto;
pub mod control_serialization_readiness;
pub mod deployment;
pub mod diagnostics_read_models;
pub mod event_replay;
pub mod events;
pub mod host_authority;
pub mod host_spawn_readiness;
pub mod ids;
pub mod local_artifact_store_backend;
pub mod local_command_runner;
pub mod local_event_transport_backend;
pub mod local_host_runtime_discovery;
pub mod local_process_control_backend;
pub mod local_read_only_spawn;
pub mod local_read_only_spawn_smoke;
pub mod local_sandbox_backend;
pub mod local_transport;
pub mod management_projection_state;
pub mod process_control_backend;
pub mod process_event_transport_backend;
pub mod process_interruption;
pub mod process_supervision_events;
pub mod process_supervisor;
pub mod project_seed;
pub mod read_only_command_control;
pub mod request_handler;
pub mod runtime_effect_events;
pub mod runtime_effect_replay;
pub mod runtime_effect_retention;
pub mod runtime_effect_storage;
pub mod runtime_effect_subscriptions;
pub mod runtime_effect_transport;
pub mod runtime_readiness_diagnostics;
pub mod runtime_receipt_state;
pub mod sandbox_backend;
pub mod scheduler;
pub mod secret_store;
pub mod server_read_only_spawn;
pub mod state;
pub mod task_seed;
pub mod tauri_ipc_command;
pub mod tauri_ipc_readiness;
pub mod transport_readiness;

pub use artifact_store_backend::{
    ArtifactStoreBackendEvidenceRef, ArtifactStoreBackendKind, ArtifactStoreBackendReadiness,
};
pub use authority::{AuthorityArea, ServerAuthority};
pub use checkpoint_diff_state::{
    read_checkpoint_records, read_diff_summary_records, write_checkpoint_record,
    write_diff_summary_record,
};
pub use client_auth::{
    ClientAuthDeploymentPolicy, ClientAuthPosture, ClientAuthReadiness, ClientAuthReadinessBlocker,
    ClientAuthReadinessStatus, ClientAuthRecordId, ClientAuthSessionId, ClientAuthSessionRecord,
    ClientPairingId, ClientPairingMode, ClientPairingRecord, ClientRevocationRecord,
};
pub use client_auth_posture::{
    ClientAuthDisposition, ClientAuthPostureReason, ClientAuthPostureRecord,
    ClientAuthSessionPublication, ClientCommandApprovalBoundary, ClientCredentialReference,
    ClientCredentialReferenceScope, ProviderCredentialBoundary,
};
pub use client_protocol::{
    ClientProtocolAuthority, ClientProtocolCompatibility, ClientProtocolEnvelopeField,
    ClientProtocolMessageKind, ClientProtocolMessageShape, ClientProtocolProfile,
    ClientProtocolReadiness, ClientProtocolReadinessBlocker, ClientProtocolReadinessStatus,
    HostAuthorityMapPublication, HostCapabilityAdvertisement, HostCapabilityAdvertisementStatus,
    HostCapabilityCategory, HostCapabilityReadinessRef, HostCapabilityReadinessStatus,
    HostConnectionMode, HostRuntimeReadinessPublication, ProjectAuthorityDomainPublication,
    ProjectAuthorityMapPublicationRecord, ProjectAuthorityPublicationState,
    ProjectAuthorityValidationIssue, CLIENT_PROTOCOL_FAMILY, CLIENT_PROTOCOL_VERSION_V1,
};
pub use clients::{ClientConnection, ClientIdentity, ClientKind};
pub use codex_runtime_validation::{
    codex_recovery_receipt_from_fallback, validate_codex_runtime_supervision,
    CodexRuntimeValidationBlocker, CodexRuntimeValidationEvidence, CodexRuntimeValidationReport,
    CodexRuntimeValidationStatus, CodexTaskBackedWorkGate,
};
pub use codex_supervision::{
    accept_codex_ingestion_source, admit_codex_spawn_intent, assess_codex_app_server_handshake,
    assess_codex_app_server_supervision, codex_frame_key_from_source,
    codex_ingestion_source_from_live_frame, codex_live_spawn_smoke_evidence,
    codex_live_spawn_smoke_request, codex_receipt_from_live_spawn_smoke_evidence,
    codex_receipt_from_spawn_intent, codex_receipt_from_stdio_frame,
    codex_replacement_thread_recovery_binding, codex_runtime_instance_from_supervision_request,
    codex_session_binding_from_live_frame, codex_stdio_frame_source_record,
    ingest_codex_app_server_live_frame, link_codex_observation_to_event_store,
    run_codex_live_spawn_smoke, CodexAppServerBinary, CodexAppServerBindingConfidence,
    CodexAppServerBindingStatus, CodexAppServerFrameAcceptanceContext,
    CodexAppServerFrameAcceptanceRecord, CodexAppServerFrameAcceptanceStatus,
    CodexAppServerFrameKey, CodexAppServerHandshakeBlocker, CodexAppServerHandshakeExpectation,
    CodexAppServerHandshakeObservation, CodexAppServerHandshakePreflight,
    CodexAppServerHandshakePreflightStatus, CodexAppServerIngestionIdentityQuality,
    CodexAppServerIngestionSourceId, CodexAppServerIngestionSourceRecord, CodexAppServerLiveFrame,
    CodexAppServerLiveIngestion, CodexAppServerLiveIngestionStatus, CodexAppServerLiveProjection,
    CodexAppServerLiveSpawnSmokeCleanupPolicy, CodexAppServerLiveSpawnSmokeEvidenceRecord,
    CodexAppServerLiveSpawnSmokeEvidenceRecordId, CodexAppServerLiveSpawnSmokeLimits,
    CodexAppServerLiveSpawnSmokeOutcome, CodexAppServerLiveSpawnSmokeRequest,
    CodexAppServerLiveSpawnSmokeRequestId, CodexAppServerLiveSpawnSmokeRequestRejection,
    CodexAppServerLiveSpawnSmokeRunnerInput, CodexAppServerLiveSpawnSmokeRunnerResult,
    CodexAppServerObservationEventLink, CodexAppServerObservationEventLinkStatus,
    CodexAppServerObservationKind, CodexAppServerPayloadRetentionPolicy,
    CodexAppServerRuntimeInstanceId, CodexAppServerRuntimeInstanceRecord,
    CodexAppServerRuntimeInstanceState, CodexAppServerSchemaEvidenceRef,
    CodexAppServerSessionBindingId, CodexAppServerSessionBindingRecord,
    CodexAppServerSpawnIntentAdmission, CodexAppServerSpawnIntentAdmissionStatus,
    CodexAppServerSpawnIntentId, CodexAppServerStdioDecodeStatus,
    CodexAppServerStdioFrameDirection, CodexAppServerStdioFrameSourceId,
    CodexAppServerStdioFrameSourceRecord, CodexAppServerSupervisionBlocker,
    CodexAppServerSupervisionLimits, CodexAppServerSupervisionReadiness,
    CodexAppServerSupervisionReadinessInput, CodexAppServerSupervisionReadinessStatus,
    CodexAppServerSupervisionRequest, CodexAppServerTransportReceiptKind,
    CodexAppServerTurnStartAdmission, CodexAppServerTurnStartAdmissionBlocker,
    CodexAppServerTurnStartAdmissionId, CodexAppServerTurnStartAdmissionInput,
    CodexAppServerTurnStartAdmissionStatus, CodexAppServerTurnStartDeferredPolicy,
    CodexAppServerTurnStartEnvelopeId, CodexAppServerTurnStartEnvelopeRecord,
    CodexAppServerTurnStartEnvelopeRejection,
    CodexAppServerTurnStartOutcomeId, CodexAppServerTurnStartOutcomeRecord,
    CodexAppServerTurnStartOutcomeStatus,
    CodexAppServerTurnStartPromptRef, CodexAppServerTurnStartPromptRetentionPolicy,
    CodexAppServerTurnStartRequest, CodexAppServerTurnStartRequestId,
    CodexAppServerTurnStartRequestRejection, CodexAppServerTurnStartSendCommandId,
    CodexAppServerTurnStartSendCommandRecord, CodexAppServerTurnStartSendCommandRejection,
    CodexAppServerTurnStartWriteTarget, CodexAppServerUnsupportedObservation,
    CodexRawPayloadPolicy, CodexAppServerSubscriptionState,
    CodexAppServerSubscriptionStateId, CodexAppServerSubscriptionStateRecord,
    CodexAppServerStdioWriteState, CodexAppServerStdioWriteStateId,
    CodexAppServerStdioWriteStateRecord, admit_codex_turn_start,
    codex_receipt_from_subscription_state, codex_receipt_from_stdio_write_state,
    codex_receipt_from_turn_start_outcome, codex_subscription_state_from_send_command,
    codex_stdio_write_state_from_send_command, codex_turn_start_envelope,
    codex_turn_start_outcome_from_admission, codex_turn_start_outcome_from_envelope,
    codex_turn_start_request, codex_turn_start_send_command,
};
pub use codex_task_runtime::{
    admit_codex_task_runtime_request, classify_codex_task_runtime_error,
    codex_task_runtime_recovery_gate, link_codex_observation_to_task_runtime,
    link_codex_task_runtime_receipt, link_codex_wait_to_task_runtime,
    map_codex_task_progress_from_ingestion, progress_from_codex_wait_link,
    CodexTaskRuntimeAdmission, CodexTaskRuntimeErrorClass, CodexTaskRuntimeErrorClassification,
    CodexTaskRuntimeObservationLink, CodexTaskRuntimeObservationLinkStatus,
    CodexTaskRuntimeProgressEvent, CodexTaskRuntimeProgressKind, CodexTaskRuntimeProviderRefs,
    CodexTaskRuntimeReceiptLink, CodexTaskRuntimeRecoveryGate, CodexTaskRuntimeRecoveryState,
    CodexTaskRuntimeRequestId, CodexTaskRuntimeRequestRecord, CodexTaskRuntimeWaitLink,
};
pub use codex_wait_state::{
    cancel_codex_wait_state, route_codex_wait_state_from_ingestion, time_out_codex_wait_state,
    CodexWaitStateKind, CodexWaitStateRecord, CodexWaitStateRouting, CodexWaitStateStatus,
    CodexWaitStateTerminalRouting,
};
pub use command_artifacts::{ServerCommandArtifactRecord, ServerCommandArtifactResolution};
pub use command_evidence_state::write_command_evidence;
pub use command_runtime_readiness::{
    ServerCommandRuntimeReadiness, ServerCommandRuntimeReadinessDisposition,
};
pub use commands::{
    AgentSessionCommand, ProjectCommand, ReadOnlyCommand, ServerCommand, TaskCommand,
    TaskTransitionCommand, WorkspaceCommand,
};
pub use control_api::{
    AdapterSessionQuery, DiagnosticsQuery, ModelRouteQuery, ProjectAuthorityMapQuery,
    RuntimeMetadataQuery, ServerCommandReceipt, ServerCommandReceiptStatus, ServerControlError,
    ServerControlRequest, ServerControlRequestKind, ServerControlResponse,
    ServerControlResponseBody, ServerControlResponseStatus, ServerDiagnosticsQueryResult,
    ServerDiagnosticsSnapshot, ServerQuery, ServerQueryKind, ServerQueryResult,
    ServerStateRecordSet, StateRecordQuery, StateRecordQueryScope,
};
pub use control_envelope_dto::{
    ControlApiCodecError, ControlCheckpointRecordDto, ControlCommandDto,
    ControlCommandEvidenceRecordDto, ControlDiffSummaryRecordDto, ControlProjectAuthorityDomainDto,
    ControlProjectAuthorityIssueDto, ControlProjectAuthorityMapDto, ControlProjectRecordDto,
    ControlQueryDto, ControlQueryScopeDto, ControlRequestBodyDto, ControlRequestEnvelopeDto,
    ControlResponseBodyDto, ControlResponseEnvelopeDto, ControlResponseStatusDto,
    ControlStateDomainDto, ControlStateRecordDto, ControlTaskRecordDto,
};
pub use control_serialization_readiness::{
    ControlApiCodecBoundary, ControlApiCodecFailure, ControlApiDtoAuthority,
    ControlApiEnvelopeField, ControlApiEnvelopeShape, ControlApiProtocolVersionPolicy,
    ControlApiSerializationReadiness, ControlApiSerializationReadinessBlocker,
    ControlApiSerializationReadinessPlan, ControlApiSerializationReadinessStatus,
    ControlApiVersionCompatibility, ControlApiWireFormat, ControlApiWireMessageKind,
    CONTROL_API_PROTOCOL_FAMILY, CONTROL_API_PROTOCOL_VERSION_V1,
};
pub use deployment::{AccessEndpoint, DeploymentMode, ServerRuntime};
pub use diagnostics_read_models::{
    codex_ingestion_diagnostics, codex_live_spawn_smoke_diagnostics, effigy_diagnostics,
    codex_turn_start_diagnostics, management_sync_review_model, scm_session_diagnostics,
    steward_diagnostics, sync_diagnostics, task_agent_diagnostics, CodexIngestionDiagnosticsDto,
    CodexIngestionObservationDiagnosticDto, CodexLiveSpawnSmokeDiagnosticDto,
    CodexLiveSpawnSmokeDiagnosticsDto, CodexTurnStartDiagnosticDto,
    CodexTurnStartDiagnosticsDto, EffigyDiagnosticsDto,
    ScmCommandAdmissionDiagnosticDto, ScmSessionDiagnosticsDto, ScmSessionPlanDiagnosticDto,
    ScmWorkItemLinkDiagnosticDto, StewardCommandAdmissionDiagnosticDto,
    StewardCommandOutcomeDiagnosticDto, StewardDiagnosticsDto, StewardProposalDiagnosticDto,
    SyncAppliedRecordReviewDto, SyncApplyBlockReviewDto, SyncAssistanceDiagnosticDto,
    SyncCapturePrepDiagnosticDto, SyncConflictReviewDto, SyncDiagnosticsDto, SyncPlanDiagnosticDto,
    SyncReceiptReviewDto, SyncRepairDiagnosticDto, SyncReviewModelDto, SyncStagedRecordReviewDto,
    TaskAgentDiagnosticsDto, TaskAgentWorkUnitDiagnosticDto, TaskAgentWorkUnitIssueDto,
};
pub use event_replay::{
    ServerEventReplayError, ServerEventReplayQuery, ServerEventReplayQueryScope,
    ServerEventReplayResponse, ServerEventReplayService, ServerEventReplayStatus,
    ServerEventReplayWindow,
};
pub use events::{ServerEvent, ServerEventKind};
pub use host_authority::{
    EngineHostDescriptor, EngineHostForm, EngineHostId, HostAuthorityReadiness,
    HostAuthorityReadinessStatus, ProjectAuthorityAssignment, ProjectAuthorityDomain,
    ProjectAuthorityMap,
};
pub use host_spawn_readiness::{
    evaluate_host_spawn_readiness, HostSpawnReadinessBlocker, HostSpawnReadinessGate,
    HostSpawnReadinessInput, HostSpawnReadinessStatus,
};
pub use ids::{ClientId, ServerCommandId, ServerControlRequestId, ServerEventId, ServerQueryId};
pub use local_artifact_store_backend::{
    with_local_artifact_store_readiness, LocalArtifactMetadataId, LocalArtifactMetadataRecord,
    LocalArtifactMetadataStore, LocalArtifactStoreBackend, LocalArtifactStoreError,
};
pub use local_command_runner::{LocalReadOnlyCommandRunner, LocalReadOnlyCommandRunnerRejection};
pub use local_event_transport_backend::{
    with_local_event_transport_readiness, LocalEventTransportBackend, LocalEventTransportChannelId,
    LocalEventTransportError, LocalEventTransportReplayPosture, LocalSupervisionEventChannel,
};
pub use local_host_runtime_discovery::{
    evaluate_host_spawn_readiness_from_discovery, unsupported_local_host_runtime_discovery,
    LocalHostRuntimeDiscovery, LocalHostRuntimeDiscoveryEvidenceRef,
    LocalHostRuntimeDiscoveryFinding, LocalHostRuntimeDiscoveryGateInput,
    LocalHostRuntimeDiscoveryStatus,
};
pub use local_process_control_backend::{
    with_local_process_control_readiness, LocalProcessControlBackend, LocalProcessControlBackendId,
    LocalProcessControlError, LocalProcessControlReadinessProfile, LocalProcessControlRuntime,
};
pub use local_read_only_spawn::{
    run_local_read_only_spawn, LocalReadOnlySpawnError, LocalReadOnlySpawnInput,
    LocalReadOnlySpawnOutcome, LocalReadOnlySpawnOutputSummary, LocalReadOnlySpawnRejection,
    LocalReadOnlySpawnResult,
};
pub use local_read_only_spawn_smoke::{
    build_local_read_only_spawn_smoke_input, LocalReadOnlySpawnSmokeError,
    LocalReadOnlySpawnSmokeInput,
};
pub use local_sandbox_backend::{
    with_local_sandbox_readiness, LocalSandboxBackend, LocalSandboxBackendId,
    LocalSandboxBackendPlatform, LocalSandboxBackendPosture, LocalSandboxError,
    LocalSandboxProfileSupport,
};
pub use local_transport::{
    InProcessControlClientFixture, InProcessControlHandlerFixture, LocalControlTransport,
    LocalControlTransportBoundary, LocalControlTransportError, LocalControlTransportExchange,
};
pub use management_projection_state::{
    build_management_projection_export_plan, stage_management_projection_import_files,
    write_management_projection_export_files, ManagementProjectionExportFileReport,
    ManagementProjectionExportFileRequest, ManagementProjectionExportFileWrite,
    ManagementProjectionImportStagingReport, ManagementProjectionImportStagingRequest,
    ManagementProjectionStagedFile, ManagementProjectionStagingIssue,
};
pub use process_control_backend::{
    ProcessControlBackendEvidenceRef, ProcessControlBackendKind, ProcessControlBackendReadiness,
};
pub use process_event_transport_backend::{
    ProcessEventTransportBackendKind, ProcessEventTransportEvidenceRef,
    ProcessEventTransportReadiness,
};
pub use process_interruption::ProcessInterruptionHostContract;
pub use process_supervision_events::ProcessSupervisionServerEvent;
pub use process_supervisor::{
    accept_process_supervision_request, ProcessSupervisorAcceptanceDecision,
    ProcessSupervisorAcceptanceRejection, ProcessSupervisorAcceptanceRejectionReason,
    ProcessSupervisorAcceptanceRequest, ProcessSupervisorAcceptedEvents,
};
pub use project_seed::{seed_local_project, LocalProjectSeed};
pub use read_only_command_control::{
    run_read_only_command_control, ReadOnlyCommandControlRejection, ReadOnlyCommandControlResult,
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
pub use runtime_readiness_diagnostics::{
    local_host_runtime_readiness_diagnostics, RuntimeReadinessBlocker, RuntimeReadinessDiagnostics,
    RuntimeReadinessStatus, RuntimeReadinessSurface,
};
pub use runtime_receipt_state::{
    read_runtime_receipts, runtime_receipt_from_read_only_command_result, write_runtime_receipt,
};
pub use sandbox_backend::{SandboxBackendEvidenceRef, SandboxBackendKind, SandboxBackendReadiness};
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
pub use server_read_only_spawn::{
    read_only_spawn_store_error, run_server_read_only_spawn, ServerReadOnlySpawnInput,
    ServerReadOnlySpawnResult,
};
pub use state::{ServerStateDomain, ServerStateDomainService, ServerStateService};
pub use task_seed::{seed_local_task, LocalTaskSeed};
pub use tauri_ipc_command::{
    TauriIpcCommandBoundary, TauriIpcCommandBoundaryError, TauriIpcCommandBoundaryHandler,
    TauriIpcCommandBoundaryPosture, TauriIpcCommandExchange, TauriIpcCommandHandlerFixture,
    TauriIpcControlCommandAdapter,
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
