//! Engine task command service.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind};
use nucleus_tasks::{
    decode_task_storage_record, encode_task_storage_payload, encode_task_storage_record,
    TaskStorageActivityState,
};

use super::helpers::{
    apply_task_update_changes, next_task_revision, task_codec_error, task_from_create_command,
    validate_agent_readiness, validate_agent_ready_storage, validate_create_activity,
    validate_project_exists, validate_task_title,
};
use super::model::{
    EngineRevisionExpectation, EngineTaskCommand, EngineTaskCommandError, EngineTaskCommandOutcome,
    EngineTaskCreateCommand, EngineTaskRecord, EngineTaskRepository, EngineTaskTransitionCommand,
    EngineTaskUpdateCommand,
};

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
