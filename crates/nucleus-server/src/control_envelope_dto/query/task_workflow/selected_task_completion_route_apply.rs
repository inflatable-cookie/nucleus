use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::control_api::{SelectedTaskCompletionRouteApplyQuery, ServerQueryKind};

use super::super::super::ControlApiCodecError;

pub(in crate::control_envelope_dto::query) fn selected_task_completion_route_apply_query_from_action(
    action: &str,
    project_id: String,
    task_id: String,
    expected_revision: Option<String>,
    operator_ref: String,
    route_admission_id: Option<String>,
    review_decision_ref: Option<String>,
    evidence_refs: Vec<String>,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "preview"
            if project_id.trim().is_empty()
                || task_id.trim().is_empty()
                || operator_ref.trim().is_empty() =>
        {
            Err(ControlApiCodecError::unsupported(
                "selected task completion route apply query requires project id, task id, and operator ref",
            ))
        }
        "preview" => Ok(ServerQueryKind::SelectedTaskCompletionRouteApply(
            SelectedTaskCompletionRouteApplyQuery {
                project_id: ProjectId(project_id),
                task_id: TaskId(task_id),
                expected_revision: expected_revision.map(RevisionId),
                operator_ref,
                route_admission_id,
                review_decision_ref,
                evidence_refs,
            },
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported selected task completion route apply query action: {action}"
        ))),
    }
}
