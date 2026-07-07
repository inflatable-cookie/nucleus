use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::control_api::{
    MemoryProposalReviewDiagnosticsQuery, MemoryProposalsQuery, PlanningSessionsQuery,
    PlanningTaskSeedsQuery, ResearchRunBriefsQuery, SelectedTaskActionReadinessQuery,
    SelectedTaskCommandAdmissionQuery, SelectedTaskOperatorActionGateQuery, ServerQueryKind,
    TaskReadinessQuery, TaskSeedPromotionDiagnosticsQuery, TaskTimelineQuery,
    TaskWorkflowDrilldownQuery,
};
use crate::SelectedTaskActionFamily;

use super::super::ControlApiCodecError;

mod accepted_memory;
pub(super) use accepted_memory::{
    accepted_memory_active_apply_diagnostics_query_from_action,
    accepted_memory_import_apply_review_diagnostics_query_from_action,
    accepted_memory_projection_diagnostics_query_from_action,
    accepted_memory_projection_import_apply_diagnostics_query_from_action,
    accepted_memory_projection_import_diagnostics_query_from_action,
    accepted_memory_projection_write_diagnostics_query_from_action,
    accepted_memory_query_from_action, accepted_memory_review_readiness_query_from_action,
    accepted_memory_review_receipt_storage_diagnostics_query_from_action,
};

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

pub(super) fn task_workflow_drilldown_query_from_action(
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

pub(super) fn selected_task_action_readiness_query_from_action(
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

pub(super) fn selected_task_operator_action_gate_query_from_action(
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

pub(super) fn selected_task_command_admission_query_from_action(
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

pub(super) fn selected_task_action_family_from_label(
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

pub(super) fn selected_task_action_family_label(family: SelectedTaskActionFamily) -> &'static str {
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

pub(super) fn planning_sessions_query_from_action(
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

pub(super) fn memory_proposals_query_from_action(
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

pub(super) fn memory_proposal_review_diagnostics_query_from_action(
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

pub(super) fn research_run_briefs_query_from_action(
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

pub(super) fn task_seed_promotion_diagnostics_query_from_action(
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
