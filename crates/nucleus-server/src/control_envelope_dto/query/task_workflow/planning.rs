//! Planning, memory, research, and task-seed query builders.
//!
//! Split from the task_workflow query god file; behavior unchanged.

use nucleus_projects::ProjectId;

use super::super::super::ControlApiCodecError;
use crate::control_api::{
    MemoryProposalReviewDiagnosticsQuery, MemoryProposalsQuery, PlanningSessionsQuery,
    PlanningTaskSeedsQuery, ResearchRunBriefsQuery, ServerQueryKind,
    TaskSeedPromotionDiagnosticsQuery,
};

pub(crate) fn planning_task_seeds_query_from_action(
    action: &str,
    project_id: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "candidates" if project_id.trim().is_empty() => Err(ControlApiCodecError::unsupported(
            "planning task seed query requires a project id",
        )),
        "candidates" => Ok(ServerQueryKind::PlanningTaskSeeds(PlanningTaskSeedsQuery {
            project_id: ProjectId(project_id),
        })),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported planning task seed query action: {action}"
        ))),
    }
}

pub(crate) fn planning_sessions_query_from_action(
    action: &str,
    project_id: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "sessions" if project_id.trim().is_empty() => Err(ControlApiCodecError::unsupported(
            "planning sessions query requires a project id",
        )),
        "sessions" => Ok(ServerQueryKind::PlanningSessions(PlanningSessionsQuery {
            project_id: ProjectId(project_id),
        })),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported planning sessions query action: {action}"
        ))),
    }
}

pub(crate) fn memory_proposals_query_from_action(
    action: &str,
    project_id: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "diagnostics" | "proposals" => Ok(ServerQueryKind::MemoryProposals(MemoryProposalsQuery {
            project_id: ProjectId(project_id),
        })),
        _ => Err(ControlApiCodecError::unsupported(
            "memory proposals query action is not supported",
        )),
    }
}

pub(crate) fn memory_proposal_review_diagnostics_query_from_action(
    action: &str,
    project_id: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "diagnostics" if project_id.trim().is_empty() => Err(ControlApiCodecError::unsupported(
            "memory proposal review diagnostics query requires a project id",
        )),
        "diagnostics" => Ok(ServerQueryKind::MemoryProposalReviewDiagnostics(
            MemoryProposalReviewDiagnosticsQuery {
                project_id: ProjectId(project_id),
            },
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported memory proposal review diagnostics query action: {action}"
        ))),
    }
}

pub(crate) fn research_run_briefs_query_from_action(
    action: &str,
    project_id: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "diagnostics" | "runs" => Ok(ServerQueryKind::ResearchRunBriefs(ResearchRunBriefsQuery {
            project_id: ProjectId(project_id),
        })),
        _ => Err(ControlApiCodecError::unsupported(
            "research run brief query action is not supported",
        )),
    }
}

pub(crate) fn task_seed_promotion_diagnostics_query_from_action(
    action: &str,
    project_id: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "diagnostics" if project_id.trim().is_empty() => Err(ControlApiCodecError::unsupported(
            "task seed promotion diagnostics query requires a project id",
        )),
        "diagnostics" => Ok(ServerQueryKind::TaskSeedPromotionDiagnostics(
            TaskSeedPromotionDiagnosticsQuery {
                project_id: ProjectId(project_id),
            },
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported task seed promotion diagnostics query action: {action}"
        ))),
    }
}
