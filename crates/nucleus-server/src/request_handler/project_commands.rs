//! Project command adapter: DTO mapping plus the storage/receipt port.
//! Canonical lifecycle rules live in `nucleus_engine::project_commands`
//! (contract 022); resource commands stay host-side (filesystem authority).

use nucleus_core::{PersistenceDomain, PersistenceRecordId};
use nucleus_engine::{
    EngineProjectCommand, EngineProjectCommandError, EngineProjectCommandService,
    EngineProjectCreateCommand, EngineProjectLifecycleAction, EngineProjectLifecycleCommand,
    EngineProjectLifecycleReceipt, EngineProjectRepository, EngineProjectRetentionChoice,
    EngineProjectScanDomain, EngineRevisionExpectation, EngineTaskRecord,
};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    RevisionExpectation,
};

use super::handler::LocalControlRequestHandler;
use crate::commands::{ProjectCommand, ProjectLifecycleAction};
use crate::control_api::{ServerCommandReceiptStatus, ServerControlError};
use crate::project_lifecycle::{
    persist_project_lifecycle_receipt, read_project_lifecycle_receipt,
    ProjectLifecycleReceiptRecord,
};
use crate::state::ServerStateService;

pub(crate) fn handle_project_command<B>(
    handler: &LocalControlRequestHandler<B>,
    command_id: &str,
    command: ProjectCommand,
) -> ServerCommandReceiptStatus
where
    B: LocalStoreBackend + Clone,
{
    let result = match command {
        ProjectCommand::Create(command) => run_engine_command(
            handler,
            command_id,
            EngineProjectCommand::Create(EngineProjectCreateCommand {
                display_name: command.display_name,
                retention: if command.transient {
                    EngineProjectRetentionChoice::Transient
                } else {
                    EngineProjectRetentionChoice::Durable
                },
                actor_ref: command.actor_ref,
                authority_host_ref: command.authority_host_ref,
                idempotency_key: command.idempotency_key,
            }),
        ),
        ProjectCommand::Lifecycle(command) => run_engine_command(
            handler,
            command_id,
            EngineProjectCommand::Lifecycle(EngineProjectLifecycleCommand {
                project_id: command.project_id,
                expected_revision: command.expected_revision,
                action: engine_action(command.action),
                actor_ref: command.actor_ref,
                authority_host_ref: command.authority_host_ref,
                idempotency_key: command.idempotency_key,
            }),
        ),
        ProjectCommand::Resource(command) => {
            super::project_resource_commands::mutate_project_resource(handler, command_id, command)
        }
    };
    match result {
        Ok(()) => ServerCommandReceiptStatus::AcceptedForStateMutation,
        Err(error) => ServerCommandReceiptStatus::Rejected(error),
    }
}

/// Spec 012 durable-child admission: creating a durable child (task, goal)
/// on a transient project promotes the project in place first, so the child
/// can never be orphaned by transient expiry. Promotion is receipted like
/// any lifecycle action.
pub(crate) fn ensure_project_durable<B>(
    handler: &LocalControlRequestHandler<B>,
    command_id: &str,
    project_id: &nucleus_projects::ProjectId,
) -> Result<(), ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let record_id = PersistenceRecordId(project_id.0.clone());
    let Some(record) = handler
        .state()
        .projects()
        .get(&record_id)
        .map_err(|error| engine_project_error(EngineProjectCommandError::Storage(error)))?
    else {
        // Missing project surfaces through the child command's own checks.
        return Ok(());
    };
    let mut project = nucleus_projects::decode_project_storage_record(&record.payload.bytes)
        .map_err(|error| ServerControlError::StorageUnavailable {
            reason: error.reason,
        })?;
    if project.retention != nucleus_projects::ProjectRetentionStorage::Transient {
        return Ok(());
    }
    project.retention = nucleus_projects::ProjectRetentionStorage::Durable;
    let revision = nucleus_core::RevisionId(format!("rev:project-promote:{command_id}"));
    let payload = nucleus_projects::encode_project_storage_payload(&project).map_err(|error| {
        ServerControlError::StorageUnavailable {
            reason: error.reason,
        }
    })?;
    handler
        .state()
        .projects()
        .put(
            LocalStoreRecord {
                id: record_id,
                domain: PersistenceDomain::Projects,
                kind: record.kind,
                revision_id: revision.clone(),
                payload: LocalStoreRecordPayload {
                    media_type: Some("application/json".to_owned()),
                    bytes: payload,
                },
            },
            RevisionExpectation::Exact(record.revision_id.clone()),
        )
        .map_err(|error| engine_project_error(EngineProjectCommandError::Storage(error)))?;
    persist_project_lifecycle_receipt(
        handler.state(),
        &ProjectLifecycleReceiptRecord::applied(
            command_id,
            format!("auto-promote:{command_id}"),
            String::new(),
            project.project_id.clone(),
            "promote".to_owned(),
            "system:durable-child-admission".to_owned(),
            handler.authority_host_id().0.clone(),
            Some(record.revision_id.0),
            Some(revision.0),
        ),
    )
    .map_err(|error| engine_project_error(EngineProjectCommandError::Storage(error)))
}

fn run_engine_command<B>(
    handler: &LocalControlRequestHandler<B>,
    command_id: &str,
    command: EngineProjectCommand,
) -> Result<(), ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let repository = ProjectStateRepository {
        state: handler.state(),
        authority_host_ref: handler.authority_host_id().0.clone(),
    };
    EngineProjectCommandService::new(repository)
        .execute(command_id, command)
        .map_err(engine_project_error)
}

fn engine_action(action: ProjectLifecycleAction) -> EngineProjectLifecycleAction {
    match action {
        ProjectLifecycleAction::Rename { display_name } => {
            EngineProjectLifecycleAction::Rename { display_name }
        }
        ProjectLifecycleAction::Park => EngineProjectLifecycleAction::Park,
        ProjectLifecycleAction::Archive => EngineProjectLifecycleAction::Archive,
        ProjectLifecycleAction::Restore => EngineProjectLifecycleAction::Restore,
        ProjectLifecycleAction::Delete => EngineProjectLifecycleAction::Delete,
        ProjectLifecycleAction::Promote { display_name } => {
            EngineProjectLifecycleAction::Promote { display_name }
        }
        ProjectLifecycleAction::ExpireTransient => EngineProjectLifecycleAction::ExpireTransient,
    }
}

struct ProjectStateRepository<'a, B> {
    state: &'a ServerStateService<B>,
    authority_host_ref: String,
}

impl<B> EngineProjectRepository for ProjectStateRepository<'_, B>
where
    B: LocalStoreBackend,
{
    type Error = LocalStoreError;

    fn authority_host_ref(&self) -> String {
        self.authority_host_ref.clone()
    }

    fn get_project_record(
        &self,
        record_id: &PersistenceRecordId,
    ) -> Result<Option<EngineTaskRecord>, Self::Error> {
        Ok(self
            .state
            .projects()
            .get(record_id)?
            .map(|record| EngineTaskRecord {
                id: record.id,
                domain: record.domain,
                kind: record.kind,
                revision_id: record.revision_id,
                payload: record.payload.bytes,
            }))
    }

    fn put_project_record(
        &self,
        record: EngineTaskRecord,
        revision: EngineRevisionExpectation,
    ) -> Result<(), Self::Error> {
        self.state.projects().put(
            LocalStoreRecord {
                id: record.id,
                domain: PersistenceDomain::Projects,
                kind: record.kind,
                revision_id: record.revision_id,
                payload: LocalStoreRecordPayload {
                    media_type: Some("application/json".to_owned()),
                    bytes: record.payload,
                },
            },
            local_revision(revision),
        )?;
        Ok(())
    }

    fn delete_project_record(
        &self,
        record_id: &PersistenceRecordId,
        revision: EngineRevisionExpectation,
    ) -> Result<(), Self::Error> {
        self.state
            .projects()
            .delete(record_id, local_revision(revision))
    }

    fn domain_payloads(
        &self,
        domain: EngineProjectScanDomain,
    ) -> Result<Vec<(String, String, Vec<u8>)>, Self::Error> {
        let records = match domain {
            EngineProjectScanDomain::Tasks => self.state.tasks().list()?,
            EngineProjectScanDomain::Planning => self.state.planning().list()?,
            EngineProjectScanDomain::SharedMemory => self.state.shared_memory().list()?,
            EngineProjectScanDomain::AgentSessions => self.state.agent_sessions().list()?,
            EngineProjectScanDomain::DeepResearch => self.state.deep_research().list()?,
            EngineProjectScanDomain::Workspaces => self.state.workspaces().list()?,
        };
        Ok(records
            .into_iter()
            .map(|record| {
                (
                    record.id.0,
                    format!("{:?}", record.kind),
                    record.payload.bytes,
                )
            })
            .collect())
    }

    fn receipt_fingerprint(&self, idempotency_key: &str) -> Result<Option<String>, Self::Error> {
        Ok(read_project_lifecycle_receipt(self.state, idempotency_key)?
            .map(|receipt| receipt.request_fingerprint))
    }

    fn persist_receipt(&self, receipt: EngineProjectLifecycleReceipt) -> Result<(), Self::Error> {
        persist_project_lifecycle_receipt(
            self.state,
            &ProjectLifecycleReceiptRecord::applied(
                &receipt.command_id,
                receipt.idempotency_key,
                receipt.request_fingerprint,
                receipt.project_id,
                receipt.action,
                receipt.actor_ref,
                receipt.authority_host_ref,
                receipt.previous_revision,
                receipt.resulting_revision,
            ),
        )
    }
}

fn local_revision(revision: EngineRevisionExpectation) -> RevisionExpectation {
    match revision {
        EngineRevisionExpectation::MustNotExist => RevisionExpectation::MustNotExist,
        EngineRevisionExpectation::MustExist => RevisionExpectation::MustExist,
        EngineRevisionExpectation::Exact(revision) => RevisionExpectation::Exact(revision),
    }
}

fn engine_project_error(error: EngineProjectCommandError<LocalStoreError>) -> ServerControlError {
    match error {
        EngineProjectCommandError::InvalidRequest { reason } => {
            ServerControlError::InvalidRequest { reason }
        }
        EngineProjectCommandError::NotFound { reason } => ServerControlError::NotFound { reason },
        EngineProjectCommandError::Conflict { reason } => ServerControlError::Conflict { reason },
        EngineProjectCommandError::Unauthorized { reason } => {
            ServerControlError::Unauthorized { reason }
        }
        EngineProjectCommandError::Codec { reason } => {
            ServerControlError::StorageUnavailable { reason }
        }
        EngineProjectCommandError::Storage(error) => match error {
            LocalStoreError::RevisionConflict(_) => ServerControlError::Conflict {
                reason: "project lifecycle storage revision conflict".to_owned(),
            },
            other => ServerControlError::StorageUnavailable {
                reason: format!("{other:?}"),
            },
        },
    }
}
