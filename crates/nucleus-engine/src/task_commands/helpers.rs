//! Task command conversion and validation helpers.

use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;
use nucleus_tasks::{
    AcceptanceCriterion, AssignmentState, NeglectLevel, NeglectSignal, Task, TaskActivityState,
    TaskId, TaskStorageAcceptanceCriterion, TaskStorageActionType, TaskStorageActivityState,
    TaskStorageImportance, TaskStorageRecord, TaskTimestamps,
};

use super::model::{
    EngineTaskCommandError, EngineTaskCreateCommand, EngineTaskRepository, EngineTaskUpdateChanges,
};

pub(super) fn task_from_create_command(command_id: &str, command: EngineTaskCreateCommand) -> Task {
    Task {
        id: TaskId(format!("task:{command_id}")),
        project_id: command.project_id,
        title: command.title,
        description: command.description,
        acceptance_criteria: command.acceptance_criteria,
        importance: command.importance,
        neglect: NeglectSignal {
            level: NeglectLevel::Fresh,
            last_addressed_at: None,
            note: None,
        },
        action_type: command.action_type,
        assignment: AssignmentState::Unassigned,
        activity: command.activity,
        agent_readiness: command.agent_readiness,
        assignment_plan: None,
        assignment_snapshot: None,
        history: Vec::new(),
        model_preferences: None,
        timestamps: TaskTimestamps {
            created_at: None,
            updated_at: None,
            started_at: None,
            completed_at: None,
        },
    }
}

pub(super) fn apply_task_update_changes<E>(
    record: &mut TaskStorageRecord,
    changes: EngineTaskUpdateChanges,
) -> Result<(), EngineTaskCommandError<E>> {
    if let Some(title) = changes.title {
        record.title = title;
    }
    if let Some(description) = changes.description {
        record.description = description;
    }
    if let Some(acceptance_criteria) = changes.acceptance_criteria {
        record.acceptance_criteria = acceptance_criteria
            .into_iter()
            .map(|criterion| TaskStorageAcceptanceCriterion {
                text: criterion.text,
                required: criterion.required,
            })
            .collect();
    }
    if let Some(importance) = changes.importance {
        record.importance = TaskStorageImportance::from(&importance);
    }
    if let Some(action_type) = changes.action_type {
        record.action_type = TaskStorageActionType::from(&action_type);
    }
    if let Some(activity) = changes.activity {
        validate_update_activity(&activity)?;
        record.activity = TaskStorageActivityState::from(&activity);
    }
    if let Some(readiness) = changes.agent_readiness {
        record.agent_ready = readiness.ready_for_agent;
        record.required_context_refs = readiness.required_context_refs;
        record.allowed_actions = readiness
            .allowed_actions
            .iter()
            .map(TaskStorageActionType::from)
            .collect();
        record.stop_conditions = readiness.stop_conditions;
        record.validation_commands = readiness.validation_commands;
    }
    Ok(())
}

pub(super) fn validate_project_exists<R>(
    repository: &R,
    project_id: &ProjectId,
) -> Result<(), EngineTaskCommandError<R::Error>>
where
    R: EngineTaskRepository,
{
    if repository
        .project_exists(project_id)
        .map_err(EngineTaskCommandError::Storage)?
    {
        Ok(())
    } else {
        Err(EngineTaskCommandError::NotFound {
            reason: format!("project record not found: {}", project_id.0),
        })
    }
}

pub(super) fn validate_task_title<E>(title: &str) -> Result<(), EngineTaskCommandError<E>> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err(EngineTaskCommandError::InvalidRequest {
            reason: "task title must not be empty".to_owned(),
        });
    }

    if trimmed.len() > 160 {
        return Err(EngineTaskCommandError::InvalidRequest {
            reason: "task title must be 160 characters or fewer".to_owned(),
        });
    }

    Ok(())
}

pub(super) fn validate_create_activity<E>(
    activity: &TaskActivityState,
) -> Result<(), EngineTaskCommandError<E>> {
    match activity {
        TaskActivityState::Proposed | TaskActivityState::Ready | TaskActivityState::Active => {
            Ok(())
        }
        TaskActivityState::Blocked(reason) if !reason.trim().is_empty() => Ok(()),
        TaskActivityState::Blocked(_) => Err(EngineTaskCommandError::InvalidRequest {
            reason: "blocked task activity requires a reason".to_owned(),
        }),
        TaskActivityState::Done | TaskActivityState::Archived => {
            Err(EngineTaskCommandError::InvalidRequest {
                reason: "task create cannot start as done or archived".to_owned(),
            })
        }
    }
}

pub(super) fn validate_update_activity<E>(
    activity: &TaskActivityState,
) -> Result<(), EngineTaskCommandError<E>> {
    match activity {
        TaskActivityState::Blocked(reason) if reason.trim().is_empty() => {
            Err(EngineTaskCommandError::InvalidRequest {
                reason: "blocked task activity requires a reason".to_owned(),
            })
        }
        _ => Ok(()),
    }
}

pub(super) fn validate_agent_readiness<E>(
    ready_for_agent: bool,
    acceptance_criteria: &[AcceptanceCriterion],
) -> Result<(), EngineTaskCommandError<E>> {
    if ready_for_agent && acceptance_criteria.is_empty() {
        return Err(EngineTaskCommandError::InvalidRequest {
            reason: "agent-ready tasks require at least one acceptance criterion".to_owned(),
        });
    }
    Ok(())
}

pub(super) fn validate_agent_ready_storage<E>(
    record: &TaskStorageRecord,
) -> Result<(), EngineTaskCommandError<E>> {
    if record.agent_ready && record.acceptance_criteria.is_empty() {
        return Err(EngineTaskCommandError::InvalidRequest {
            reason: "agent-ready tasks require at least one acceptance criterion".to_owned(),
        });
    }
    Ok(())
}

pub(super) fn task_codec_error<E>(
    error: nucleus_tasks::TaskRecordCodecError,
) -> EngineTaskCommandError<E> {
    EngineTaskCommandError::InvalidRequest {
        reason: format!("task storage payload is invalid: {}", error.reason),
    }
}

pub(super) fn next_task_revision(command_id: &str) -> RevisionId {
    RevisionId(format!("rev:task-command:{command_id}"))
}
