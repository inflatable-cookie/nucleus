use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::control_api::{
    PlanningTaskSeedsQuery, ServerQueryKind, TaskReadinessQuery, TaskTimelineQuery,
};

use super::super::ControlApiCodecError;

pub(super) fn task_timeline_query_from_action(
    action: &str,
    task_id: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "timeline" if task_id.trim().is_empty() => Err(ControlApiCodecError::unsupported(
            "task timeline query requires a task id",
        )),
        "timeline" => Ok(ServerQueryKind::TaskTimeline(TaskTimelineQuery {
            task_id: TaskId(task_id),
        })),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported task timeline query action: {action}"
        ))),
    }
}

pub(super) fn task_readiness_query_from_action(
    action: &str,
    project_id: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "candidates" if project_id.trim().is_empty() => Err(ControlApiCodecError::unsupported(
            "task readiness query requires a project id",
        )),
        "candidates" => Ok(ServerQueryKind::TaskReadiness(TaskReadinessQuery {
            project_id: ProjectId(project_id),
        })),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported task readiness query action: {action}"
        ))),
    }
}

pub(super) fn planning_task_seeds_query_from_action(
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
