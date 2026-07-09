use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::control_api::{SelectedTaskReworkPreparationQuery, ServerQueryKind};
use crate::control_envelope_dto::ControlApiCodecError;

pub(in crate::control_envelope_dto::query) fn selected_task_rework_preparation_query_from_action(
    action: &str,
    project_id: String,
    task_id: String,
    operator_ref: String,
    route_admission_id: Option<String>,
    review_decision_ref: Option<String>,
    reviewed_work_item_refs: Vec<String>,
    reviewed_evidence_refs: Vec<String>,
    expected_task_revision: Option<String>,
    expected_work_item_revision: Option<String>,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "preview"
            if project_id.trim().is_empty()
                || task_id.trim().is_empty()
                || operator_ref.trim().is_empty() =>
        {
            Err(ControlApiCodecError::unsupported(
                "selected task rework preparation query requires project id, task id, and operator ref",
            ))
        }
        "preview" => Ok(ServerQueryKind::SelectedTaskReworkPreparation(
            SelectedTaskReworkPreparationQuery {
                project_id: ProjectId(project_id),
                task_id: TaskId(task_id),
                operator_ref,
                route_admission_id,
                review_decision_ref,
                reviewed_work_item_refs,
                reviewed_evidence_refs,
                expected_task_revision: expected_task_revision.map(RevisionId),
                expected_work_item_revision: expected_work_item_revision.map(RevisionId),
            },
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported selected task rework preparation query action: {action}"
        ))),
    }
}
