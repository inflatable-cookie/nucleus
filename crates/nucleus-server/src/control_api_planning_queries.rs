//! Planning query shapes used by the transport-neutral control API.

use nucleus_projects::ProjectId;

/// Planning task seed candidate query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningTaskSeedsQuery {
    pub project_id: ProjectId,
}

/// Planning session query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningSessionsQuery {
    pub project_id: ProjectId,
}

/// Memory proposal inspection query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryProposalsQuery {
    pub project_id: ProjectId,
}

/// Accepted memory inspection query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryQuery {
    pub project_id: ProjectId,
}

/// Accepted memory projection diagnostics query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionDiagnosticsQuery {
    pub project_id: ProjectId,
}

/// Accepted memory projection write diagnostics query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionWriteDiagnosticsQuery {
    pub project_id: ProjectId,
}

/// Accepted memory projection import diagnostics query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionImportDiagnosticsQuery {
    pub project_id: ProjectId,
}

/// Accepted memory projection import apply/admission diagnostics query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionImportApplyDiagnosticsQuery {
    pub project_id: ProjectId,
}

/// Accepted memory review/product readiness query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryReviewReadinessQuery {
    pub project_id: ProjectId,
}

/// Memory proposal review diagnostics query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryProposalReviewDiagnosticsQuery {
    pub project_id: ProjectId,
}

/// Research run brief inspection query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResearchRunBriefsQuery {
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

/// Planning projection import apply diagnostics query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningProjectionImportApplyDiagnosticsQuery {
    pub project_id: ProjectId,
}

/// Planning projection import active-apply diagnostics query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningProjectionImportActiveApplyDiagnosticsQuery {
    pub project_id: ProjectId,
}

/// Planning capture publication stopped-request diagnostics query shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningCapturePublicationDiagnosticsQuery {
    pub project_id: ProjectId,
}
