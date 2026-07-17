//! Engine goal command service.

use std::time::SystemTime;

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_planning::{
    apply_goal_membership_change, decode_goal_storage_record, encode_goal_storage_record,
    goal_from_storage_record, validate_goal, Goal, GoalMembershipChange, GoalStatus,
    GoalTaskCandidate, GoalTimestamps, PlanningGoalId,
};
use nucleus_tasks::{decode_task_storage_record, TaskId};

use super::model::{
    EngineGoalCommand, EngineGoalCommandError, EngineGoalCreateCommand, EngineGoalRepository,
    EngineGoalUpdateCommand,
};
use crate::task_commands::{EngineRevisionExpectation, EngineTaskRecord};

pub struct EngineGoalCommandService<R> {
    repository: R,
}

impl<R> EngineGoalCommandService<R>
where
    R: EngineGoalRepository,
{
    pub fn new(repository: R) -> Self {
        Self { repository }
    }

    pub fn execute(
        &self,
        command_id: &str,
        command: EngineGoalCommand,
    ) -> Result<(), EngineGoalCommandError<R::Error>> {
        match command {
            EngineGoalCommand::Create(command) => self.create_goal(command_id, command),
            EngineGoalCommand::Update(command) => self.update_goal(command_id, command),
        }
    }

    fn create_goal(
        &self,
        command_id: &str,
        command: EngineGoalCreateCommand,
    ) -> Result<(), EngineGoalCommandError<R::Error>> {
        if !matches!(command.status, GoalStatus::Proposed | GoalStatus::Ready) {
            return Err(EngineGoalCommandError::InvalidRequest {
                reason: "goal authoring can create only proposed or ready goals".to_owned(),
            });
        }
        if !self
            .repository
            .project_exists(&command.project_id)
            .map_err(EngineGoalCommandError::Storage)?
        {
            return Err(EngineGoalCommandError::NotFound {
                reason: format!("goal project not found: {}", command.project_id.0),
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
        let candidates = self.task_candidates(&goal.ordered_task_refs)?;
        validate_goal(&goal, &candidates).map_err(validation_error)?;
        self.persist_goal(
            goal,
            RevisionId(format!("rev:goal-create:{command_id}")),
            EngineRevisionExpectation::MustNotExist,
        )
    }

    fn update_goal(
        &self,
        command_id: &str,
        command: EngineGoalUpdateCommand,
    ) -> Result<(), EngineGoalCommandError<R::Error>> {
        let record_id = PersistenceRecordId(command.goal_id.0.clone());
        let record = self
            .repository
            .get_planning_record(&record_id)
            .map_err(EngineGoalCommandError::Storage)?
            .ok_or_else(|| EngineGoalCommandError::NotFound {
                reason: format!("goal record not found: {}", record_id.0),
            })?;
        if record.kind != PersistenceRecordKind::Goal {
            return Err(EngineGoalCommandError::InvalidRequest {
                reason: format!("planning record is not a goal: {}", record_id.0),
            });
        }
        if record.revision_id != command.expected_revision {
            return Err(EngineGoalCommandError::Conflict {
                reason: format!("goal revision conflict for {}", record_id.0),
            });
        }
        let storage = decode_goal_storage_record(&record.payload).map_err(codec_error)?;
        let mut goal = goal_from_storage_record(storage).map_err(codec_error)?;
        let changes = command.changes;

        if let Some(task_refs) = changes.ordered_task_refs {
            let candidates = self.task_candidates(&task_refs)?;
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
        let candidates = self.task_candidates(&goal.ordered_task_refs)?;
        validate_goal(&goal, &candidates).map_err(validation_error)?;
        self.persist_goal(
            goal,
            RevisionId(format!("rev:goal-update:{command_id}")),
            EngineRevisionExpectation::Exact(command.expected_revision),
        )
    }

    fn task_candidates(
        &self,
        task_refs: &[TaskId],
    ) -> Result<Vec<GoalTaskCandidate>, EngineGoalCommandError<R::Error>> {
        task_refs
            .iter()
            .map(|task_id| {
                let record = self
                    .repository
                    .get_task_record(&PersistenceRecordId(task_id.0.clone()))
                    .map_err(EngineGoalCommandError::Storage)?
                    .ok_or_else(|| EngineGoalCommandError::NotFound {
                        reason: format!("goal task not found: {}", task_id.0),
                    })?;
                let task = decode_task_storage_record(&record.payload).map_err(|error| {
                    EngineGoalCommandError::Codec {
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

    fn persist_goal(
        &self,
        goal: Goal,
        revision_id: RevisionId,
        expectation: EngineRevisionExpectation,
    ) -> Result<(), EngineGoalCommandError<R::Error>> {
        let payload = encode_goal_storage_record(&goal).map_err(codec_error)?;
        self.repository
            .put_planning_record(
                EngineTaskRecord {
                    id: PersistenceRecordId(goal.id.0),
                    domain: PersistenceDomain::Planning,
                    kind: PersistenceRecordKind::Goal,
                    revision_id,
                    payload,
                },
                expectation,
            )
            .map_err(EngineGoalCommandError::Storage)
    }
}

fn validation_error<E>(error: nucleus_planning::GoalValidationError) -> EngineGoalCommandError<E> {
    EngineGoalCommandError::InvalidRequest {
        reason: error.reason,
    }
}

fn codec_error<E>(error: nucleus_planning::PlanningRecordCodecError) -> EngineGoalCommandError<E> {
    EngineGoalCommandError::Codec {
        reason: error.reason,
    }
}
