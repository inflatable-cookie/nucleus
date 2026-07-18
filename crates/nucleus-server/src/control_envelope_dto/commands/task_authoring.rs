use serde::{Deserialize, Serialize};

use crate::commands::{
    ServerCommandKind, TaskCommand, TaskCreateCommand, TaskUpdateChanges, TaskUpdateCommand,
};
use crate::ids::ServerCommandId;
use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;
use nucleus_tasks::{
    AcceptanceCriterion, AgentReadiness, TaskActionType, TaskActivityState, TaskId, TaskImportance,
};

use super::super::ControlApiCodecError;
use super::ControlCommandDto;

/// Serializable task acceptance criterion for authoring commands.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlTaskAcceptanceCriterionDto {
    pub text: String,
    pub required: bool,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn task_create_kind(
    command_id: String,
    project_id: String,
    title: String,
    description: Option<String>,
    acceptance_criteria: Vec<ControlTaskAcceptanceCriterionDto>,
    importance: String,
    action_type: String,
    activity: Option<String>,
    agent_ready: bool,
    required_context_refs: Vec<String>,
    allowed_actions: Vec<String>,
    stop_conditions: Vec<String>,
    validation_commands: Vec<String>,
) -> Result<(ServerCommandId, ServerCommandKind), ControlApiCodecError> {
    let command_id = ServerCommandId(command_id);
    let action_type = parse_action_type(&action_type)?;
    let activity = match activity {
        Some(activity) => parse_activity(&activity)?,
        None => TaskActivityState::Proposed,
    };
    let allowed_actions = if allowed_actions.is_empty() {
        vec![action_type.clone()]
    } else {
        parse_action_types(allowed_actions)?
    };

    Ok((
        command_id,
        ServerCommandKind::Task(TaskCommand::Create(TaskCreateCommand {
            project_id: ProjectId(project_id),
            title,
            description,
            acceptance_criteria: acceptance_criteria
                .into_iter()
                .map(acceptance_criterion)
                .collect(),
            importance: parse_importance(&importance)?,
            action_type,
            activity,
            agent_readiness: AgentReadiness {
                ready_for_agent: agent_ready,
                required_context_refs,
                allowed_actions,
                stop_conditions,
                validation_commands,
            },
        })),
    ))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn task_update_kind(
    command_id: String,
    task_id: String,
    expected_revision: Option<String>,
    title: Option<String>,
    description: Option<Option<String>>,
    acceptance_criteria: Option<Vec<ControlTaskAcceptanceCriterionDto>>,
    importance: Option<String>,
    action_type: Option<String>,
    activity: Option<String>,
    agent_ready: Option<bool>,
    required_context_refs: Option<Vec<String>>,
    allowed_actions: Option<Vec<String>>,
    stop_conditions: Option<Vec<String>>,
    validation_commands: Option<Vec<String>>,
) -> Result<(ServerCommandId, ServerCommandKind), ControlApiCodecError> {
    let action_type = optional_parse(action_type, parse_action_type)?;
    let allowed_actions = optional_parse_vec(allowed_actions, parse_action_type)?;
    let has_readiness_change = agent_ready.is_some()
        || required_context_refs.is_some()
        || allowed_actions.is_some()
        || stop_conditions.is_some()
        || validation_commands.is_some();
    let agent_readiness = has_readiness_change.then(|| AgentReadiness {
        ready_for_agent: agent_ready.unwrap_or(false),
        required_context_refs: required_context_refs.unwrap_or_default(),
        allowed_actions: allowed_actions.unwrap_or_default(),
        stop_conditions: stop_conditions.unwrap_or_default(),
        validation_commands: validation_commands.unwrap_or_default(),
    });

    Ok((
        ServerCommandId(command_id),
        ServerCommandKind::Task(TaskCommand::Update(TaskUpdateCommand {
            task_id: TaskId(task_id),
            expected_revision: expected_revision.map(RevisionId),
            changes: TaskUpdateChanges {
                title,
                description,
                acceptance_criteria: acceptance_criteria
                    .map(|criteria| criteria.into_iter().map(acceptance_criterion).collect()),
                importance: optional_parse(importance, parse_importance)?,
                action_type,
                activity: optional_parse(activity, parse_activity)?,
                agent_readiness,
            },
        })),
    ))
}

pub(super) fn task_create_dto(
    command_id: &ServerCommandId,
    command: &TaskCreateCommand,
) -> ControlCommandDto {
    ControlCommandDto::TaskCreate {
        command_id: command_id.0.clone(),
        project_id: command.project_id.0.clone(),
        title: command.title.clone(),
        description: command.description.clone(),
        acceptance_criteria: command
            .acceptance_criteria
            .iter()
            .map(ControlTaskAcceptanceCriterionDto::from)
            .collect(),
        importance: importance_dto(&command.importance),
        action_type: action_type_dto(&command.action_type),
        activity: Some(activity_dto(&command.activity)),
        agent_ready: command.agent_readiness.ready_for_agent,
        required_context_refs: command.agent_readiness.required_context_refs.clone(),
        allowed_actions: command
            .agent_readiness
            .allowed_actions
            .iter()
            .map(action_type_dto)
            .collect(),
        stop_conditions: command.agent_readiness.stop_conditions.clone(),
        validation_commands: command.agent_readiness.validation_commands.clone(),
    }
}

pub(super) fn task_update_dto(
    command_id: &ServerCommandId,
    command: &TaskUpdateCommand,
) -> ControlCommandDto {
    ControlCommandDto::TaskUpdate {
        command_id: command_id.0.clone(),
        task_id: command.task_id.0.clone(),
        expected_revision: command
            .expected_revision
            .as_ref()
            .map(|revision| revision.0.clone()),
        title: command.changes.title.clone(),
        description: command.changes.description.clone(),
        acceptance_criteria: command
            .changes
            .acceptance_criteria
            .as_ref()
            .map(|criteria| {
                criteria
                    .iter()
                    .map(ControlTaskAcceptanceCriterionDto::from)
                    .collect()
            }),
        importance: command.changes.importance.as_ref().map(importance_dto),
        action_type: command.changes.action_type.as_ref().map(action_type_dto),
        activity: command.changes.activity.as_ref().map(activity_dto),
        agent_ready: command
            .changes
            .agent_readiness
            .as_ref()
            .map(|readiness| readiness.ready_for_agent),
        required_context_refs: command
            .changes
            .agent_readiness
            .as_ref()
            .map(|readiness| readiness.required_context_refs.clone()),
        allowed_actions: command.changes.agent_readiness.as_ref().map(|readiness| {
            readiness
                .allowed_actions
                .iter()
                .map(action_type_dto)
                .collect()
        }),
        stop_conditions: command
            .changes
            .agent_readiness
            .as_ref()
            .map(|readiness| readiness.stop_conditions.clone()),
        validation_commands: command
            .changes
            .agent_readiness
            .as_ref()
            .map(|readiness| readiness.validation_commands.clone()),
    }
}

impl From<&AcceptanceCriterion> for ControlTaskAcceptanceCriterionDto {
    fn from(criterion: &AcceptanceCriterion) -> Self {
        Self {
            text: criterion.text.clone(),
            required: criterion.required,
        }
    }
}

fn acceptance_criterion(criterion: ControlTaskAcceptanceCriterionDto) -> AcceptanceCriterion {
    AcceptanceCriterion {
        text: criterion.text,
        required: criterion.required,
    }
}

fn parse_importance(importance: &str) -> Result<TaskImportance, ControlApiCodecError> {
    match importance {
        "low" => Ok(TaskImportance::Low),
        "normal" => Ok(TaskImportance::Normal),
        "high" => Ok(TaskImportance::High),
        "critical" => Ok(TaskImportance::Critical),
        _ => Err(ControlApiCodecError::malformed(format!(
            "unsupported task importance: {importance}"
        ))),
    }
}

fn parse_action_type(action_type: &str) -> Result<TaskActionType, ControlApiCodecError> {
    match action_type {
        "research" => Ok(TaskActionType::Research),
        "plan" => Ok(TaskActionType::Plan),
        "execute" => Ok(TaskActionType::Execute),
        "test" => Ok(TaskActionType::Test),
        "check" => Ok(TaskActionType::Check),
        "review" => Ok(TaskActionType::Review),
        _ => Err(ControlApiCodecError::malformed(format!(
            "unsupported task action type: {action_type}"
        ))),
    }
}

fn parse_action_types(
    action_types: Vec<String>,
) -> Result<Vec<TaskActionType>, ControlApiCodecError> {
    action_types
        .into_iter()
        .map(|action_type| parse_action_type(&action_type))
        .collect()
}

fn parse_activity(activity: &str) -> Result<TaskActivityState, ControlApiCodecError> {
    match activity {
        "proposed" => Ok(TaskActivityState::Proposed),
        "ready" => Ok(TaskActivityState::Ready),
        "active" => Ok(TaskActivityState::Active),
        "done" => Ok(TaskActivityState::Done),
        "archived" => Ok(TaskActivityState::Archived),
        _ => Err(ControlApiCodecError::malformed(format!(
            "unsupported task activity: {activity}"
        ))),
    }
}

fn optional_parse<T, F>(value: Option<String>, parse: F) -> Result<Option<T>, ControlApiCodecError>
where
    F: FnOnce(&str) -> Result<T, ControlApiCodecError>,
{
    value.as_deref().map(parse).transpose()
}

fn optional_parse_vec<T, F>(
    value: Option<Vec<String>>,
    mut parse: F,
) -> Result<Option<Vec<T>>, ControlApiCodecError>
where
    F: FnMut(&str) -> Result<T, ControlApiCodecError>,
{
    value
        .map(|values| values.iter().map(|value| parse(value)).collect())
        .transpose()
}

fn importance_dto(importance: &TaskImportance) -> String {
    match importance {
        TaskImportance::Low => "low",
        TaskImportance::Normal => "normal",
        TaskImportance::High => "high",
        TaskImportance::Critical => "critical",
    }
    .to_owned()
}

fn action_type_dto(action_type: &TaskActionType) -> String {
    match action_type {
        TaskActionType::Research => "research",
        TaskActionType::Plan => "plan",
        TaskActionType::Execute => "execute",
        TaskActionType::Test => "test",
        TaskActionType::Check => "check",
        TaskActionType::Review => "review",
    }
    .to_owned()
}

fn activity_dto(activity: &TaskActivityState) -> String {
    match activity {
        TaskActivityState::Proposed => "proposed",
        TaskActivityState::Ready => "ready",
        TaskActivityState::Active => "active",
        TaskActivityState::Blocked(_) => "blocked",
        TaskActivityState::Done => "done",
        TaskActivityState::Archived => "archived",
    }
    .to_owned()
}
