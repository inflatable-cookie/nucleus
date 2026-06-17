use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    RevisionExpectation,
};
use nucleus_tasks::{
    decode_task_storage_record, encode_task_storage_payload, encode_task_storage_record,
    TaskStorageActionType, TaskStorageActivityState, TaskStorageImportance, TaskStorageRecord,
};

use super::handler::LocalControlRequestHandler;
use crate::commands::{
    TaskCommand, TaskCreateCommand, TaskTransitionCommand, TaskUpdateChanges, TaskUpdateCommand,
};
use crate::control_api::{ServerCommandReceiptStatus, ServerControlError};

pub(crate) fn handle_task_command<B>(
    handler: &LocalControlRequestHandler<B>,
    command_id: &str,
    command: TaskCommand,
) -> ServerCommandReceiptStatus
where
    B: LocalStoreBackend + Clone,
{
    let result = match command {
        TaskCommand::Create(command) => create_task(handler, command_id, command),
        TaskCommand::Update(command) => update_task(handler, command_id, command),
        TaskCommand::Start(command) => transition_task_activity(
            handler,
            command_id,
            command,
            TaskStorageActivityState::Active,
        ),
        TaskCommand::Block {
            task_id,
            reason,
            expected_revision,
        } => transition_task_activity(
            handler,
            command_id,
            TaskTransitionCommand {
                task_id,
                expected_revision,
            },
            TaskStorageActivityState::Blocked { reason },
        ),
        TaskCommand::Complete(command) => {
            transition_task_activity(handler, command_id, command, TaskStorageActivityState::Done)
        }
        TaskCommand::Archive(command) => transition_task_activity(
            handler,
            command_id,
            command,
            TaskStorageActivityState::Archived,
        ),
    };

    match result {
        Ok(()) => ServerCommandReceiptStatus::AcceptedForStateMutation,
        Err(error) => ServerCommandReceiptStatus::Rejected(error),
    }
}

fn create_task<B>(
    handler: &LocalControlRequestHandler<B>,
    command_id: &str,
    command: TaskCreateCommand,
) -> Result<(), ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    validate_project_exists(handler, &command.project_id.0)?;
    validate_task_title(&command.title)?;
    validate_create_activity(&command.activity)?;
    validate_agent_readiness(
        command.agent_readiness.ready_for_agent,
        &command.acceptance_criteria,
    )?;

    let task = task_from_create_command(command_id, command);
    let payload = encode_task_storage_record(&task).map_err(task_codec_error)?;
    let record = LocalStoreRecord {
        id: PersistenceRecordId(task.id.0),
        domain: PersistenceDomain::Tasks,
        kind: PersistenceRecordKind::Task,
        revision_id: next_task_revision(command_id),
        payload: LocalStoreRecordPayload {
            media_type: Some("application/json".to_owned()),
            bytes: payload,
        },
    };

    handler
        .state
        .tasks()
        .put(record, RevisionExpectation::MustNotExist)
        .map_err(local_store_error)?;
    Ok(())
}

fn update_task<B>(
    handler: &LocalControlRequestHandler<B>,
    command_id: &str,
    command: TaskUpdateCommand,
) -> Result<(), ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let record_id = PersistenceRecordId(command.task_id.0);
    let existing = handler
        .state
        .tasks()
        .get(&record_id)
        .map_err(local_store_error)?
        .ok_or_else(|| {
            local_store_error(LocalStoreError::RecordNotFound {
                record_id: record_id.clone(),
            })
        })?;
    let mut decoded =
        decode_task_storage_record(&existing.payload.bytes).map_err(task_codec_error)?;

    apply_task_update_changes(&mut decoded, command.changes)?;
    validate_task_title(&decoded.title)?;
    validate_agent_ready_storage(&decoded)?;

    let payload = encode_task_storage_payload(&decoded).map_err(task_codec_error)?;
    let expected_revision = command
        .expected_revision
        .map(RevisionExpectation::Exact)
        .unwrap_or(RevisionExpectation::MustExist);
    let updated = LocalStoreRecord {
        id: record_id,
        domain: existing.domain,
        kind: existing.kind,
        revision_id: next_task_revision(command_id),
        payload: LocalStoreRecordPayload {
            media_type: Some("application/json".to_owned()),
            bytes: payload,
        },
    };

    handler
        .state
        .tasks()
        .put(updated, expected_revision)
        .map_err(local_store_error)?;
    Ok(())
}

fn transition_task_activity<B>(
    handler: &LocalControlRequestHandler<B>,
    command_id: &str,
    command: TaskTransitionCommand,
    activity: TaskStorageActivityState,
) -> Result<(), ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let record_id = PersistenceRecordId(command.task_id.0);
    let existing = handler
        .state
        .tasks()
        .get(&record_id)
        .map_err(local_store_error)?
        .ok_or_else(|| LocalStoreError::RecordNotFound {
            record_id: record_id.clone(),
        })
        .map_err(local_store_error)?;

    let mut decoded =
        decode_task_storage_record(&existing.payload.bytes).map_err(task_codec_error)?;
    decoded.activity = activity;

    let payload = encode_task_storage_payload(&decoded).map_err(task_codec_error)?;
    let expected_revision = command
        .expected_revision
        .map(RevisionExpectation::Exact)
        .unwrap_or(RevisionExpectation::MustExist);
    let updated = LocalStoreRecord {
        id: record_id,
        domain: existing.domain,
        kind: existing.kind,
        revision_id: next_task_revision(command_id),
        payload: LocalStoreRecordPayload {
            media_type: Some("application/json".to_owned()),
            bytes: payload,
        },
    };

    handler
        .state
        .tasks()
        .put(updated, expected_revision)
        .map_err(local_store_error)?;
    Ok(())
}

fn task_from_create_command(command_id: &str, command: TaskCreateCommand) -> nucleus_tasks::Task {
    nucleus_tasks::Task {
        id: nucleus_tasks::TaskId(format!("task:{command_id}")),
        project_id: command.project_id,
        title: command.title,
        description: command.description,
        acceptance_criteria: command.acceptance_criteria,
        importance: command.importance,
        neglect: nucleus_tasks::NeglectSignal {
            level: nucleus_tasks::NeglectLevel::Fresh,
            last_addressed_at: None,
            note: None,
        },
        action_type: command.action_type,
        assignment: nucleus_tasks::AssignmentState::Unassigned,
        activity: command.activity,
        agent_readiness: command.agent_readiness,
        assignment_plan: None,
        assignment_snapshot: None,
        history: Vec::new(),
        model_preferences: None,
        timestamps: nucleus_tasks::TaskTimestamps {
            created_at: None,
            updated_at: None,
            started_at: None,
            completed_at: None,
        },
    }
}

fn apply_task_update_changes(
    record: &mut TaskStorageRecord,
    changes: TaskUpdateChanges,
) -> Result<(), ServerControlError> {
    if let Some(title) = changes.title {
        record.title = title;
    }
    if let Some(description) = changes.description {
        record.description = description;
    }
    if let Some(acceptance_criteria) = changes.acceptance_criteria {
        record.acceptance_criteria = acceptance_criteria
            .into_iter()
            .map(|criterion| nucleus_tasks::TaskStorageAcceptanceCriterion {
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

fn validate_project_exists<B>(
    handler: &LocalControlRequestHandler<B>,
    project_id: &str,
) -> Result<(), ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let record_id = PersistenceRecordId(project_id.to_owned());
    match handler
        .state
        .projects()
        .get(&record_id)
        .map_err(local_store_error)?
    {
        Some(_) => Ok(()),
        None => Err(ServerControlError::NotFound {
            reason: format!("project record not found: {project_id}"),
        }),
    }
}

fn validate_task_title(title: &str) -> Result<(), ServerControlError> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err(ServerControlError::InvalidRequest {
            reason: "task title must not be empty".to_owned(),
        });
    }

    if trimmed.len() > 160 {
        return Err(ServerControlError::InvalidRequest {
            reason: "task title must be 160 characters or fewer".to_owned(),
        });
    }

    Ok(())
}

fn validate_create_activity(
    activity: &nucleus_tasks::TaskActivityState,
) -> Result<(), ServerControlError> {
    match activity {
        nucleus_tasks::TaskActivityState::Proposed
        | nucleus_tasks::TaskActivityState::Ready
        | nucleus_tasks::TaskActivityState::Active => Ok(()),
        nucleus_tasks::TaskActivityState::Blocked(reason) if !reason.trim().is_empty() => Ok(()),
        nucleus_tasks::TaskActivityState::Blocked(_) => Err(ServerControlError::InvalidRequest {
            reason: "blocked task activity requires a reason".to_owned(),
        }),
        nucleus_tasks::TaskActivityState::Done | nucleus_tasks::TaskActivityState::Archived => {
            Err(ServerControlError::InvalidRequest {
                reason: "task create cannot start as done or archived".to_owned(),
            })
        }
    }
}

fn validate_update_activity(
    activity: &nucleus_tasks::TaskActivityState,
) -> Result<(), ServerControlError> {
    match activity {
        nucleus_tasks::TaskActivityState::Blocked(reason) if reason.trim().is_empty() => {
            Err(ServerControlError::InvalidRequest {
                reason: "blocked task activity requires a reason".to_owned(),
            })
        }
        _ => Ok(()),
    }
}

fn validate_agent_readiness(
    ready_for_agent: bool,
    acceptance_criteria: &[nucleus_tasks::AcceptanceCriterion],
) -> Result<(), ServerControlError> {
    if ready_for_agent && acceptance_criteria.is_empty() {
        return Err(ServerControlError::InvalidRequest {
            reason: "agent-ready tasks require at least one acceptance criterion".to_owned(),
        });
    }
    Ok(())
}

fn validate_agent_ready_storage(record: &TaskStorageRecord) -> Result<(), ServerControlError> {
    if record.agent_ready && record.acceptance_criteria.is_empty() {
        return Err(ServerControlError::InvalidRequest {
            reason: "agent-ready tasks require at least one acceptance criterion".to_owned(),
        });
    }
    Ok(())
}

fn task_codec_error(error: nucleus_tasks::TaskRecordCodecError) -> ServerControlError {
    ServerControlError::InvalidRequest {
        reason: format!("task storage payload is invalid: {}", error.reason),
    }
}

fn next_task_revision(command_id: &str) -> RevisionId {
    RevisionId(format!("rev:task-command:{command_id}"))
}

fn local_store_error(error: LocalStoreError) -> ServerControlError {
    match error {
        LocalStoreError::RecordNotFound { record_id } => ServerControlError::NotFound {
            reason: format!("task record not found: {}", record_id.0),
        },
        LocalStoreError::RevisionConflict(conflict) => ServerControlError::Conflict {
            reason: format!("task revision conflict for {}", conflict.record_id.0),
        },
        LocalStoreError::InvalidRecord { reason } => ServerControlError::InvalidRequest {
            reason: format!("task storage payload is invalid: {reason}"),
        },
        LocalStoreError::UnsupportedDomain { domain } => ServerControlError::Unsupported {
            reason: format!("unsupported storage domain: {domain:?}"),
        },
        LocalStoreError::UnsupportedRecordKind { reason } => {
            ServerControlError::Unsupported { reason }
        }
        LocalStoreError::DuplicateRecord { record_id } => ServerControlError::Conflict {
            reason: format!("duplicate task record: {}", record_id.0),
        },
        LocalStoreError::Unavailable { reason }
        | LocalStoreError::TransactionRejected { reason }
        | LocalStoreError::BackendRejected { reason } => {
            ServerControlError::StorageUnavailable { reason }
        }
    }
}
