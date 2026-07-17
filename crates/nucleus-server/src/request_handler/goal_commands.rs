use std::time::SystemTime;

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    RevisionExpectation,
};
use nucleus_planning::{
    apply_goal_membership_change, decode_goal_storage_record, encode_goal_storage_record,
    goal_from_storage_record, validate_goal, Goal, GoalMembershipChange, GoalStatus,
    GoalTaskCandidate, GoalTimestamps, PlanningGoalId,
};
use nucleus_tasks::{decode_task_storage_record, TaskId};

use super::handler::LocalControlRequestHandler;
use crate::commands::{GoalCommand, GoalCreateCommand, GoalUpdateCommand};
use crate::control_api::{ServerCommandReceiptStatus, ServerControlError};

pub(crate) fn handle_goal_command<B>(
    handler: &LocalControlRequestHandler<B>,
    command_id: &str,
    command: GoalCommand,
) -> ServerCommandReceiptStatus
where
    B: LocalStoreBackend + Clone,
{
    let result = match command {
        GoalCommand::Create(command) => create_goal(handler, command_id, command),
        GoalCommand::Update(command) => update_goal(handler, command_id, command),
    };
    match result {
        Ok(()) => ServerCommandReceiptStatus::AcceptedForStateMutation,
        Err(error) => ServerCommandReceiptStatus::Rejected(error),
    }
}

fn create_goal<B>(
    handler: &LocalControlRequestHandler<B>,
    command_id: &str,
    command: GoalCreateCommand,
) -> Result<(), ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    if !matches!(command.status, GoalStatus::Proposed | GoalStatus::Ready) {
        return Err(ServerControlError::InvalidRequest {
            reason: "goal authoring can create only proposed or ready goals".to_owned(),
        });
    }
    let project_id = PersistenceRecordId(command.project_id.0.clone());
    if handler
        .state()
        .projects()
        .get(&project_id)
        .map_err(storage_error)?
        .is_none()
    {
        return Err(ServerControlError::NotFound {
            reason: format!("goal project not found: {}", project_id.0),
        });
    }

    let now = SystemTime::now();
    let goal = Goal {
        id: PlanningGoalId(format!("goal:{command_id}")),
        project_id: command.project_id,
        title: command.title,
        desired_outcome: command.desired_outcome,
        scope: command.scope,
        status: command.status,
        owner_refs: command.owner_refs,
        ordered_task_refs: command.ordered_task_refs,
        planning_artifact_refs: command.planning_artifact_refs,
        provenance_refs: command.provenance_refs,
        stop_conditions: command.stop_conditions,
        evidence_refs: command.evidence_refs,
        current_next_task_ref: command.current_next_task_ref,
        next_action: command.next_action,
        timestamps: GoalTimestamps {
            created_at: Some(now),
            updated_at: Some(now),
            achieved_at: None,
        },
    };
    let candidates = task_candidates(handler, &goal.ordered_task_refs)?;
    validate_goal(&goal, &candidates).map_err(validation_error)?;
    persist_goal(
        handler,
        goal,
        RevisionId(format!("rev:goal-create:{command_id}")),
        RevisionExpectation::MustNotExist,
    )
}

fn update_goal<B>(
    handler: &LocalControlRequestHandler<B>,
    command_id: &str,
    command: GoalUpdateCommand,
) -> Result<(), ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let record_id = PersistenceRecordId(command.goal_id.0.clone());
    let record = handler
        .state()
        .planning()
        .get(&record_id)
        .map_err(storage_error)?
        .ok_or_else(|| ServerControlError::NotFound {
            reason: format!("goal record not found: {}", record_id.0),
        })?;
    if record.kind != PersistenceRecordKind::Goal {
        return Err(ServerControlError::InvalidRequest {
            reason: format!("planning record is not a goal: {}", record_id.0),
        });
    }
    if record.revision_id != command.expected_revision {
        return Err(ServerControlError::Conflict {
            reason: format!("goal revision conflict for {}", record_id.0),
        });
    }
    let storage = decode_goal_storage_record(&record.payload.bytes).map_err(codec_error)?;
    let mut goal = goal_from_storage_record(storage).map_err(codec_error)?;
    let changes = command.changes;

    if let Some(task_refs) = changes.ordered_task_refs {
        let candidates = task_candidates(handler, &task_refs)?;
        goal = apply_goal_membership_change(
            &goal,
            &record.revision_id,
            GoalMembershipChange {
                expected_revision: command.expected_revision.clone(),
                ordered_task_refs: task_refs,
            },
            &candidates,
        )
        .map_err(validation_error)?;
    }
    if let Some(value) = changes.title {
        goal.title = value;
    }
    if let Some(value) = changes.desired_outcome {
        goal.desired_outcome = value;
    }
    if let Some(value) = changes.scope {
        goal.scope = value;
    }
    if let Some(value) = changes.owner_refs {
        goal.owner_refs = value;
    }
    if let Some(value) = changes.planning_artifact_refs {
        goal.planning_artifact_refs = value;
    }
    if let Some(value) = changes.provenance_refs {
        goal.provenance_refs = value;
    }
    if let Some(value) = changes.stop_conditions {
        goal.stop_conditions = value;
    }
    if let Some(value) = changes.evidence_refs {
        goal.evidence_refs = value;
    }
    if let Some(value) = changes.current_next_task_ref {
        goal.current_next_task_ref = value;
    }
    if let Some(value) = changes.next_action {
        goal.next_action = value;
    }
    goal.timestamps.updated_at = Some(SystemTime::now());
    let candidates = task_candidates(handler, &goal.ordered_task_refs)?;
    validate_goal(&goal, &candidates).map_err(validation_error)?;
    persist_goal(
        handler,
        goal,
        RevisionId(format!("rev:goal-update:{command_id}")),
        RevisionExpectation::Exact(command.expected_revision),
    )
}

fn task_candidates<B>(
    handler: &LocalControlRequestHandler<B>,
    task_refs: &[TaskId],
) -> Result<Vec<GoalTaskCandidate>, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    task_refs
        .iter()
        .map(|task_id| {
            let record = handler
                .state()
                .tasks()
                .get(&PersistenceRecordId(task_id.0.clone()))
                .map_err(storage_error)?
                .ok_or_else(|| ServerControlError::NotFound {
                    reason: format!("goal task not found: {}", task_id.0),
                })?;
            let task = decode_task_storage_record(&record.payload.bytes).map_err(|error| {
                ServerControlError::StorageUnavailable {
                    reason: format!("goal task decode failed: {}", error.reason),
                }
            })?;
            Ok(GoalTaskCandidate {
                task_id: task_id.clone(),
                project_id: nucleus_projects::ProjectId(task.project_id),
            })
        })
        .collect()
}

fn persist_goal<B>(
    handler: &LocalControlRequestHandler<B>,
    goal: Goal,
    revision_id: RevisionId,
    expectation: RevisionExpectation,
) -> Result<(), ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let payload = encode_goal_storage_record(&goal).map_err(codec_error)?;
    handler
        .state()
        .planning()
        .put(
            LocalStoreRecord {
                id: PersistenceRecordId(goal.id.0),
                domain: PersistenceDomain::Planning,
                kind: PersistenceRecordKind::Goal,
                revision_id,
                payload: LocalStoreRecordPayload {
                    media_type: Some("application/json".to_owned()),
                    bytes: payload,
                },
            },
            expectation,
        )
        .map_err(storage_error)?;
    Ok(())
}

fn validation_error(error: nucleus_planning::GoalValidationError) -> ServerControlError {
    ServerControlError::InvalidRequest {
        reason: error.reason,
    }
}

fn codec_error(error: nucleus_planning::PlanningRecordCodecError) -> ServerControlError {
    ServerControlError::StorageUnavailable {
        reason: error.reason,
    }
}

fn storage_error(error: LocalStoreError) -> ServerControlError {
    match error {
        LocalStoreError::RecordNotFound { record_id } => ServerControlError::NotFound {
            reason: format!("record not found: {}", record_id.0),
        },
        LocalStoreError::RevisionConflict(conflict) => ServerControlError::Conflict {
            reason: format!("goal revision conflict for {}", conflict.record_id.0),
        },
        LocalStoreError::DuplicateRecord { record_id } => ServerControlError::Conflict {
            reason: format!("duplicate goal record: {}", record_id.0),
        },
        LocalStoreError::InvalidRecord { reason } => ServerControlError::InvalidRequest { reason },
        LocalStoreError::UnsupportedDomain { domain } => ServerControlError::Unsupported {
            reason: format!("unsupported storage domain: {domain:?}"),
        },
        LocalStoreError::UnsupportedRecordKind { reason } => {
            ServerControlError::Unsupported { reason }
        }
        LocalStoreError::Unavailable { reason }
        | LocalStoreError::TransactionRejected { reason }
        | LocalStoreError::BackendBusy { reason }
        | LocalStoreError::BackendRejected { reason } => {
            ServerControlError::StorageUnavailable { reason }
        }
    }
}
