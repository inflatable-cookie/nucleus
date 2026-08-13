//! Engine run command service: lifecycle transitions over the run aggregate.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};

use super::helpers::{
    next_run_revision, now_unix_seconds, run_codec_error, storage_record_from_propose,
    validate_closeout, validate_propose, validate_transition,
};
use super::model::{
    decode_run_storage_record, encode_run_storage_record, EngineRunCommand,
    EngineRunCommandError, EngineRunCommandOutcome, EngineRunDeliverCommand,
    EngineRunDispatchCommand, EngineRunId, EngineRunLifecycleState, EngineRunProposeCommand,
    EngineRunRecord, EngineRunRepository, EngineRunStorageRecord, EngineRunTransitionCommand,
    EngineRunTransitionRecord,
};
use crate::EngineRevisionExpectation;

/// Engine run command service.
pub struct EngineRunCommandService<R> {
    pub(super) repository: R,
}

impl<R> EngineRunCommandService<R>
where
    R: EngineRunRepository,
{
    pub fn new(repository: R) -> Self {
        Self { repository }
    }

    pub fn execute(
        &self,
        command_id: &str,
        command: EngineRunCommand,
    ) -> Result<EngineRunCommandOutcome, EngineRunCommandError<R::Error>> {
        match command {
            EngineRunCommand::Propose(command) => self.propose_run(command_id, command),
            EngineRunCommand::Dispatch(command) => self.dispatch_run(command_id, command),
            EngineRunCommand::MarkRunning(command) => {
                self.transition_run(command_id, command, EngineRunLifecycleState::Running)
            }
            EngineRunCommand::Deliver(command) => self.deliver_run(command_id, command),
            EngineRunCommand::Accept(command) => {
                self.transition_run(command_id, command, EngineRunLifecycleState::Accepted)
            }
            EngineRunCommand::Reject(command) => {
                self.transition_run(command_id, command, EngineRunLifecycleState::Rejected)
            }
            EngineRunCommand::Fail(command) => {
                self.transition_run(command_id, command, EngineRunLifecycleState::Failed)
            }
            EngineRunCommand::Cancel(command) => {
                self.transition_run(command_id, command, EngineRunLifecycleState::Cancelled)
            }
        }
    }

    fn propose_run(
        &self,
        command_id: &str,
        command: EngineRunProposeCommand,
    ) -> Result<EngineRunCommandOutcome, EngineRunCommandError<R::Error>> {
        validate_propose::<R::Error>(&command)?;
        let record_id = PersistenceRecordId(command.run_id.0.clone());

        let at = now_unix_seconds();
        let mut storage = storage_record_from_propose(&command, at);
        storage.transitions.push(EngineRunTransitionRecord {
            command_id: command_id.to_owned(),
            from: None,
            to: EngineRunLifecycleState::Proposed,
            at,
        });

        let payload = encode_run_storage_record(&storage).map_err(run_codec_error)?;
        let record = EngineRunRecord {
            id: record_id,
            domain: PersistenceDomain::OrchestrationRuns,
            kind: PersistenceRecordKind::OrchestrationRun,
            revision_id: next_run_revision(command_id),
            payload,
        };

        self.repository
            .put_run(record, EngineRevisionExpectation::MustNotExist)
            .map_err(EngineRunCommandError::Storage)?;

        Ok(EngineRunCommandOutcome::Mutated {
            transition: storage.transitions.into_iter().next().expect("propose transition"),
        })
    }

    fn dispatch_run(
        &self,
        command_id: &str,
        command: EngineRunDispatchCommand,
    ) -> Result<EngineRunCommandOutcome, EngineRunCommandError<R::Error>> {
        let (mut storage, expected) = self.load_run(&command.run_id, command.expected_revision)?;
        validate_transition::<R::Error>(storage.state, EngineRunLifecycleState::Dispatched)?;

        storage.operation_id = command.operation_id;
        storage.conversation_id = command.conversation_id;
        self.save_transition(command_id, &mut storage, EngineRunLifecycleState::Dispatched, expected)
    }

    fn deliver_run(
        &self,
        command_id: &str,
        command: EngineRunDeliverCommand,
    ) -> Result<EngineRunCommandOutcome, EngineRunCommandError<R::Error>> {
        validate_closeout::<R::Error>(&command.closeout.summary)?;
        let (mut storage, expected) = self.load_run(&command.run_id, command.expected_revision)?;
        validate_transition::<R::Error>(storage.state, EngineRunLifecycleState::Delivered)?;

        storage.closeout = Some(command.closeout);
        self.save_transition(command_id, &mut storage, EngineRunLifecycleState::Delivered, expected)
    }

    fn transition_run(
        &self,
        command_id: &str,
        command: EngineRunTransitionCommand,
        to: EngineRunLifecycleState,
    ) -> Result<EngineRunCommandOutcome, EngineRunCommandError<R::Error>> {
        let (mut storage, expected) = self.load_run(&command.run_id, command.expected_revision)?;
        validate_transition::<R::Error>(storage.state, to)?;
        self.save_transition(command_id, &mut storage, to, expected)
    }

    fn load_run(
        &self,
        run_id: &EngineRunId,
        expected_revision: Option<RevisionId>,
    ) -> Result<(EngineRunStorageRecord, EngineRevisionExpectation), EngineRunCommandError<R::Error>>
    {
        let record_id = PersistenceRecordId(run_id.0.clone());
        let existing = self
            .repository
            .get_run(&record_id)
            .map_err(EngineRunCommandError::Storage)?
            .ok_or_else(|| EngineRunCommandError::NotFound {
                reason: format!("run record not found: {}", record_id.0),
            })?;

        if let Some(expected) = expected_revision.as_ref() {
            if &existing.revision_id != expected {
                return Err(EngineRunCommandError::Conflict {
                    reason: format!("run revision conflict for {}", record_id.0),
                });
            }
        }

        let decoded = decode_run_storage_record(&existing.payload).map_err(run_codec_error)?;
        let expectation = expected_revision
            .map(EngineRevisionExpectation::Exact)
            .unwrap_or(EngineRevisionExpectation::MustExist);
        Ok((decoded, expectation))
    }

    fn save_transition(
        &self,
        command_id: &str,
        storage: &mut EngineRunStorageRecord,
        to: EngineRunLifecycleState,
        expected: EngineRevisionExpectation,
    ) -> Result<EngineRunCommandOutcome, EngineRunCommandError<R::Error>> {
        let at = now_unix_seconds();
        let from = storage.state;
        storage.state = to;
        storage.updated_at = at;
        storage.transitions.push(EngineRunTransitionRecord {
            command_id: command_id.to_owned(),
            from: Some(from),
            to,
            at,
        });

        let payload = encode_run_storage_record(storage).map_err(run_codec_error)?;
        let record = EngineRunRecord {
            id: PersistenceRecordId(storage.run_id.0.clone()),
            domain: PersistenceDomain::OrchestrationRuns,
            kind: PersistenceRecordKind::OrchestrationRun,
            revision_id: next_run_revision(command_id),
            payload,
        };

        self.repository
            .put_run(record, expected)
            .map_err(EngineRunCommandError::Storage)?;

        Ok(EngineRunCommandOutcome::Mutated {
            transition: storage
                .transitions
                .last()
                .expect("transition appended")
                .clone(),
        })
    }
}
