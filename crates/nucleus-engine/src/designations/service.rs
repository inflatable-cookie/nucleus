//! Engine designation command service: designate and revoke over the
//! designation aggregate.

use nucleus_core::{PersistenceRecordId, PersistenceRecordKind, RevisionId};

use super::helpers::{
    designation_codec_error, next_designation_revision, now_unix_seconds,
    storage_designation_from_command, validate_designate,
};
use super::model::{
    decode_orchestrator_designation, encode_orchestrator_designation, EngineDesignateCommand,
    EngineOrchestratorDesignation, EngineOrchestratorDesignationCodecError,
    EngineOrchestratorDesignationCommand, EngineOrchestratorDesignationCommandError,
    EngineOrchestratorDesignationCommandOutcome, EngineOrchestratorDesignationId,
    EngineOrchestratorDesignationRecord, EngineOrchestratorDesignationRepository,
    EngineOrchestratorDesignationStatus, EngineRevokeDesignationCommand,
};
use crate::EngineRevisionExpectation;

/// Engine designation command service.
#[derive(Debug)]
pub struct EngineOrchestratorDesignationService<R> {
    pub(super) repository: R,
}

impl<R> EngineOrchestratorDesignationService<R>
where
    R: EngineOrchestratorDesignationRepository,
{
    pub fn new(repository: R) -> Self {
        Self { repository }
    }

    pub fn execute(
        &self,
        command_id: &str,
        command: EngineOrchestratorDesignationCommand,
    ) -> Result<EngineOrchestratorDesignationCommandOutcome, EngineOrchestratorDesignationCommandError<R::Error>>
    {
        match command {
            EngineOrchestratorDesignationCommand::Designate(command) => {
                self.designate(command_id, command)
            }
            EngineOrchestratorDesignationCommand::Revoke(command) => {
                self.revoke(command_id, command)
            }
        }
    }

    fn designate(
        &self,
        command_id: &str,
        command: EngineDesignateCommand,
    ) -> Result<EngineOrchestratorDesignationCommandOutcome, EngineOrchestratorDesignationCommandError<R::Error>>
    {
        validate_designate::<R::Error>(&command)?;
        let at = now_unix_seconds();
        let designation = storage_designation_from_command(&command, at);
        let payload = encode_orchestrator_designation(&designation).map_err(designation_codec_error)?;
        let record = EngineOrchestratorDesignationRecord {
            id: PersistenceRecordId(command.designation_id.0.clone()),
            kind: PersistenceRecordKind::OrchestratorDesignation,
            revision_id: next_designation_revision(command_id),
            payload,
        };

        let revision = match command.expected_revision {
            None => EngineRevisionExpectation::MustNotExist,
            Some(expected) => EngineRevisionExpectation::Exact(expected),
        };
        self.repository
            .put_designation(record, revision)
            .map_err(EngineOrchestratorDesignationCommandError::Storage)?;

        Ok(EngineOrchestratorDesignationCommandOutcome::Designated { designation })
    }

    fn revoke(
        &self,
        command_id: &str,
        command: EngineRevokeDesignationCommand,
    ) -> Result<EngineOrchestratorDesignationCommandOutcome, EngineOrchestratorDesignationCommandError<R::Error>>
    {
        let record_id = PersistenceRecordId(command.designation_id.0.clone());
        let existing = self
            .repository
            .get_designation(&record_id)
            .map_err(EngineOrchestratorDesignationCommandError::Storage)?
            .ok_or_else(|| EngineOrchestratorDesignationCommandError::NotFound {
                reason: format!("designation record not found: {}", record_id.0),
            })?;

        if let Some(expected) = command.expected_revision.as_ref() {
            if &existing.revision_id != expected {
                return Err(EngineOrchestratorDesignationCommandError::Conflict {
                    reason: format!("designation revision conflict for {}", record_id.0),
                });
            }
        }

        let mut designation =
            decode_orchestrator_designation(&existing.payload).map_err(designation_codec_error)?;
        if designation.status == EngineOrchestratorDesignationStatus::Revoked {
            return Err(EngineOrchestratorDesignationCommandError::InvalidRequest {
                reason: format!("designation is already revoked: {}", record_id.0),
            });
        }
        designation.status = EngineOrchestratorDesignationStatus::Revoked;
        designation.updated_at = now_unix_seconds();

        let payload = encode_orchestrator_designation(&designation).map_err(designation_codec_error)?;
        let record = EngineOrchestratorDesignationRecord {
            id: record_id,
            kind: PersistenceRecordKind::OrchestratorDesignation,
            revision_id: next_designation_revision(command_id),
            payload,
        };

        let expectation = match command.expected_revision {
            None => EngineRevisionExpectation::MustExist,
            Some(expected) => EngineRevisionExpectation::Exact(expected),
        };
        self.repository
            .put_designation(record, expectation)
            .map_err(EngineOrchestratorDesignationCommandError::Storage)?;

        Ok(EngineOrchestratorDesignationCommandOutcome::Revoked { designation })
    }
}

/// Read a designation payload from an optional storage record.
pub fn designation_from_record(
    record: &EngineOrchestratorDesignationRecord,
) -> Result<EngineOrchestratorDesignation, EngineOrchestratorDesignationCodecError> {
    decode_orchestrator_designation(&record.payload)
}

/// Look up a designation record by id (helper for host adapters).
pub fn designation_record_id(
    designation_id: &EngineOrchestratorDesignationId,
) -> PersistenceRecordId {
    PersistenceRecordId(designation_id.0.clone())
}

/// Read the persisted revision of a designation record.
pub fn designation_revision(record: &EngineOrchestratorDesignationRecord) -> &RevisionId {
    &record.revision_id
}
