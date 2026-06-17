//! Task command model and repository traits.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_projects::ProjectId;
use nucleus_tasks::{
    AcceptanceCriterion, AgentReadiness, TaskActionType, TaskActivityState, TaskId, TaskImportance,
};

use crate::EngineTaskWorkItemRecord;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineTaskCommand {
    Create(EngineTaskCreateCommand),
    Update(EngineTaskUpdateCommand),
    Delegate(EngineTaskDelegationCommand),
    Start(EngineTaskTransitionCommand),
    Block {
        task_id: TaskId,
        reason: String,
        expected_revision: Option<RevisionId>,
    },
    Complete(EngineTaskTransitionCommand),
    Archive(EngineTaskTransitionCommand),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskCreateCommand {
    pub project_id: ProjectId,
    pub title: String,
    pub description: Option<String>,
    pub acceptance_criteria: Vec<AcceptanceCriterion>,
    pub importance: TaskImportance,
    pub action_type: TaskActionType,
    pub activity: TaskActivityState,
    pub agent_readiness: AgentReadiness,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskUpdateCommand {
    pub task_id: TaskId,
    pub expected_revision: Option<RevisionId>,
    pub changes: EngineTaskUpdateChanges,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskDelegationCommand {
    pub task_id: TaskId,
    pub expected_revision: Option<RevisionId>,
    pub adapter_id: String,
    pub provider_instance_id: String,
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct EngineTaskUpdateChanges {
    pub title: Option<String>,
    pub description: Option<Option<String>>,
    pub acceptance_criteria: Option<Vec<AcceptanceCriterion>>,
    pub importance: Option<TaskImportance>,
    pub action_type: Option<TaskActionType>,
    pub activity: Option<TaskActivityState>,
    pub agent_readiness: Option<AgentReadiness>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskTransitionCommand {
    pub task_id: TaskId,
    pub expected_revision: Option<RevisionId>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskRecord {
    pub id: PersistenceRecordId,
    pub domain: PersistenceDomain,
    pub kind: PersistenceRecordKind,
    pub revision_id: RevisionId,
    pub payload: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineRevisionExpectation {
    MustNotExist,
    MustExist,
    Exact(RevisionId),
}

pub trait EngineTaskRepository {
    type Error;

    fn project_exists(&self, project_id: &ProjectId) -> Result<bool, Self::Error>;

    fn get_task(
        &self,
        task_id: &PersistenceRecordId,
    ) -> Result<Option<EngineTaskRecord>, Self::Error>;

    fn put_task(
        &self,
        record: EngineTaskRecord,
        revision: EngineRevisionExpectation,
    ) -> Result<(), Self::Error>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineTaskCommandOutcome {
    Mutated,
    WorkItemAdmitted(EngineTaskWorkItemRecord),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineTaskCommandError<E> {
    InvalidRequest { reason: String },
    NotFound { reason: String },
    Conflict { reason: String },
    Unsupported { reason: String },
    Storage(E),
}
