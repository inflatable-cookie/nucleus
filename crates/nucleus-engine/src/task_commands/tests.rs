use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_projects::ProjectId;
use nucleus_tasks::{
    decode_task_storage_record, encode_task_storage_record, AcceptanceCriterion, AgentReadiness,
    AssignmentState, NeglectLevel, NeglectSignal, Task, TaskActionType, TaskActivityState, TaskId,
    TaskImportance, TaskStorageActivityState, TaskStorageImportance, TaskStorageRecord,
    TaskTimestamps,
};

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

#[test]
fn engine_task_command_admits_task_delegation_as_work_item() {
    let repository = FixtureTaskRepository::with_project("project:1");
    repository.seed_task(seed_task("task:1"), RevisionId("rev:1".to_owned()));
    let service = EngineTaskCommandService::new(&repository);

    let outcome = service
        .execute(
            "command:delegate",
            EngineTaskCommand::Delegate(EngineTaskDelegationCommand {
                task_id: TaskId("task:1".to_owned()),
                expected_revision: Some(RevisionId("rev:1".to_owned())),
                adapter_id: "adapter:codex-app-server".to_owned(),
                provider_instance_id: "codex:local-default".to_owned(),
                idempotency_key: "operator-click-1".to_owned(),
            }),
        )
        .expect("delegate task");

    assert!(matches!(
        outcome,
        EngineTaskCommandOutcome::WorkItemAdmitted { work_item, admission }
            if work_item.task_id == TaskId("task:1".to_owned())
                && work_item.work_item_id.0 == "work-item:task:1:operator-click-1"
                && work_item.runtime == crate::EngineTaskWorkItemRuntimeState::Scheduled
                && work_item.review == crate::EngineTaskWorkItemReviewState::NotReady
                && admission.source_record.work_item_id == work_item.work_item_id
                && admission.provider_execution_deferred
    ));
    assert_eq!(
        repository.decoded_task("task:1").activity,
        TaskStorageActivityState::Ready
    );
}

#[test]
fn engine_task_command_rejects_delegation_without_adapter_target() {
    let repository = FixtureTaskRepository::with_project("project:1");
    repository.seed_task(seed_task("task:1"), RevisionId("rev:1".to_owned()));
    let service = EngineTaskCommandService::new(&repository);

    let error = service
        .execute(
            "command:delegate",
            EngineTaskCommand::Delegate(EngineTaskDelegationCommand {
                task_id: TaskId("task:1".to_owned()),
                expected_revision: None,
                adapter_id: String::new(),
                provider_instance_id: "codex:local-default".to_owned(),
                idempotency_key: "operator-click-1".to_owned(),
            }),
        )
        .expect_err("reject missing adapter");

    assert!(matches!(
        error,
        EngineTaskCommandError::InvalidRequest { reason }
            if reason == "task delegation requires an adapter id"
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
