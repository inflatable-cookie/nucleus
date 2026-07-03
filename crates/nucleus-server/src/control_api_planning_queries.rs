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
