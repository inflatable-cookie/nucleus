//! Engine-owned task command service.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_projects::ProjectId;
use nucleus_tasks::{
    decode_task_storage_record, encode_task_storage_payload, encode_task_storage_record,
    AcceptanceCriterion, AgentReadiness, AssignmentState, NeglectLevel, NeglectSignal, Task,
    TaskActionType, TaskActivityState, TaskId, TaskImportance, TaskStorageAcceptanceCriterion,
    TaskStorageActionType, TaskStorageActivityState, TaskStorageImportance, TaskStorageRecord,
    TaskTimestamps,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineTaskCommand {
    Create(EngineTaskCreateCommand),
    Update(EngineTaskUpdateCommand),
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
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineTaskCommandError<E> {
    InvalidRequest { reason: String },
    NotFound { reason: String },
    Conflict { reason: String },
    Unsupported { reason: String },
    Storage(E),
}

#[derive(Clone, Debug)]
pub struct EngineTaskCommandService<R> {
    repository: R,
}

impl<R> EngineTaskCommandService<R>
where
    R: EngineTaskRepository,
{
    pub fn new(repository: R) -> Self {
        Self { repository }
    }

    pub fn execute(
        &self,
        command_id: &str,
        command: EngineTaskCommand,
    ) -> Result<EngineTaskCommandOutcome, EngineTaskCommandError<R::Error>> {
        match command {
            EngineTaskCommand::Create(command) => self.create_task(command_id, command),
            EngineTaskCommand::Update(command) => self.update_task(command_id, command),
            EngineTaskCommand::Start(command) => {
                self.transition_task_activity(command_id, command, TaskStorageActivityState::Active)
            }
            EngineTaskCommand::Block {
                task_id,
                reason,
                expected_revision,
            } => self.transition_task_activity(
                command_id,
                EngineTaskTransitionCommand {
                    task_id,
                    expected_revision,
                },
                TaskStorageActivityState::Blocked { reason },
            ),
            EngineTaskCommand::Complete(command) => {
                self.transition_task_activity(command_id, command, TaskStorageActivityState::Done)
            }
            EngineTaskCommand::Archive(command) => self.transition_task_activity(
                command_id,
                command,
                TaskStorageActivityState::Archived,
            ),
        }
    }

    fn create_task(
        &self,
        command_id: &str,
        command: EngineTaskCreateCommand,
    ) -> Result<EngineTaskCommandOutcome, EngineTaskCommandError<R::Error>> {
        validate_project_exists(&self.repository, &command.project_id)?;
        validate_task_title(&command.title)?;
        validate_create_activity(&command.activity)?;
        validate_agent_readiness(
            command.agent_readiness.ready_for_agent,
            &command.acceptance_criteria,
        )?;

        let task = task_from_create_command(command_id, command);
        let payload = encode_task_storage_record(&task).map_err(task_codec_error)?;
        let record = EngineTaskRecord {
            id: PersistenceRecordId(task.id.0),
            domain: PersistenceDomain::Tasks,
            kind: PersistenceRecordKind::Task,
            revision_id: next_task_revision(command_id),
            payload,
        };

        self.repository
            .put_task(record, EngineRevisionExpectation::MustNotExist)
            .map_err(EngineTaskCommandError::Storage)?;
        Ok(EngineTaskCommandOutcome::Mutated)
    }

    fn update_task(
        &self,
        command_id: &str,
        command: EngineTaskUpdateCommand,
    ) -> Result<EngineTaskCommandOutcome, EngineTaskCommandError<R::Error>> {
        let record_id = PersistenceRecordId(command.task_id.0);
        let existing = self
            .repository
            .get_task(&record_id)
            .map_err(EngineTaskCommandError::Storage)?
            .ok_or_else(|| EngineTaskCommandError::NotFound {
                reason: format!("task record not found: {}", record_id.0),
            })?;
        let mut decoded =
            decode_task_storage_record(&existing.payload).map_err(task_codec_error)?;

        apply_task_update_changes::<R::Error>(&mut decoded, command.changes)?;
        validate_task_title(&decoded.title)?;
        validate_agent_ready_storage(&decoded)?;

        let payload = encode_task_storage_payload(&decoded).map_err(task_codec_error)?;
        let expected_revision = command
            .expected_revision
            .map(EngineRevisionExpectation::Exact)
            .unwrap_or(EngineRevisionExpectation::MustExist);
        let updated = EngineTaskRecord {
            id: record_id,
            domain: existing.domain,
            kind: existing.kind,
            revision_id: next_task_revision(command_id),
            payload,
        };

        self.repository
            .put_task(updated, expected_revision)
            .map_err(EngineTaskCommandError::Storage)?;
        Ok(EngineTaskCommandOutcome::Mutated)
    }

    fn transition_task_activity(
        &self,
        command_id: &str,
        command: EngineTaskTransitionCommand,
        activity: TaskStorageActivityState,
    ) -> Result<EngineTaskCommandOutcome, EngineTaskCommandError<R::Error>> {
        let record_id = PersistenceRecordId(command.task_id.0);
        let existing = self
            .repository
            .get_task(&record_id)
            .map_err(EngineTaskCommandError::Storage)?
            .ok_or_else(|| EngineTaskCommandError::NotFound {
                reason: format!("task record not found: {}", record_id.0),
            })?;

        let mut decoded =
            decode_task_storage_record(&existing.payload).map_err(task_codec_error)?;
        decoded.activity = activity;

        let payload = encode_task_storage_payload(&decoded).map_err(task_codec_error)?;
        let expected_revision = command
            .expected_revision
            .map(EngineRevisionExpectation::Exact)
            .unwrap_or(EngineRevisionExpectation::MustExist);
        let updated = EngineTaskRecord {
            id: record_id,
            domain: existing.domain,
            kind: existing.kind,
            revision_id: next_task_revision(command_id),
            payload,
        };

        self.repository
            .put_task(updated, expected_revision)
            .map_err(EngineTaskCommandError::Storage)?;
        Ok(EngineTaskCommandOutcome::Mutated)
    }
}

fn task_from_create_command(command_id: &str, command: EngineTaskCreateCommand) -> Task {
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

fn apply_task_update_changes<E>(
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

fn validate_project_exists<R>(
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

fn validate_task_title<E>(title: &str) -> Result<(), EngineTaskCommandError<E>> {
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

fn validate_create_activity<E>(
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

fn validate_update_activity<E>(
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

fn validate_agent_readiness<E>(
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

fn validate_agent_ready_storage<E>(
    record: &TaskStorageRecord,
) -> Result<(), EngineTaskCommandError<E>> {
    if record.agent_ready && record.acceptance_criteria.is_empty() {
        return Err(EngineTaskCommandError::InvalidRequest {
            reason: "agent-ready tasks require at least one acceptance criterion".to_owned(),
        });
    }
    Ok(())
}

fn task_codec_error<E>(error: nucleus_tasks::TaskRecordCodecError) -> EngineTaskCommandError<E> {
    EngineTaskCommandError::InvalidRequest {
        reason: format!("task storage payload is invalid: {}", error.reason),
    }
}

fn next_task_revision(command_id: &str) -> RevisionId {
    RevisionId(format!("rev:task-command:{command_id}"))
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::{HashMap, HashSet};

    use super::*;

    #[derive(Debug, Default)]
    struct FixtureTaskRepository {
        projects: HashSet<String>,
        tasks: RefCell<HashMap<String, EngineTaskRecord>>,
    }

    impl FixtureTaskRepository {
        fn with_project(project_id: &str) -> Self {
            Self {
                projects: HashSet::from([project_id.to_owned()]),
                tasks: RefCell::new(HashMap::new()),
            }
        }

        fn seed_task(&self, task: Task, revision_id: RevisionId) {
            let payload = encode_task_storage_record(&task).expect("encode task");
            let record = EngineTaskRecord {
                id: PersistenceRecordId(task.id.0.clone()),
                domain: PersistenceDomain::Tasks,
                kind: PersistenceRecordKind::Task,
                revision_id,
                payload,
            };
            self.tasks.borrow_mut().insert(task.id.0, record);
        }

        fn decoded_task(&self, task_id: &str) -> TaskStorageRecord {
            let tasks = self.tasks.borrow();
            let record = tasks.get(task_id).expect("task exists");
            decode_task_storage_record(&record.payload).expect("decode task")
        }
    }

    impl EngineTaskRepository for &FixtureTaskRepository {
        type Error = &'static str;

        fn project_exists(&self, project_id: &ProjectId) -> Result<bool, Self::Error> {
            Ok(self.projects.contains(&project_id.0))
        }

        fn get_task(
            &self,
            task_id: &PersistenceRecordId,
        ) -> Result<Option<EngineTaskRecord>, Self::Error> {
            Ok(self.tasks.borrow().get(&task_id.0).cloned())
        }

        fn put_task(
            &self,
            record: EngineTaskRecord,
            revision: EngineRevisionExpectation,
        ) -> Result<(), Self::Error> {
            let mut tasks = self.tasks.borrow_mut();
            let existing = tasks.get(&record.id.0);
            match revision {
                EngineRevisionExpectation::MustNotExist if existing.is_some() => {
                    return Err("duplicate");
                }
                EngineRevisionExpectation::MustExist if existing.is_none() => {
                    return Err("missing");
                }
                EngineRevisionExpectation::Exact(expected)
                    if existing.map(|record| &record.revision_id) != Some(&expected) =>
                {
                    return Err("revision-conflict");
                }
                _ => {}
            }
            tasks.insert(record.id.0.clone(), record);
            Ok(())
        }
    }

    #[test]
    fn engine_task_command_creates_task_record() {
        let repository = FixtureTaskRepository::with_project("project:1");
        let service = EngineTaskCommandService::new(&repository);

        service
            .execute(
                "command:create",
                EngineTaskCommand::Create(create_command("project:1")),
            )
            .expect("create task");

        let decoded = repository.decoded_task("task:command:create");
        assert_eq!(decoded.project_id, "project:1");
        assert_eq!(decoded.title, "Create task");
        assert_eq!(decoded.activity, TaskStorageActivityState::Ready);
    }

    #[test]
    fn engine_task_command_updates_task_record_with_revision() {
        let repository = FixtureTaskRepository::with_project("project:1");
        repository.seed_task(seed_task("task:1"), RevisionId("rev:1".to_owned()));
        let service = EngineTaskCommandService::new(&repository);

        service
            .execute(
                "command:update",
                EngineTaskCommand::Update(EngineTaskUpdateCommand {
                    task_id: TaskId("task:1".to_owned()),
                    expected_revision: Some(RevisionId("rev:1".to_owned())),
                    changes: EngineTaskUpdateChanges {
                        title: Some("Updated task".to_owned()),
                        importance: Some(TaskImportance::Critical),
                        ..Default::default()
                    },
                }),
            )
            .expect("update task");

        let decoded = repository.decoded_task("task:1");
        assert_eq!(decoded.title, "Updated task");
        assert_eq!(decoded.importance, TaskStorageImportance::Critical);
    }

    #[test]
    fn engine_task_command_transitions_task_activity() {
        let repository = FixtureTaskRepository::with_project("project:1");
        repository.seed_task(seed_task("task:1"), RevisionId("rev:1".to_owned()));
        let service = EngineTaskCommandService::new(&repository);

        service
            .execute(
                "command:start",
                EngineTaskCommand::Start(EngineTaskTransitionCommand {
                    task_id: TaskId("task:1".to_owned()),
                    expected_revision: None,
                }),
            )
            .expect("start task");

        let decoded = repository.decoded_task("task:1");
        assert_eq!(decoded.activity, TaskStorageActivityState::Active);
    }

    #[test]
    fn engine_task_command_rejects_agent_ready_task_without_acceptance() {
        let repository = FixtureTaskRepository::with_project("project:1");
        let service = EngineTaskCommandService::new(&repository);
        let mut command = create_command("project:1");
        command.acceptance_criteria.clear();
        command.agent_readiness.ready_for_agent = true;

        let error = service
            .execute("command:create", EngineTaskCommand::Create(command))
            .expect_err("reject invalid task");

        assert!(matches!(
            error,
            EngineTaskCommandError::InvalidRequest { reason }
                if reason == "agent-ready tasks require at least one acceptance criterion"
        ));
    }

    fn create_command(project_id: &str) -> EngineTaskCreateCommand {
        EngineTaskCreateCommand {
            project_id: ProjectId(project_id.to_owned()),
            title: "Create task".to_owned(),
            description: None,
            acceptance_criteria: vec![AcceptanceCriterion {
                text: "Task exists".to_owned(),
                required: true,
            }],
            importance: TaskImportance::Normal,
            action_type: TaskActionType::Plan,
            activity: TaskActivityState::Ready,
            agent_readiness: AgentReadiness {
                ready_for_agent: false,
                required_context_refs: Vec::new(),
                allowed_actions: vec![TaskActionType::Plan],
                stop_conditions: Vec::new(),
                validation_commands: Vec::new(),
            },
        }
    }

    fn seed_task(task_id: &str) -> Task {
        Task {
            id: TaskId(task_id.to_owned()),
            project_id: ProjectId("project:1".to_owned()),
            title: "Seed task".to_owned(),
            description: None,
            acceptance_criteria: vec![AcceptanceCriterion {
                text: "Task can change".to_owned(),
                required: true,
            }],
            importance: TaskImportance::Normal,
            neglect: NeglectSignal {
                level: NeglectLevel::Fresh,
                last_addressed_at: None,
                note: None,
            },
            action_type: TaskActionType::Plan,
            assignment: AssignmentState::Unassigned,
            activity: TaskActivityState::Ready,
            agent_readiness: AgentReadiness {
                ready_for_agent: false,
                required_context_refs: Vec::new(),
                allowed_actions: vec![TaskActionType::Plan],
                stop_conditions: Vec::new(),
                validation_commands: Vec::new(),
            },
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
}
