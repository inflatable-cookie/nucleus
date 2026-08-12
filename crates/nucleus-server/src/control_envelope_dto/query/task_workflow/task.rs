//! Task-scoped query builders: timeline, readiness, drilldown, and the
//! selected-task read models.
//!
//! Split from the task_workflow query god file; behavior unchanged.

use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use super::super::super::ControlApiCodecError;
use crate::control_api::{
    SelectedTaskActionReadinessQuery, SelectedTaskOperatorActionGateQuery,
    SelectedTaskReviewNextQuery, SelectedTaskReviewOutcomeRouteQuery, ServerQueryKind,
    TaskReadinessQuery, TaskTimelineQuery, TaskWorkflowDrilldownQuery,
};

pub(crate) fn task_timeline_query_from_action(
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

pub(crate) fn task_readiness_query_from_action(
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

pub(crate) fn task_workflow_drilldown_query_from_action(
    action: &str,
    project_id: String,
    task_id: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "drilldown" if project_id.trim().is_empty() || task_id.trim().is_empty() => {
            Err(ControlApiCodecError::unsupported(
                "task workflow drilldown query requires project and task ids",
            ))
        }
        "drilldown" => Ok(ServerQueryKind::TaskWorkflowDrilldown(
            TaskWorkflowDrilldownQuery {
                project_id: ProjectId(project_id),
                task_id: TaskId(task_id),
            },
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported task workflow drilldown query action: {action}"
        ))),
    }
}

pub(crate) fn selected_task_action_readiness_query_from_action(
    action: &str,
    project_id: String,
    task_id: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "readiness" if project_id.trim().is_empty() || task_id.trim().is_empty() => {
            Err(ControlApiCodecError::unsupported(
                "selected task action readiness query requires project and task ids",
            ))
        }
        "readiness" => Ok(ServerQueryKind::SelectedTaskActionReadiness(
            SelectedTaskActionReadinessQuery {
                project_id: ProjectId(project_id),
                task_id: TaskId(task_id),
            },
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported selected task action readiness query action: {action}"
        ))),
    }
}

pub(crate) fn selected_task_operator_action_gate_query_from_action(
    action: &str,
    project_id: String,
    task_id: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "gate" if project_id.trim().is_empty() || task_id.trim().is_empty() => {
            Err(ControlApiCodecError::unsupported(
                "selected task operator action gate query requires project and task ids",
            ))
        }
        "gate" => Ok(ServerQueryKind::SelectedTaskOperatorActionGate(
            SelectedTaskOperatorActionGateQuery {
                project_id: ProjectId(project_id),
                task_id: TaskId(task_id),
            },
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported selected task operator action gate query action: {action}"
        ))),
    }
}

pub(crate) fn selected_task_review_next_query_from_action(
    action: &str,
    project_id: String,
    task_id: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "review_next" if project_id.trim().is_empty() || task_id.trim().is_empty() => {
            Err(ControlApiCodecError::unsupported(
                "selected task review next query requires project and task ids",
            ))
        }
        "review_next" => Ok(ServerQueryKind::SelectedTaskReviewNext(
            SelectedTaskReviewNextQuery {
                project_id: ProjectId(project_id),
                task_id: TaskId(task_id),
            },
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported selected task review next query action: {action}"
        ))),
    }
}

pub(crate) fn selected_task_review_outcome_route_query_from_action(
    action: &str,
    project_id: String,
    task_id: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "route" if project_id.trim().is_empty() || task_id.trim().is_empty() => {
            Err(ControlApiCodecError::unsupported(
                "selected task review outcome route query requires project and task ids",
            ))
        }
        "route" => Ok(ServerQueryKind::SelectedTaskReviewOutcomeRoute(
            SelectedTaskReviewOutcomeRouteQuery {
                project_id: ProjectId(project_id),
                task_id: TaskId(task_id),
            },
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported selected task review outcome route query action: {action}"
        ))),
    }
}
