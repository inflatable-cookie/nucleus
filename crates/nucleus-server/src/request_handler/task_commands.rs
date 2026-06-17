use nucleus_core::PersistenceRecordId;
use nucleus_engine::{
    EngineRevisionExpectation, EngineTaskCommand, EngineTaskCommandError, EngineTaskCommandOutcome,
    EngineTaskCommandService, EngineTaskCreateCommand, EngineTaskDelegationCommand,
    EngineTaskRecord, EngineTaskRepository, EngineTaskTransitionCommand, EngineTaskUpdateChanges,
    EngineTaskUpdateCommand,
};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    RevisionExpectation,
};
use nucleus_projects::ProjectId;

use super::handler::LocalControlRequestHandler;
use crate::commands::{
    TaskCommand, TaskCreateCommand, TaskDelegationCommand, TaskTransitionCommand,
    TaskUpdateChanges, TaskUpdateCommand,
};
use crate::control_api::{ServerCommandReceiptStatus, ServerControlError};
use crate::state::ServerStateService;

pub(crate) fn handle_task_command<B>(
    handler: &LocalControlRequestHandler<B>,
    command_id: &str,
    command: TaskCommand,
) -> ServerCommandReceiptStatus
where
    B: LocalStoreBackend + Clone,
{
    let repository = ServerTaskCommandRepository::new(handler.state());
    let service = EngineTaskCommandService::new(repository);

    match service.execute(command_id, engine_task_command(command)) {
        Ok(EngineTaskCommandOutcome::Mutated) => {
            ServerCommandReceiptStatus::AcceptedForStateMutation
        }
        Ok(EngineTaskCommandOutcome::WorkItemAdmitted(_)) => {
            ServerCommandReceiptStatus::AcceptedForRuntimeScheduling
        }
        Err(error) => ServerCommandReceiptStatus::Rejected(engine_task_error(error)),
    }
}

fn engine_task_command(command: TaskCommand) -> EngineTaskCommand {
    match command {
        TaskCommand::Create(command) => EngineTaskCommand::Create(engine_create_command(command)),
        TaskCommand::Update(command) => EngineTaskCommand::Update(engine_update_command(command)),
        TaskCommand::Delegate(command) => {
            EngineTaskCommand::Delegate(engine_delegation_command(command))
        }
        TaskCommand::Start(command) => EngineTaskCommand::Start(engine_transition_command(command)),
        TaskCommand::Block {
            task_id,
            reason,
            expected_revision,
        } => EngineTaskCommand::Block {
            task_id,
            reason,
            expected_revision,
        },
        TaskCommand::Complete(command) => {
            EngineTaskCommand::Complete(engine_transition_command(command))
        }
        TaskCommand::Archive(command) => {
            EngineTaskCommand::Archive(engine_transition_command(command))
        }
    }
}

fn engine_delegation_command(command: TaskDelegationCommand) -> EngineTaskDelegationCommand {
    EngineTaskDelegationCommand {
        task_id: command.task_id,
        expected_revision: command.expected_revision,
        adapter_id: command.adapter_id,
        provider_instance_id: command.provider_instance_id,
        idempotency_key: command.idempotency_key,
    }
}

fn engine_create_command(command: TaskCreateCommand) -> EngineTaskCreateCommand {
    EngineTaskCreateCommand {
        project_id: command.project_id,
        title: command.title,
        description: command.description,
        acceptance_criteria: command.acceptance_criteria,
        importance: command.importance,
        action_type: command.action_type,
        activity: command.activity,
        agent_readiness: command.agent_readiness,
    }
}

fn engine_update_command(command: TaskUpdateCommand) -> EngineTaskUpdateCommand {
    EngineTaskUpdateCommand {
        task_id: command.task_id,
        expected_revision: command.expected_revision,
        changes: engine_update_changes(command.changes),
    }
}

fn engine_update_changes(changes: TaskUpdateChanges) -> EngineTaskUpdateChanges {
    EngineTaskUpdateChanges {
        title: changes.title,
        description: changes.description,
        acceptance_criteria: changes.acceptance_criteria,
        importance: changes.importance,
        action_type: changes.action_type,
        activity: changes.activity,
        agent_readiness: changes.agent_readiness,
    }
}

fn engine_transition_command(command: TaskTransitionCommand) -> EngineTaskTransitionCommand {
    EngineTaskTransitionCommand {
        task_id: command.task_id,
        expected_revision: command.expected_revision,
    }
}

struct ServerTaskCommandRepository<'a, B>
where
    B: LocalStoreBackend,
{
    state: &'a ServerStateService<B>,
}

impl<'a, B> ServerTaskCommandRepository<'a, B>
where
    B: LocalStoreBackend,
{
    fn new(state: &'a ServerStateService<B>) -> Self {
        Self { state }
    }
}

impl<B> EngineTaskRepository for ServerTaskCommandRepository<'_, B>
where
    B: LocalStoreBackend,
{
    type Error = LocalStoreError;

    fn project_exists(&self, project_id: &ProjectId) -> Result<bool, Self::Error> {
        let record_id = PersistenceRecordId(project_id.0.clone());
        self.state
            .projects()
            .get(&record_id)
            .map(|record| record.is_some())
    }

    fn get_task(
        &self,
        task_id: &PersistenceRecordId,
    ) -> Result<Option<EngineTaskRecord>, Self::Error> {
        self.state
            .tasks()
            .get(task_id)
            .map(|record| record.map(engine_record_from_local))
    }

    fn put_task(
        &self,
        record: EngineTaskRecord,
        revision: EngineRevisionExpectation,
    ) -> Result<(), Self::Error> {
        self.state
            .tasks()
            .put(local_record_from_engine(record), local_revision(revision))?;
        Ok(())
    }
}

fn engine_record_from_local(record: LocalStoreRecord) -> EngineTaskRecord {
    EngineTaskRecord {
        id: record.id,
        domain: record.domain,
        kind: record.kind,
        revision_id: record.revision_id,
        payload: record.payload.bytes,
    }
}

fn local_record_from_engine(record: EngineTaskRecord) -> LocalStoreRecord {
    LocalStoreRecord {
        id: record.id,
        domain: record.domain,
        kind: record.kind,
        revision_id: record.revision_id,
        payload: LocalStoreRecordPayload {
            media_type: Some("application/json".to_owned()),
            bytes: record.payload,
        },
    }
}

fn local_revision(revision: EngineRevisionExpectation) -> RevisionExpectation {
    match revision {
        EngineRevisionExpectation::MustNotExist => RevisionExpectation::MustNotExist,
        EngineRevisionExpectation::MustExist => RevisionExpectation::MustExist,
        EngineRevisionExpectation::Exact(revision) => RevisionExpectation::Exact(revision),
    }
}

fn engine_task_error(error: EngineTaskCommandError<LocalStoreError>) -> ServerControlError {
    match error {
        EngineTaskCommandError::InvalidRequest { reason } => {
            ServerControlError::InvalidRequest { reason }
        }
        EngineTaskCommandError::NotFound { reason } => ServerControlError::NotFound { reason },
        EngineTaskCommandError::Conflict { reason } => ServerControlError::Conflict { reason },
        EngineTaskCommandError::Unsupported { reason } => {
            ServerControlError::Unsupported { reason }
        }
        EngineTaskCommandError::Storage(error) => local_store_error(error),
    }
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
