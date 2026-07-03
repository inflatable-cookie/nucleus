//! Transport-neutral server control API vocabulary.
//!
//! These types describe command/query envelopes and responses. They do not
//! implement HTTP, WebSocket, Tauri IPC, auth middleware, scheduling, command
//! execution, storage replay, or provider runtime behavior.

use nucleus_agent_protocol::{AdapterIdentity, AgentSessionId};
use nucleus_core::PersistenceRecordId;
use nucleus_engine::{
    EngineCheckpointRecord, EngineDiffSummaryRecord, EngineRuntimeReceiptRecord,
    EngineTaskReadinessProjection, EngineTaskSeedCandidateProjection, EngineTaskTimelineProjection,
};
use nucleus_local_store::LocalStoreRecord;
use nucleus_projects::{ProjectId, RepoMembershipId};
use nucleus_tasks::TaskId;
use nucleus_workspaces::WorkspaceLayoutId;

use crate::client_protocol::ProjectAuthorityMapPublicationRecord;
use crate::commands::ServerCommand;
use crate::diagnostics_read_models::{
    CodexProviderDiagnosticsDto, EffigyDiagnosticsDto, ScmSessionDiagnosticsDto,
    StewardDiagnosticsDto, SyncDiagnosticsDto, TaskAgentDiagnosticsDto,
    TaskAgentWorkUnitDiagnosticDto,
};
use crate::host_authority::ProjectAuthorityDomain;
use crate::ids::{ClientId, ServerCommandId, ServerControlRequestId, ServerQueryId};
use crate::read_only_command_control::ReadOnlyCommandControlResult;
use crate::runtime_effect_storage::{
    RuntimeEffectStorageQuery, RuntimeEffectStorageRecordId, RuntimeEffectStorageRef,
};
use crate::runtime_readiness_diagnostics::RuntimeReadinessDiagnostics;
use crate::state::ServerStateDomain;

/// Request sent to the server control boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerControlRequest {
    pub id: ServerControlRequestId,
    pub client_id: ClientId,
    pub kind: ServerControlRequestKind,
}

/// Top-level control request category.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ServerControlRequestKind {
    Command(ServerCommand),
    Query(ServerQuery),
}

/// Query sent to the server control boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerQuery {
    pub id: ServerQueryId,
    pub client_id: ClientId,
    pub kind: ServerQueryKind,
}

/// Top-level query categories.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ServerQueryKind {
    Project(StateRecordQuery),
    Task(StateRecordQuery),
    Workspace(StateRecordQuery),
    AdapterSession(AdapterSessionQuery),
    ModelRoute(ModelRouteQuery),
    RuntimeMetadata(RuntimeMetadataQuery),
    Diagnostics(DiagnosticsQuery),
    ProviderReadIntent(ProviderReadIntentQuery),
    ProviderReadinessOverview(ProviderReadinessOverviewQuery),
    ProviderLiveReadExecutor(ProviderLiveReadExecutorQuery),
    ProviderLiveReadSmokeEvidence(ProviderLiveReadSmokeEvidenceQuery),
    TaskTimeline(TaskTimelineQuery),
    TaskReadiness(TaskReadinessQuery),
    PlanningTaskSeeds(PlanningTaskSeedsQuery),
    TaskSeedPromotionDiagnostics(TaskSeedPromotionDiagnosticsQuery),
    PlanningProjectionFileWriteDiagnostics(PlanningProjectionFileWriteDiagnosticsQuery),
    PlanningProjectionImportDiagnostics(PlanningProjectionImportDiagnosticsQuery),
    PlanningCapturePublicationDiagnostics(PlanningCapturePublicationDiagnosticsQuery),
    ProjectAuthorityMap(ProjectAuthorityMapQuery),
}

/// Generic persisted-state query scoped to one state domain.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StateRecordQuery {
    pub domain: ServerStateDomain,
    pub scope: StateRecordQueryScope,
}

/// Record query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StateRecordQueryScope {
    Get(PersistenceRecordId),
    List,
    ListByProject(ProjectId),
    ListByTask(TaskId),
    ListByWorkspace(WorkspaceLayoutId),
    ListByRepo(RepoMembershipId),
}

/// Adapter registry and session query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterSessionQuery {
    ListAdapters,
    GetAdapter(AdapterIdentity),
    ListSessions,
    GetSession(AgentSessionId),
    ListSessionsForProject(ProjectId),
}

/// Model route query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ModelRouteQuery {
    ListRoutes,
    GetRoute(String),
    ResolveRouteForProject(ProjectId),
    ResolveRouteForTask(TaskId),
}

/// Runtime metadata query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeMetadataQuery {
    StoredEffects(RuntimeEffectStorageQuery),
    GetStoredEffect(RuntimeEffectStorageRecordId),
    ResolveRuntimeRef(RuntimeEffectStorageRef),
    ListCommandEvidence,
    ListRuntimeReceipts,
    ListCheckpointRecords,
    ListDiffSummaryRecords,
    ListTaskWorkProgress,
    ListArtifactMetadata,
    GetLocalRuntimeReadiness,
}

/// Client-safe diagnostics query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DiagnosticsQuery {
    Steward,
    Effigy,
    ManagementSync,
    ScmSession,
    TaskAgent,
    CodexProvider,
    LiveEvidenceCompletion,
    CompletionScmReadiness,
    CompletionScmCapture,
    CompletionScmCapturePreparation,
    ScmCaptureDryRun,
    ScmCaptureDryRunExecution,
    GitDryRunExecution,
    ScmCaptureWorkflow,
    ScmCaptureReview,
    ScmCaptureReviewDecision,
    ScmChangeRequestPreparation,
    All,
}

/// Provider read-intent query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderReadIntentQuery {
    Projection,
}

/// Provider readiness overview query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderReadinessOverviewQuery {
    Overview,
}

/// Provider live-read executor query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderLiveReadExecutorQuery {
    Diagnostics,
}

/// Provider live-read smoke evidence query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderLiveReadSmokeEvidenceQuery {
    Diagnostics,
}

/// Task timeline query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskTimelineQuery {
    pub task_id: TaskId,
}

/// Task readiness query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskReadinessQuery {
    pub project_id: ProjectId,
}

/// Planning task seed candidate query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningTaskSeedsQuery {
    pub project_id: ProjectId,
}

/// Planning task seed promotion diagnostics query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskSeedPromotionDiagnosticsQuery {
    pub project_id: ProjectId,
}

/// Planning projection file-write diagnostics query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningProjectionFileWriteDiagnosticsQuery {
    pub project_id: ProjectId,
}

/// Planning projection import diagnostics query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningProjectionImportDiagnosticsQuery {
    pub project_id: ProjectId,
}

/// Planning capture publication stopped-request diagnostics query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningCapturePublicationDiagnosticsQuery {
    pub project_id: ProjectId,
}

/// Project authority-map query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectAuthorityMapQuery {
    pub project_id: ProjectId,
    pub expected_domains: Vec<ProjectAuthorityDomain>,
}

/// Response emitted by the server control boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerControlResponse {
    pub request_id: ServerControlRequestId,
    pub status: ServerControlResponseStatus,
    pub body: ServerControlResponseBody,
}

/// Transport-neutral response status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ServerControlResponseStatus {
    Accepted,
    Complete,
    Rejected,
    Partial,
}

/// Response body category.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ServerControlResponseBody {
    Command(ServerCommandReceipt),
    ReadOnlyCommand(ReadOnlyCommandControlResult),
    Query(ServerQueryResult),
    Error(ServerControlError),
}

/// Command receipt. A receipt is not proof of execution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerCommandReceipt {
    pub command_id: ServerCommandId,
    pub status: ServerCommandReceiptStatus,
}

/// Server command acceptance posture.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ServerCommandReceiptStatus {
    AcceptedForStateMutation,
    AcceptedForRuntimeScheduling,
    AcceptedForNativeStewardCommand,
    WaitingForApproval,
    Rejected(ServerControlError),
}

/// Query result shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ServerQueryResult {
    StateRecords(ServerStateRecordSet),
    AdapterSessions(ServerStateRecordSet),
    ModelRoutes(ServerStateRecordSet),
    RuntimeMetadata(ServerStateRecordSet),
    RuntimeReadiness(Vec<RuntimeReadinessDiagnostics>),
    RuntimeReceipts(Vec<EngineRuntimeReceiptRecord>),
    CheckpointRecords(Vec<EngineCheckpointRecord>),
    DiffSummaryRecords(Vec<EngineDiffSummaryRecord>),
    TaskWorkProgress(Vec<TaskAgentWorkUnitDiagnosticDto>),
    Diagnostics(ServerDiagnosticsQueryResult),
    ProviderReadIntent(crate::ForgeReadIntentQueryResult),
    ProviderReadinessOverview(crate::ForgeReadinessOverview),
    ProviderLiveReadExecutorDiagnostics(crate::ProviderLiveReadServerExecutorDiagnostics),
    ProviderLiveReadSmokeEvidenceDiagnostics(
        crate::ProviderLiveReadApprovedSmokeEvidenceDiagnostics,
    ),
    TaskTimeline(EngineTaskTimelineProjection),
    TaskReadiness(EngineTaskReadinessProjection),
    PlanningTaskSeeds(EngineTaskSeedCandidateProjection),
    TaskSeedPromotionDiagnostics(crate::PlanningTaskSeedPromotionDiagnostics),
    PlanningProjectionFileWriteDiagnostics(crate::PlanningProjectionFileWriteDiagnostics),
    PlanningProjectionImportDiagnostics(crate::PlanningProjectionImportDiagnostics),
    PlanningCapturePublicationDiagnostics(
        crate::PlanningCapturePublicationStoppedRequestDiagnostics,
    ),
    ProjectAuthorityMap(ProjectAuthorityMapPublicationRecord),
    Empty,
    Unsupported {
        reason: String,
    },
}

/// Diagnostics query result shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ServerDiagnosticsQueryResult {
    Steward(StewardDiagnosticsDto),
    Effigy(EffigyDiagnosticsDto),
    ManagementSync(SyncDiagnosticsDto),
    ScmSession(ScmSessionDiagnosticsDto),
    TaskAgent(TaskAgentDiagnosticsDto),
    CodexProvider(CodexProviderDiagnosticsDto),
    LiveEvidenceCompletion(crate::LiveEvidenceCompletionControlDto),
    CompletionScmReadiness(crate::CompletionScmControlDto),
    CompletionScmCapture(crate::CompletionScmCaptureControlDto),
    CompletionScmCapturePreparation(crate::CompletionScmCapturePreparationControlDto),
    ScmCaptureDryRun(crate::ScmCaptureDryRunControlDto),
    ScmCaptureDryRunExecution(crate::ScmCaptureDryRunExecutionControlDto),
    GitDryRunExecution(crate::GitDryRunExecutionControlDto),
    ScmCaptureWorkflow(crate::ScmCaptureWorkflowControlDto),
    ScmCaptureReview(crate::ScmCaptureReviewControlDto),
    ScmCaptureReviewDecision(crate::ScmCaptureReviewDecisionControlDto),
    ScmChangeRequestPreparation(crate::ScmChangeRequestPrepControlDto),
    All(ServerDiagnosticsSnapshot),
}

/// Combined diagnostics snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerDiagnosticsSnapshot {
    pub steward: StewardDiagnosticsDto,
    pub effigy: EffigyDiagnosticsDto,
    pub management_sync: SyncDiagnosticsDto,
    pub scm_session: ScmSessionDiagnosticsDto,
    pub task_agent: TaskAgentDiagnosticsDto,
    pub codex_provider: CodexProviderDiagnosticsDto,
    pub live_evidence_completion: crate::LiveEvidenceCompletionControlDto,
    pub completion_scm_readiness: crate::CompletionScmControlDto,
    pub completion_scm_capture: crate::CompletionScmCaptureControlDto,
    pub completion_scm_capture_preparation: crate::CompletionScmCapturePreparationControlDto,
    pub scm_capture_dry_run: crate::ScmCaptureDryRunControlDto,
    pub scm_capture_dry_run_execution: crate::ScmCaptureDryRunExecutionControlDto,
    pub git_dry_run_execution: crate::GitDryRunExecutionControlDto,
    pub scm_capture_workflow: crate::ScmCaptureWorkflowControlDto,
    pub scm_capture_review: crate::ScmCaptureReviewControlDto,
    pub scm_capture_review_decision: crate::ScmCaptureReviewDecisionControlDto,
    pub scm_change_request_preparation: crate::ScmChangeRequestPrepControlDto,
}

/// State records returned from the local state facade.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerStateRecordSet {
    pub domain: ServerStateDomain,
    pub records: Vec<LocalStoreRecord>,
}

/// Server control boundary error vocabulary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ServerControlError {
    Unauthorized { reason: String },
    Unsupported { reason: String },
    InvalidRequest { reason: String },
    NotFound { reason: String },
    Conflict { reason: String },
    StorageUnavailable { reason: String },
    RuntimeUnavailable { reason: String },
    Deferred { reason: String },
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_core::{PersistenceDomain, PersistenceRecordKind};
    use nucleus_local_store::fixture_record;

    #[test]
    fn control_request_can_wrap_command_without_transport() {
        let command_id = ServerCommandId("command:1".to_owned());
        let request = ServerControlRequest {
            id: ServerControlRequestId("request:1".to_owned()),
            client_id: ClientId("client:1".to_owned()),
            kind: ServerControlRequestKind::Command(ServerCommand {
                id: command_id.clone(),
                client_id: ClientId("client:1".to_owned()),
                kind: crate::commands::ServerCommandKind::Task(
                    crate::commands::TaskCommand::Start(crate::commands::TaskTransitionCommand {
                        task_id: TaskId("task:1".to_owned()),
                        expected_revision: None,
                    }),
                ),
            }),
        };
        let response = ServerControlResponse {
            request_id: request.id.clone(),
            status: ServerControlResponseStatus::Accepted,
            body: ServerControlResponseBody::Command(ServerCommandReceipt {
                command_id,
                status: ServerCommandReceiptStatus::AcceptedForStateMutation,
            }),
        };

        assert!(matches!(request.kind, ServerControlRequestKind::Command(_)));
        assert!(matches!(
            response.body,
            ServerControlResponseBody::Command(_)
        ));
    }

    #[test]
    fn project_query_result_uses_server_state_record_set() {
        let query = ServerQuery {
            id: ServerQueryId("query:1".to_owned()),
            client_id: ClientId("client:1".to_owned()),
            kind: ServerQueryKind::Project(StateRecordQuery {
                domain: ServerStateDomain::Projects,
                scope: StateRecordQueryScope::List,
            }),
        };
        let record = fixture_record(
            PersistenceDomain::Projects,
            PersistenceRecordKind::Project,
            "project:1",
            "rev:1",
        );
        let result = ServerQueryResult::StateRecords(ServerStateRecordSet {
            domain: ServerStateDomain::Projects,
            records: vec![record],
        });

        assert!(matches!(query.kind, ServerQueryKind::Project(_)));
        assert!(matches!(result, ServerQueryResult::StateRecords(_)));
    }

    #[test]
    fn errors_distinguish_auth_storage_runtime_and_deferred_work() {
        let errors = [
            ServerControlError::Unauthorized {
                reason: "client not paired".to_owned(),
            },
            ServerControlError::StorageUnavailable {
                reason: "local database unavailable".to_owned(),
            },
            ServerControlError::RuntimeUnavailable {
                reason: "scheduler not started".to_owned(),
            },
            ServerControlError::Deferred {
                reason: "remote pairing not implemented".to_owned(),
            },
        ];

        assert_eq!(errors.len(), 4);
        assert!(matches!(errors[0], ServerControlError::Unauthorized { .. }));
        assert!(matches!(
            errors[1],
            ServerControlError::StorageUnavailable { .. }
        ));
        assert!(matches!(
            errors[2],
            ServerControlError::RuntimeUnavailable { .. }
        ));
        assert!(matches!(errors[3], ServerControlError::Deferred { .. }));
    }

    #[test]
    fn diagnostics_query_is_read_only_control_vocabulary() {
        let query = ServerQuery {
            id: ServerQueryId("query:diagnostics".to_owned()),
            client_id: ClientId("client:1".to_owned()),
            kind: ServerQueryKind::Diagnostics(DiagnosticsQuery::All),
        };

        assert!(matches!(
            query.kind,
            ServerQueryKind::Diagnostics(DiagnosticsQuery::All)
        ));
    }
}
