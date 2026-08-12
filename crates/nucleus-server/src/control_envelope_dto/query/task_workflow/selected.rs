//! Selected-task admission query builders and action family labels.
//!
//! Split from the task_workflow query god file; behavior unchanged.

use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use super::super::super::ControlApiCodecError;
use crate::control_api::{
    SelectedTaskCommandAdmissionQuery, SelectedTaskProductAggregateQuery,
    SelectedTaskRouteAdmissionQuery, SelectedTaskScmHandoffQuery, ServerQueryKind,
};
use crate::SelectedTaskActionFamily;

pub(crate) fn selected_task_route_admission_query_from_action(
    action: &str,
    project_id: String,
    task_id: String,
    expected_revision: Option<String>,
    operator_ref: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "admission"
            if project_id.trim().is_empty()
                || task_id.trim().is_empty()
                || operator_ref.trim().is_empty() =>
        {
            Err(ControlApiCodecError::unsupported(
                "selected task route admission query requires project id, task id, and operator ref",
            ))
        }
        "admission" => Ok(ServerQueryKind::SelectedTaskRouteAdmission(
            SelectedTaskRouteAdmissionQuery {
                project_id: ProjectId(project_id),
                task_id: TaskId(task_id),
                expected_revision: expected_revision.map(RevisionId),
                operator_ref,
            },
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported selected task route admission query action: {action}"
        ))),
    }
}

pub(crate) fn selected_task_scm_handoff_query_from_action(
    action: &str,
    project_id: String,
    task_id: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "handoff" if project_id.trim().is_empty() || task_id.trim().is_empty() => {
            Err(ControlApiCodecError::unsupported(
                "selected task SCM handoff query requires project and task ids",
            ))
        }
        "handoff" => Ok(ServerQueryKind::SelectedTaskScmHandoff(
            SelectedTaskScmHandoffQuery {
                project_id: ProjectId(project_id),
                task_id: TaskId(task_id),
            },
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported selected task SCM handoff query action: {action}"
        ))),
    }
}

pub(crate) fn selected_task_product_aggregate_query_from_action(
    action: &str,
    project_id: String,
    task_id: String,
    expected_revision: Option<String>,
    operator_ref: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "aggregate"
            if project_id.trim().is_empty()
                || task_id.trim().is_empty()
                || operator_ref.trim().is_empty() =>
        {
            Err(ControlApiCodecError::unsupported(
                "selected task product aggregate query requires project id, task id, and operator ref",
            ))
        }
        "aggregate" => Ok(ServerQueryKind::SelectedTaskProductAggregate(
            SelectedTaskProductAggregateQuery {
                project_id: ProjectId(project_id),
                task_id: TaskId(task_id),
                expected_revision: expected_revision.map(RevisionId),
                operator_ref,
            },
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported selected task product aggregate query action: {action}"
        ))),
    }
}

pub(crate) fn selected_task_command_admission_query_from_action(
    action: &str,
    project_id: String,
    task_id: String,
    family: String,
    expected_revision: Option<String>,
    reason: Option<String>,
    operator_ref: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "dry_run"
            if project_id.trim().is_empty()
                || task_id.trim().is_empty()
                || family.trim().is_empty()
                || operator_ref.trim().is_empty() =>
        {
            Err(ControlApiCodecError::unsupported(
                "selected task command admission query requires project id, task id, family, and operator ref",
            ))
        }
        "dry_run" => Ok(ServerQueryKind::SelectedTaskCommandAdmission(
            SelectedTaskCommandAdmissionQuery {
                project_id: ProjectId(project_id),
                task_id: TaskId(task_id),
                family: selected_task_action_family_from_label(&family)?,
                expected_revision: expected_revision.map(RevisionId),
                reason,
                operator_ref,
            },
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported selected task command admission query action: {action}"
        ))),
    }
}

pub(crate) fn selected_task_action_family_from_label(
    family: &str,
) -> Result<SelectedTaskActionFamily, ControlApiCodecError> {
    match family {
        "plan_selected_task" => Ok(SelectedTaskActionFamily::PlanSelectedTask),
        "start_selected_task" => Ok(SelectedTaskActionFamily::StartSelectedTask),
        "block_selected_task" => Ok(SelectedTaskActionFamily::BlockSelectedTask),
        "complete_selected_task" => Ok(SelectedTaskActionFamily::CompleteSelectedTask),
        "archive_selected_task" => Ok(SelectedTaskActionFamily::ArchiveSelectedTask),
        "prepare_delegation" => Ok(SelectedTaskActionFamily::PrepareDelegation),
        "inspect_runtime_evidence" => Ok(SelectedTaskActionFamily::InspectRuntimeEvidence),
        "review_work_evidence" => Ok(SelectedTaskActionFamily::ReviewWorkEvidence),
        "prepare_scm_handoff" => Ok(SelectedTaskActionFamily::PrepareScmHandoff),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported selected task action family: {family}"
        ))),
    }
}

pub(crate) fn selected_task_action_family_label(
    family: SelectedTaskActionFamily,
) -> &'static str {
    match family {
        SelectedTaskActionFamily::PlanSelectedTask => "plan_selected_task",
        SelectedTaskActionFamily::StartSelectedTask => "start_selected_task",
        SelectedTaskActionFamily::BlockSelectedTask => "block_selected_task",
        SelectedTaskActionFamily::CompleteSelectedTask => "complete_selected_task",
        SelectedTaskActionFamily::ArchiveSelectedTask => "archive_selected_task",
        SelectedTaskActionFamily::PrepareDelegation => "prepare_delegation",
        SelectedTaskActionFamily::InspectRuntimeEvidence => "inspect_runtime_evidence",
        SelectedTaskActionFamily::ReviewWorkEvidence => "review_work_evidence",
        SelectedTaskActionFamily::PrepareScmHandoff => "prepare_scm_handoff",
    }
}
