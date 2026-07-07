use nucleus_agent_protocol::{AdapterIdentity, AgentSessionId};
use nucleus_core::{PersistenceRecordId, RevisionId};
use nucleus_projects::{ProjectId, RepoMembershipId};
use nucleus_tasks::TaskId;
use nucleus_workspaces::WorkspaceLayoutId;

use crate::host_authority::ProjectAuthorityDomain;
use crate::runtime_effect_storage::{
    RuntimeEffectStorageQuery, RuntimeEffectStorageRecordId, RuntimeEffectStorageRef,
};
use crate::state::ServerStateDomain;
use crate::{SelectedTaskActionFamily, SelectedTaskReviewDecisionAction};

use super::{
    AcceptedMemoryActiveApplyDiagnosticsQuery, AcceptedMemoryImportApplyReviewDiagnosticsQuery,
    AcceptedMemoryProjectionDiagnosticsQuery, AcceptedMemoryProjectionImportApplyDiagnosticsQuery,
    AcceptedMemoryProjectionImportDiagnosticsQuery, AcceptedMemoryProjectionWriteDiagnosticsQuery,
    AcceptedMemoryQuery, AcceptedMemoryReviewReadinessQuery,
    AcceptedMemoryReviewReceiptStorageDiagnosticsQuery, MemoryProposalReviewDiagnosticsQuery,
    MemoryProposalsQuery, PlanningCapturePublicationDiagnosticsQuery,
    PlanningProjectionFileWriteDiagnosticsQuery,
    PlanningProjectionImportActiveApplyDiagnosticsQuery,
    PlanningProjectionImportApplyDiagnosticsQuery, PlanningProjectionImportDiagnosticsQuery,
    PlanningSessionsQuery, PlanningTaskSeedsQuery, ProductWorkflowSummaryQuery,
    ResearchRunBriefsQuery, TaskSeedPromotionDiagnosticsQuery,
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
    AcceptedMemoryImportApplyReviewDiagnostics(AcceptedMemoryImportApplyReviewDiagnosticsQuery),
    AcceptedMemoryReviewReceiptStorageDiagnostics(
        AcceptedMemoryReviewReceiptStorageDiagnosticsQuery,
    ),
    AcceptedMemoryActiveApplyDiagnostics(AcceptedMemoryActiveApplyDiagnosticsQuery),
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
    ProductWorkflowSummary(ProductWorkflowSummaryQuery),
    TaskWorkflowDrilldown(TaskWorkflowDrilldownQuery),
    SelectedTaskActionReadiness(SelectedTaskActionReadinessQuery),
    SelectedTaskOperatorActionGate(SelectedTaskOperatorActionGateQuery),
    SelectedTaskReviewNext(SelectedTaskReviewNextQuery),
    SelectedTaskScmHandoff(SelectedTaskScmHandoffQuery),
    SelectedTaskCommandAdmission(SelectedTaskCommandAdmissionQuery),
    SelectedTaskReviewDecisionAdmission(SelectedTaskReviewDecisionAdmissionQuery),
    SelectedTaskReviewDecisionApply(SelectedTaskReviewDecisionApplyQuery),
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

/// Selected task workflow drilldown query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskWorkflowDrilldownQuery {
    pub project_id: ProjectId,
    pub task_id: TaskId,
}

/// Selected task action readiness query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskActionReadinessQuery {
    pub project_id: ProjectId,
    pub task_id: TaskId,
}

/// Selected task operator action gate query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskOperatorActionGateQuery {
    pub project_id: ProjectId,
    pub task_id: TaskId,
}

/// Selected task review and next-step presentation query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskReviewNextQuery {
    pub project_id: ProjectId,
    pub task_id: TaskId,
}

/// Selected task SCM handoff readiness query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskScmHandoffQuery {
    pub project_id: ProjectId,
    pub task_id: TaskId,
}

/// Selected task command admission dry-run query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskCommandAdmissionQuery {
    pub project_id: ProjectId,
    pub task_id: TaskId,
    pub family: SelectedTaskActionFamily,
    pub expected_revision: Option<RevisionId>,
    pub reason: Option<String>,
    pub operator_ref: String,
}

/// Selected task review-decision dry-run query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskReviewDecisionAdmissionQuery {
    pub project_id: ProjectId,
    pub task_id: TaskId,
    pub action: SelectedTaskReviewDecisionAction,
    pub expected_revision: Option<RevisionId>,
    pub current_revision: Option<RevisionId>,
    pub reason: Option<String>,
    pub operator_ref: String,
    pub reviewed_evidence_refs: Vec<String>,
    pub idempotency_key: String,
}

/// Selected task review-decision explicit apply query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskReviewDecisionApplyQuery {
    pub project_id: ProjectId,
    pub task_id: TaskId,
    pub action: SelectedTaskReviewDecisionAction,
    pub expected_revision: Option<RevisionId>,
    pub current_revision: Option<RevisionId>,
    pub reason: Option<String>,
    pub operator_ref: String,
    pub reviewed_evidence_refs: Vec<String>,
    pub idempotency_key: String,
}

/// Project authority-map query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectAuthorityMapQuery {
    pub project_id: ProjectId,
    pub expected_domains: Vec<ProjectAuthorityDomain>,
}
