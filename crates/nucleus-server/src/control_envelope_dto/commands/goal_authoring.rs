use crate::commands::{
    GoalCommand, GoalCreateCommand, GoalUpdateChanges, GoalUpdateCommand, ServerCommandKind,
};
use crate::ids::ServerCommandId;
use nucleus_core::RevisionId;
use nucleus_planning::{GoalStatus, PlanningGoalId};
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use super::super::ControlApiCodecError;
use super::ControlCommandDto;

pub(super) fn goal_command_dto(
    command_id: &ServerCommandId,
    command: &GoalCommand,
) -> Result<ControlCommandDto, ControlApiCodecError> {
    match command {
        GoalCommand::Create(command) => goal_create_dto(command_id, command),
        GoalCommand::Update(command) => Ok(goal_update_dto(command_id, command)),
    }
}

fn goal_create_dto(
    command_id: &ServerCommandId,
    command: &GoalCreateCommand,
) -> Result<ControlCommandDto, ControlApiCodecError> {
    let status = match command.status {
        GoalStatus::Proposed => "proposed".to_owned(),
        GoalStatus::Ready => "ready".to_owned(),
        _ => {
            return Err(ControlApiCodecError::malformed(
                "goal create command supports only proposed or ready status",
            ))
        }
    };
    Ok(ControlCommandDto::GoalCreate {
        command_id: command_id.0.clone(),
        project_id: command.project_id.0.clone(),
        title: command.title.clone(),
        desired_outcome: command.desired_outcome.clone(),
        scope: command.scope.clone(),
        status,
        owner_refs: command.owner_refs.clone(),
        ordered_task_refs: task_ref_strings(&command.ordered_task_refs),
        planning_artifact_refs: command.planning_artifact_refs.clone(),
        provenance_refs: command.provenance_refs.clone(),
        stop_conditions: command.stop_conditions.clone(),
        evidence_refs: command.evidence_refs.clone(),
        current_next_task_ref: command
            .current_next_task_ref
            .as_ref()
            .map(|task_id| task_id.0.clone()),
        next_action: command.next_action.clone(),
    })
}

fn goal_update_dto(command_id: &ServerCommandId, command: &GoalUpdateCommand) -> ControlCommandDto {
    let (current_next_task_ref, clear_current_next_task_ref) =
        optional_task_ref_dto(&command.changes.current_next_task_ref);
    let (next_action, clear_next_action) = optional_string_dto(&command.changes.next_action);
    ControlCommandDto::GoalUpdate {
        command_id: command_id.0.clone(),
        goal_id: command.goal_id.0.clone(),
        expected_revision: command.expected_revision.0.clone(),
        title: command.changes.title.clone(),
        desired_outcome: command.changes.desired_outcome.clone(),
        scope: command.changes.scope.clone(),
        owner_refs: command.changes.owner_refs.clone(),
        ordered_task_refs: command
            .changes
            .ordered_task_refs
            .as_ref()
            .map(|refs| task_ref_strings(refs)),
        planning_artifact_refs: command.changes.planning_artifact_refs.clone(),
        provenance_refs: command.changes.provenance_refs.clone(),
        stop_conditions: command.changes.stop_conditions.clone(),
        evidence_refs: command.changes.evidence_refs.clone(),
        current_next_task_ref,
        clear_current_next_task_ref,
        next_action,
        clear_next_action,
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn goal_create_kind(
    command_id: String,
    project_id: String,
    title: String,
    desired_outcome: String,
    scope: String,
    status: String,
    owner_refs: Vec<String>,
    ordered_task_refs: Vec<String>,
    planning_artifact_refs: Vec<String>,
    provenance_refs: Vec<String>,
    stop_conditions: Vec<String>,
    evidence_refs: Vec<String>,
    current_next_task_ref: Option<String>,
    next_action: Option<String>,
) -> Result<(ServerCommandId, ServerCommandKind), ControlApiCodecError> {
    Ok((
        ServerCommandId(command_id),
        ServerCommandKind::Goal(GoalCommand::Create(GoalCreateCommand {
            project_id: ProjectId(project_id),
            title,
            desired_outcome,
            scope,
            status: match status.as_str() {
                "proposed" => GoalStatus::Proposed,
                "ready" => GoalStatus::Ready,
                _ => {
                    return Err(ControlApiCodecError::malformed(
                        "goal create command supports only proposed or ready status",
                    ))
                }
            },
            owner_refs,
            ordered_task_refs: task_refs(ordered_task_refs),
            planning_artifact_refs,
            provenance_refs,
            stop_conditions,
            evidence_refs,
            current_next_task_ref: current_next_task_ref.map(TaskId),
            next_action,
        })),
    ))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn goal_update_kind(
    command_id: String,
    goal_id: String,
    expected_revision: String,
    title: Option<String>,
    desired_outcome: Option<String>,
    scope: Option<String>,
    owner_refs: Option<Vec<String>>,
    ordered_task_refs: Option<Vec<String>>,
    planning_artifact_refs: Option<Vec<String>>,
    provenance_refs: Option<Vec<String>>,
    stop_conditions: Option<Vec<String>>,
    evidence_refs: Option<Vec<String>>,
    current_next_task_ref: Option<String>,
    clear_current_next_task_ref: bool,
    next_action: Option<String>,
    clear_next_action: bool,
) -> Result<(ServerCommandId, ServerCommandKind), ControlApiCodecError> {
    Ok((
        ServerCommandId(command_id),
        ServerCommandKind::Goal(GoalCommand::Update(GoalUpdateCommand {
            goal_id: PlanningGoalId(goal_id),
            expected_revision: RevisionId(expected_revision),
            changes: GoalUpdateChanges {
                title,
                desired_outcome,
                scope,
                owner_refs,
                ordered_task_refs: ordered_task_refs.map(task_refs),
                planning_artifact_refs,
                provenance_refs,
                stop_conditions,
                evidence_refs,
                current_next_task_ref: optional_task_ref_kind(
                    current_next_task_ref,
                    clear_current_next_task_ref,
                )?,
                next_action: optional_string_kind(next_action, clear_next_action)?,
            },
        })),
    ))
}

fn task_ref_strings(task_refs: &[TaskId]) -> Vec<String> {
    task_refs.iter().map(|task_id| task_id.0.clone()).collect()
}

fn task_refs(refs: Vec<String>) -> Vec<TaskId> {
    refs.into_iter().map(TaskId).collect()
}

fn optional_task_ref_dto(value: &Option<Option<TaskId>>) -> (Option<String>, bool) {
    match value {
        Some(Some(task_id)) => (Some(task_id.0.clone()), false),
        Some(None) => (None, true),
        None => (None, false),
    }
}

fn optional_string_dto(value: &Option<Option<String>>) -> (Option<String>, bool) {
    match value {
        Some(Some(value)) => (Some(value.clone()), false),
        Some(None) => (None, true),
        None => (None, false),
    }
}

fn optional_task_ref_kind(
    value: Option<String>,
    clear: bool,
) -> Result<Option<Option<TaskId>>, ControlApiCodecError> {
    optional_string_kind(value, clear).map(|value| value.map(|value| value.map(TaskId)))
}

fn optional_string_kind(
    value: Option<String>,
    clear: bool,
) -> Result<Option<Option<String>>, ControlApiCodecError> {
    match (value, clear) {
        (Some(_), true) => Err(ControlApiCodecError::malformed(
            "goal update cannot set and clear the same optional field",
        )),
        (Some(value), false) => Ok(Some(Some(value))),
        (None, true) => Ok(Some(None)),
        (None, false) => Ok(None),
    }
}
