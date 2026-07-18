//! Goal command adapter: DTO mapping plus the storage port. Canonical goal
//! rules live in `nucleus_engine::goal_commands` (contract 022).

use nucleus_core::{PersistenceDomain, PersistenceRecordId};
use nucleus_engine::{
    EngineGoalCommand, EngineGoalCommandError, EngineGoalCommandService, EngineGoalCreateCommand,
    EngineGoalRepository, EngineGoalUpdateChanges, EngineGoalUpdateCommand,
    EngineRevisionExpectation, EngineTaskRecord,
};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    RevisionExpectation,
};
use nucleus_projects::ProjectId;

use super::handler::LocalControlRequestHandler;
use crate::commands::{GoalCommand, GoalCreateCommand, GoalUpdateCommand};
use crate::control_api::{ServerCommandReceiptStatus, ServerControlError};
use crate::state::ServerStateService;

pub(crate) fn handle_goal_command<B>(
    handler: &LocalControlRequestHandler<B>,
    command_id: &str,
    command: GoalCommand,
) -> ServerCommandReceiptStatus
where
    B: LocalStoreBackend + Clone,
{
    if let GoalCommand::Create(ref create) = command {
        if let Err(error) =
            super::project_commands::ensure_project_durable(handler, command_id, &create.project_id)
        {
            return ServerCommandReceiptStatus::Rejected(error);
        }
    }

    let repository = GoalStateRepository {
        state: handler.state(),
    };
    let service = EngineGoalCommandService::new(repository);
    let result = service.execute(command_id, engine_goal_command(command));
    match result {
        Ok(()) => ServerCommandReceiptStatus::AcceptedForStateMutation,
        Err(error) => ServerCommandReceiptStatus::Rejected(engine_goal_error(error)),
    }
}

fn engine_goal_command(command: GoalCommand) -> EngineGoalCommand {
    match command {
        GoalCommand::Create(command) => EngineGoalCommand::Create(engine_create_command(command)),
        GoalCommand::Update(command) => EngineGoalCommand::Update(engine_update_command(command)),
    }
}

fn engine_create_command(command: GoalCreateCommand) -> EngineGoalCreateCommand {
    EngineGoalCreateCommand {
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
    }
}

fn engine_update_command(command: GoalUpdateCommand) -> EngineGoalUpdateCommand {
    let changes = command.changes;
    EngineGoalUpdateCommand {
        goal_id: command.goal_id,
        expected_revision: command.expected_revision,
        changes: EngineGoalUpdateChanges {
            title: changes.title,
            desired_outcome: changes.desired_outcome,
            scope: changes.scope,
            owner_refs: changes.owner_refs,
            ordered_task_refs: changes.ordered_task_refs,
            planning_artifact_refs: changes.planning_artifact_refs,
            provenance_refs: changes.provenance_refs,
            stop_conditions: changes.stop_conditions,
            evidence_refs: changes.evidence_refs,
            current_next_task_ref: changes.current_next_task_ref,
            next_action: changes.next_action,
        },
    }
}

struct GoalStateRepository<'a, B> {
    state: &'a ServerStateService<B>,
}

impl<B> EngineGoalRepository for GoalStateRepository<'_, B>
where
    B: LocalStoreBackend,
{
    type Error = LocalStoreError;

    fn project_exists(&self, project_id: &ProjectId) -> Result<bool, Self::Error> {
        Ok(self
            .state
            .projects()
            .get(&PersistenceRecordId(project_id.0.clone()))?
            .is_some())
    }

    fn get_planning_record(
        &self,
        record_id: &PersistenceRecordId,
    ) -> Result<Option<EngineTaskRecord>, Self::Error> {
        Ok(self
            .state
            .planning()
            .get(record_id)?
            .map(engine_record_from_local))
    }

    fn put_planning_record(
        &self,
        record: EngineTaskRecord,
        revision: EngineRevisionExpectation,
    ) -> Result<(), Self::Error> {
        self.state
            .planning()
            .put(local_record_from_engine(record), local_revision(revision))?;
        Ok(())
    }

    fn get_task_record(
        &self,
        record_id: &PersistenceRecordId,
    ) -> Result<Option<EngineTaskRecord>, Self::Error> {
        Ok(self
            .state
            .tasks()
            .get(record_id)?
            .map(engine_record_from_local))
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
        domain: PersistenceDomain::Planning,
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

fn engine_goal_error(error: EngineGoalCommandError<LocalStoreError>) -> ServerControlError {
    match error {
        EngineGoalCommandError::InvalidRequest { reason } => {
            ServerControlError::InvalidRequest { reason }
        }
        EngineGoalCommandError::NotFound { reason } => ServerControlError::NotFound { reason },
        EngineGoalCommandError::Conflict { reason } => ServerControlError::Conflict { reason },
        EngineGoalCommandError::Codec { reason } => {
            ServerControlError::StorageUnavailable { reason }
        }
        EngineGoalCommandError::Storage(error) => local_store_error(error),
    }
}

fn local_store_error(error: LocalStoreError) -> ServerControlError {
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
