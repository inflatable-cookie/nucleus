use nucleus_agent_protocol::{AdapterIdentity, AgentSessionId};
use nucleus_core::PersistenceRecordId;
use nucleus_projects::{ProjectId, RepoMembershipId};
use nucleus_tasks::TaskId;
use nucleus_workspaces::WorkspaceLayoutId;

use crate::host_authority::ProjectAuthorityDomain;
use crate::runtime_effect_storage::{
    RuntimeEffectStorageQuery, RuntimeEffectStorageRecordId, RuntimeEffectStorageRef,
};
use crate::state::ServerStateDomain;

use super::{
    AcceptedMemoryProjectionDiagnosticsQuery, AcceptedMemoryProjectionImportApplyDiagnosticsQuery,
    AcceptedMemoryProjectionImportDiagnosticsQuery, AcceptedMemoryProjectionWriteDiagnosticsQuery,
    AcceptedMemoryQuery, AcceptedMemoryReviewReadinessQuery, MemoryProposalReviewDiagnosticsQuery,
    MemoryProposalsQuery, PlanningCapturePublicationDiagnosticsQuery,
    PlanningProjectionFileWriteDiagnosticsQuery,
    PlanningProjectionImportActiveApplyDiagnosticsQuery,
    PlanningProjectionImportApplyDiagnosticsQuery, PlanningProjectionImportDiagnosticsQuery,
    PlanningSessionsQuery, PlanningTaskSeedsQuery, ResearchRunBriefsQuery,
    TaskSeedPromotionDiagnosticsQuery,
};

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
    PlanningSessions(PlanningSessionsQuery),
    AcceptedMemory(AcceptedMemoryQuery),
    AcceptedMemoryProjectionDiagnostics(AcceptedMemoryProjectionDiagnosticsQuery),
    AcceptedMemoryProjectionWriteDiagnostics(AcceptedMemoryProjectionWriteDiagnosticsQuery),
    AcceptedMemoryProjectionImportDiagnostics(AcceptedMemoryProjectionImportDiagnosticsQuery),
    AcceptedMemoryProjectionImportApplyDiagnostics(
        AcceptedMemoryProjectionImportApplyDiagnosticsQuery,
    ),
    AcceptedMemoryReviewReadiness(AcceptedMemoryReviewReadinessQuery),
    MemoryProposals(MemoryProposalsQuery),
    MemoryProposalReviewDiagnostics(MemoryProposalReviewDiagnosticsQuery),
    ResearchRunBriefs(ResearchRunBriefsQuery),
    TaskSeedPromotionDiagnostics(TaskSeedPromotionDiagnosticsQuery),
    PlanningProjectionFileWriteDiagnostics(PlanningProjectionFileWriteDiagnosticsQuery),
    PlanningProjectionImportDiagnostics(PlanningProjectionImportDiagnosticsQuery),
    PlanningProjectionImportApplyDiagnostics(PlanningProjectionImportApplyDiagnosticsQuery),
    PlanningProjectionImportActiveApplyDiagnostics(
        PlanningProjectionImportActiveApplyDiagnosticsQuery,
    ),
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

/// Project authority-map query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectAuthorityMapQuery {
    pub project_id: ProjectId,
    pub expected_domains: Vec<ProjectAuthorityDomain>,
}
