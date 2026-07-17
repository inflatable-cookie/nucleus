//! Goal command model and repository port.

use nucleus_core::{PersistenceRecordId, RevisionId};
use nucleus_planning::{GoalStatus, PlanningGoalId};
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::task_commands::{EngineRevisionExpectation, EngineTaskRecord};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineGoalCommand {
    Create(EngineGoalCreateCommand),
    Update(EngineGoalUpdateCommand),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineGoalCreateCommand {
    pub project_id: ProjectId,
    pub title: String,
    pub desired_outcome: String,
    pub scope: String,
    pub status: GoalStatus,
    pub owner_refs: Vec<String>,
    pub ordered_task_refs: Vec<TaskId>,
    pub planning_artifact_refs: Vec<String>,
    pub provenance_refs: Vec<String>,
    pub stop_conditions: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub current_next_task_ref: Option<TaskId>,
    pub next_action: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineGoalUpdateCommand {
    pub goal_id: PlanningGoalId,
    pub expected_revision: RevisionId,
    pub changes: EngineGoalUpdateChanges,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct EngineGoalUpdateChanges {
    pub title: Option<String>,
    pub desired_outcome: Option<String>,
    pub scope: Option<String>,
    pub owner_refs: Option<Vec<String>>,
    pub ordered_task_refs: Option<Vec<TaskId>>,
    pub planning_artifact_refs: Option<Vec<String>>,
    pub provenance_refs: Option<Vec<String>>,
    pub stop_conditions: Option<Vec<String>>,
    pub evidence_refs: Option<Vec<String>>,
    pub current_next_task_ref: Option<Option<TaskId>>,
    pub next_action: Option<Option<String>>,
}

/// Storage port for goal commands. Records use the shared engine stored
/// record shape; the engine owns codec and rule logic.
pub trait EngineGoalRepository {
    type Error;

    fn project_exists(&self, project_id: &ProjectId) -> Result<bool, Self::Error>;

    fn get_planning_record(
        &self,
        record_id: &PersistenceRecordId,
    ) -> Result<Option<EngineTaskRecord>, Self::Error>;

    fn put_planning_record(
        &self,
        record: EngineTaskRecord,
        revision: EngineRevisionExpectation,
    ) -> Result<(), Self::Error>;

    fn get_task_record(
        &self,
        record_id: &PersistenceRecordId,
    ) -> Result<Option<EngineTaskRecord>, Self::Error>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineGoalCommandError<E> {
    InvalidRequest { reason: String },
    NotFound { reason: String },
    Conflict { reason: String },
    Codec { reason: String },
    Storage(E),
}
