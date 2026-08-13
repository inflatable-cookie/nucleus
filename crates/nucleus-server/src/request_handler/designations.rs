//! Server-owned orchestrator designation command wiring.
//!
//! Designate and revoke ride the contract-018 spine (family
//! `OrchestratorDesignation`, target = designation id): the engine service
//! persists the designation aggregate, and a contract-020 runtime receipt
//! records every accepted command (contract 033 Audit Rule).

use nucleus_core::{PersistenceRecordId, RevisionId};
use nucleus_engine::{
    decode_orchestrator_designation, EngineDesignateCommand,
    EngineOrchestratorDesignation, EngineOrchestratorDesignationCommand,
    EngineOrchestratorDesignationCommandError, EngineOrchestratorDesignationCommandOutcome,
    EngineOrchestratorDesignationId, EngineOrchestratorDesignationRecord,
    EngineOrchestratorDesignationRepository, EngineOrchestratorDesignationService,
    EngineRevokeDesignationCommand, EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptRecord,
    EngineRuntimeReceiptRecordId, EngineRuntimeReceiptRef, EngineRuntimeReceiptStatus,
};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    RevisionExpectation,
};

use super::handler::LocalControlRequestHandler;
use crate::commands::{
    OrchestratorDesignateCommand, OrchestratorDesignationCommand,
};
use crate::control_api::{ServerCommandReceiptStatus, ServerControlError};
use crate::runtime_receipt_state::write_runtime_receipt;
use crate::state::ServerStateService;

pub(crate) fn handle_orchestrator_designation_command<B>(
    handler: &LocalControlRequestHandler<B>,
    command_id: &str,
    command: OrchestratorDesignationCommand,
) -> ServerCommandReceiptStatus
where
    B: LocalStoreBackend + Clone,
{
    let designation_id = match &command {
        OrchestratorDesignationCommand::Designate(command) => {
            command.designation_id.clone()
        }
        OrchestratorDesignationCommand::Revoke(command) => command.designation_id.clone(),
    };
    let repository = ServerDesignationRepository::new(handler.state());
    let service = EngineOrchestratorDesignationService::new(repository);

    match service.execute(command_id, engine_designation_command(command)) {
        Ok(outcome) => {
            let status_label = match &outcome {
                EngineOrchestratorDesignationCommandOutcome::Designated { .. } => "designated",
                EngineOrchestratorDesignationCommandOutcome::Revoked { .. } => "revoked",
            };
            match write_designation_receipt(
                handler.state(),
                command_id,
                &designation_id,
                status_label,
            ) {
                Ok(()) => ServerCommandReceiptStatus::AcceptedForStateMutation,
                Err(error) => ServerCommandReceiptStatus::Rejected(error),
            }
        }
        Err(error) => ServerCommandReceiptStatus::Rejected(designation_error(error)),
    }
}

/// Write the contract-020 receipt for one accepted designation command.
fn write_designation_receipt<B>(
    state: &ServerStateService<B>,
    command_id: &str,
    designation_id: &str,
    status_label: &str,
) -> Result<(), ServerControlError>
where
    B: LocalStoreBackend,
{
    let receipt = EngineRuntimeReceiptRecord {
        receipt_id: EngineRuntimeReceiptRecordId(format!(
            "receipt:designation:{designation_id}:{command_id}"
        )),
        family: EngineRuntimeReceiptEffectFamily::CommandExecution,
        status: EngineRuntimeReceiptStatus::Completed,
        command_ref: Some(EngineRuntimeReceiptRef::CommandId(command_id.to_owned())),
        effect_ref: Some(EngineRuntimeReceiptRef::Custom(format!(
            "designation:{designation_id}:{status_label}"
        ))),
        evidence_refs: vec![EngineRuntimeReceiptRef::EventId(format!(
            "event:{command_id}:admitted"
        ))],
        artifact_refs: Vec::new(),
        summary: Some(format!(
            "orchestrator designation {designation_id} {status_label} by command {command_id}"
        )),
    };

    write_runtime_receipt(
        state,
        &receipt,
        RevisionId(format!("rev:receipt:designation:{command_id}")),
        RevisionExpectation::MustNotExist,
    )
    .map(|_| ())
    .map_err(local_store_error)
}

fn engine_designation_command(
    command: OrchestratorDesignationCommand,
) -> EngineOrchestratorDesignationCommand {
    match command {
        OrchestratorDesignationCommand::Designate(command) => {
            EngineOrchestratorDesignationCommand::Designate(engine_designate_command(command))
        }
        OrchestratorDesignationCommand::Revoke(command) => {
            EngineOrchestratorDesignationCommand::Revoke(EngineRevokeDesignationCommand {
                designation_id: EngineOrchestratorDesignationId(command.designation_id),
                expected_revision: command.expected_revision,
            })
        }
    }
}

fn engine_designate_command(
    command: OrchestratorDesignateCommand,
) -> EngineDesignateCommand {
    EngineDesignateCommand {
        designation_id: EngineOrchestratorDesignationId(command.designation_id),
        project_id: command.project_id.0,
        orchestrator_provider_instance: command.orchestrator_provider_instance,
        allowed_worker_provider_instances: command.allowed_worker_provider_instances,
        allowed_worker_models: command.allowed_worker_models,
        concurrent_run_budget: command.concurrent_run_budget,
        per_run_token_budget: command.per_run_token_budget,
        per_run_time_budget_seconds: command.per_run_time_budget_seconds,
        allowed_actions: command.allowed_actions,
        steering_permitted: command.steering_permitted,
        expected_revision: command.expected_revision,
    }
}

struct ServerDesignationRepository<'a, B>
where
    B: LocalStoreBackend,
{
    state: &'a ServerStateService<B>,
}

impl<'a, B> ServerDesignationRepository<'a, B>
where
    B: LocalStoreBackend,
{
    fn new(state: &'a ServerStateService<B>) -> Self {
        Self { state }
    }
}

impl<B> EngineOrchestratorDesignationRepository for ServerDesignationRepository<'_, B>
where
    B: LocalStoreBackend,
{
    type Error = LocalStoreError;

    fn get_designation(
        &self,
        designation_id: &PersistenceRecordId,
    ) -> Result<Option<EngineOrchestratorDesignationRecord>, Self::Error> {
        self.state
            .orchestrator_designations()
            .get(designation_id)
            .map(|record| record.map(engine_record_from_local))
    }

    fn put_designation(
        &self,
        record: EngineOrchestratorDesignationRecord,
        revision: nucleus_engine::EngineRevisionExpectation,
    ) -> Result<(), Self::Error> {
        self.state.orchestrator_designations().put(
            local_record_from_engine(record),
            local_revision(revision),
        )?;
        Ok(())
    }
}

fn engine_record_from_local(
    record: LocalStoreRecord,
) -> EngineOrchestratorDesignationRecord {
    EngineOrchestratorDesignationRecord {
        id: record.id,
        kind: record.kind,
        revision_id: record.revision_id,
        payload: record.payload.bytes,
    }
}

fn local_record_from_engine(
    record: EngineOrchestratorDesignationRecord,
) -> LocalStoreRecord {
    LocalStoreRecord {
        id: record.id,
        domain: nucleus_core::PersistenceDomain::OrchestratorDesignations,
        kind: record.kind,
        revision_id: record.revision_id,
        payload: LocalStoreRecordPayload {
            media_type: Some("application/json".to_owned()),
            bytes: record.payload,
        },
    }
}

fn local_revision(
    revision: nucleus_engine::EngineRevisionExpectation,
) -> RevisionExpectation {
    match revision {
        nucleus_engine::EngineRevisionExpectation::MustNotExist => {
            RevisionExpectation::MustNotExist
        }
        nucleus_engine::EngineRevisionExpectation::MustExist => RevisionExpectation::MustExist,
        nucleus_engine::EngineRevisionExpectation::Exact(revision) => {
            RevisionExpectation::Exact(revision)
        }
    }
}

fn designation_error(
    error: EngineOrchestratorDesignationCommandError<LocalStoreError>,
) -> ServerControlError {
    match error {
        EngineOrchestratorDesignationCommandError::InvalidRequest { reason } => {
            ServerControlError::InvalidRequest { reason }
        }
        EngineOrchestratorDesignationCommandError::NotFound { reason } => {
            ServerControlError::NotFound { reason }
        }
        EngineOrchestratorDesignationCommandError::Conflict { reason } => {
            ServerControlError::Conflict { reason }
        }
        EngineOrchestratorDesignationCommandError::Storage(error) => local_store_error(error),
    }
}

fn local_store_error(error: LocalStoreError) -> ServerControlError {
    match error {
        LocalStoreError::RecordNotFound { record_id } => ServerControlError::NotFound {
            reason: format!("designation record not found: {}", record_id.0),
        },
        LocalStoreError::RevisionConflict(conflict) => ServerControlError::Conflict {
            reason: format!("designation revision conflict for {}", conflict.record_id.0),
        },
        LocalStoreError::InvalidRecord { reason } => ServerControlError::InvalidRequest {
            reason: format!("designation storage payload is invalid: {reason}"),
        },
        LocalStoreError::UnsupportedDomain { domain } => ServerControlError::Unsupported {
            reason: format!("unsupported storage domain: {domain:?}"),
        },
        LocalStoreError::UnsupportedRecordKind { reason } => {
            ServerControlError::Unsupported { reason }
        }
        LocalStoreError::DuplicateRecord { record_id } => ServerControlError::Conflict {
            reason: format!("duplicate designation record: {}", record_id.0),
        },
        LocalStoreError::Unavailable { reason }
        | LocalStoreError::TransactionRejected { reason }
        | LocalStoreError::BackendBusy { reason }
        | LocalStoreError::BackendRejected { reason } => {
            ServerControlError::StorageUnavailable { reason }
        }
    }
}

/// List designation records for a project (any status), decoded, newest
/// first by designation id. Used by the designation query surface.
pub(crate) fn load_project_designations<B>(
    state: &ServerStateService<B>,
    project_id: &str,
) -> Result<Vec<EngineOrchestratorDesignation>, String>
where
    B: LocalStoreBackend,
{
    let mut designations = Vec::new();
    for record in state
        .orchestrator_designations()
        .list()
        .map_err(|error| format!("designation listing failed: {error:?}"))?
    {
        let designation = decode_orchestrator_designation(&record.payload.bytes)
            .map_err(|error| format!("designation payload decode failed: {error:?}"))?;
        if designation.project_id == project_id {
            designations.push(designation);
        }
    }
    designations.sort_by(|left, right| right.designation_id.cmp(&left.designation_id));
    Ok(designations)
}

/// The active designation whose orchestrator provider instance matches the
/// session route, if any. A session is an orchestrator session exactly when
/// this returns `Some` (contract 033 Orchestrator Designation Rule).
pub(crate) fn active_designation_for_instance<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    provider_instance_id: &str,
) -> Result<Option<EngineOrchestratorDesignation>, String>
where
    B: LocalStoreBackend,
{
    for designation in load_project_designations(state, project_id)? {
        if designation.status == nucleus_engine::EngineOrchestratorDesignationStatus::Active
            && designation.orchestrator_provider_instance == provider_instance_id
        {
            return Ok(Some(designation));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_core::{PersistenceDomain, PersistenceRecordKind};
    use nucleus_engine::EngineOrchestratorDesignationStatus;
    use nucleus_local_store::SqliteBackend;
    use nucleus_orchestration::{
        decode_orchestration_event_store_record, OrchestrationCommandFamily,
        OrchestrationEventKind,
    };
    use nucleus_projects::{ImportanceLevel, ProjectId};

    use crate::commands::{
        OrchestratorDesignateCommand, OrchestratorDesignationCommand, ServerCommand,
        ServerCommandKind,
    };
    use crate::control_api::{
        ServerCommandReceipt, ServerCommandReceiptStatus, ServerControlError,
        ServerControlResponseBody, ServerControlResponseStatus,
    };
    use crate::ids::{ClientId, ServerCommandId, ServerControlRequestId};
    use crate::project_seed::{seed_local_project, LocalProjectSeed};
    use crate::request_handler::LocalControlRequestHandler;
    use crate::runtime_receipt_state::read_runtime_receipts;
    use crate::{ServerControlRequest, ServerControlRequestKind};

    const PROJECT_ID: &str = "project:designation-fixture";
    const DESIGNATION_ID: &str = "designation:project:designation-fixture:codex:local-default";

    fn handler() -> (tempfile::TempDir, LocalControlRequestHandler<SqliteBackend>) {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        (temp_dir, LocalControlRequestHandler::new(backend, None))
    }

    fn seed_project(handler: &LocalControlRequestHandler<SqliteBackend>) {
        seed_local_project(
            handler.state(),
            LocalProjectSeed {
                project_id: PROJECT_ID.to_owned(),
                display_name: "Designation Fixture".to_owned(),
                importance_level: ImportanceLevel::Normal,
            },
        )
        .expect("seed project");
    }

    fn designate_command(
        command_id: &str,
        expected_revision: Option<nucleus_core::RevisionId>,
    ) -> ServerCommand {
        ServerCommand {
            id: ServerCommandId(command_id.to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::OrchestratorDesignation(
                OrchestratorDesignationCommand::Designate(OrchestratorDesignateCommand {
                    designation_id: DESIGNATION_ID.to_owned(),
                    project_id: ProjectId(PROJECT_ID.to_owned()),
                    orchestrator_provider_instance: "codex:local-default".to_owned(),
                    allowed_worker_provider_instances: Some(vec!["codex:local-default".to_owned()]),
                    allowed_worker_models: Some(vec!["gpt-5.4-mini".to_owned()]),
                    concurrent_run_budget: 2,
                    per_run_token_budget: Some(100_000),
                    per_run_time_budget_seconds: Some(3600),
                    allowed_actions: vec![nucleus_engine::EngineDelegationAction::Delegate],
                    steering_permitted: false,
                    expected_revision,
                }),
            ),
        }
    }

    fn request(command: ServerCommand) -> ServerControlRequest {
        ServerControlRequest {
            id: ServerControlRequestId(format!("request:{}", command.id.0)),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerControlRequestKind::Command(command),
        }
    }

    #[test]
    fn designate_admits_and_records_event_and_receipt() {
        let (_temp, mut handler) = handler();
        seed_project(&handler);

        let response = handler.handle(request(designate_command("command:designate:fixture", None)));
        assert_eq!(response.status, ServerControlResponseStatus::Accepted);
        assert!(matches!(
            response.body,
            ServerControlResponseBody::Command(ServerCommandReceipt {
                status: ServerCommandReceiptStatus::AcceptedForStateMutation,
                ..
            })
        ));

        let record = handler
            .state()
            .orchestrator_designations()
            .get(&nucleus_core::PersistenceRecordId(DESIGNATION_ID.to_owned()))
            .expect("designation get")
            .expect("designation record");
        assert_eq!(record.kind, PersistenceRecordKind::OrchestratorDesignation);
        let designation = decode_orchestrator_designation(&record.payload.bytes).expect("decode");
        assert_eq!(designation.status, EngineOrchestratorDesignationStatus::Active);
        assert_eq!(designation.concurrent_run_budget, 2);
        assert_eq!(designation.allowed_actions, vec![
            nucleus_engine::EngineDelegationAction::Delegate
        ]);

        // Spine event: family OrchestratorDesignation, target = designation id.
        let events = handler.state().event_journal().list_in_insertion_order().expect("events");
        assert_eq!(events.len(), 1);
        let event =
            decode_orchestration_event_store_record(&events[0].payload.bytes).expect("decode");
        let event = event.into_payload();
        assert_eq!(event.kind, OrchestrationEventKind::CommandAdmitted);
        assert_eq!(event.family, OrchestrationCommandFamily::OrchestratorDesignation);
        assert_eq!(event.command_id.0, "command:designate:fixture");
        assert_eq!(event.target_ref.as_deref(), Some(DESIGNATION_ID));

        // Contract-020 receipt records the admission.
        let receipts = read_runtime_receipts(&handler.state()).expect("receipts");
        assert_eq!(receipts.len(), 1);
        assert_eq!(
            receipts[0].receipt_id.0,
            format!("receipt:designation:{DESIGNATION_ID}:command:designate:fixture")
        );
        assert!(receipts[0]
            .summary
            .as_deref()
            .is_some_and(|summary| summary.contains("designated")));
    }

    #[test]
    fn revoke_blocks_new_delegation_and_rejects_double_revoke() {
        let (_temp, mut handler) = handler();
        seed_project(&handler);
        assert_eq!(
            handler.handle(request(designate_command("command:designate:fixture", None))).status,
            ServerControlResponseStatus::Accepted
        );

        let revoke = ServerCommand {
            id: ServerCommandId("command:revoke:fixture".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::OrchestratorDesignation(
                OrchestratorDesignationCommand::Revoke(
                    crate::commands::OrchestratorRevokeDesignationCommand {
                        designation_id: DESIGNATION_ID.to_owned(),
                        expected_revision: None,
                    },
                ),
            ),
        };
        let response = handler.handle(request(revoke));
        assert_eq!(response.status, ServerControlResponseStatus::Accepted);

        let record = handler
            .state()
            .orchestrator_designations()
            .get(&nucleus_core::PersistenceRecordId(DESIGNATION_ID.to_owned()))
            .expect("designation get")
            .expect("designation record");
        let designation = decode_orchestrator_designation(&record.payload.bytes).expect("decode");
        assert_eq!(designation.status, EngineOrchestratorDesignationStatus::Revoked);

        // Revoking again is rejected: revocation is recorded once.
        let revoke_again = ServerCommand {
            id: ServerCommandId("command:revoke:again".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::OrchestratorDesignation(
                OrchestratorDesignationCommand::Revoke(
                    crate::commands::OrchestratorRevokeDesignationCommand {
                        designation_id: DESIGNATION_ID.to_owned(),
                        expected_revision: None,
                    },
                ),
            ),
        };
        let response = handler.handle(request(revoke_again));
        assert_eq!(response.status, ServerControlResponseStatus::Rejected);
        assert!(matches!(
            response.body,
            ServerControlResponseBody::Command(ServerCommandReceipt {
                status: ServerCommandReceiptStatus::Rejected(ServerControlError::InvalidRequest {
                    ..
                }),
                ..
            })
        ));
    }

    #[test]
    fn duplicate_designate_without_revision_is_conflict() {
        let (_temp, mut handler) = handler();
        seed_project(&handler);
        assert_eq!(
            handler.handle(request(designate_command("command:designate:fixture", None))).status,
            ServerControlResponseStatus::Accepted
        );
        let response = handler.handle(request(designate_command(
            "command:designate:fixture:2",
            None,
        )));
        assert_eq!(response.status, ServerControlResponseStatus::Rejected);
        assert!(matches!(
            response.body,
            ServerControlResponseBody::Command(ServerCommandReceipt {
                status: ServerCommandReceiptStatus::Rejected(ServerControlError::Conflict { .. }),
                ..
            })
        ));
    }

    #[test]
    fn redesignate_replaces_envelope_at_recorded_revision() {
        let (_temp, mut handler) = handler();
        seed_project(&handler);
        assert_eq!(
            handler.handle(request(designate_command("command:designate:fixture", None))).status,
            ServerControlResponseStatus::Accepted
        );
        let record = handler
            .state()
            .orchestrator_designations()
            .get(&nucleus_core::PersistenceRecordId(DESIGNATION_ID.to_owned()))
            .expect("designation get")
            .expect("designation record");
        let revision = record.revision_id.clone();

        let mut replacement = designate_command("command:designate:replacement", Some(revision.clone()));
        replacement.kind = ServerCommandKind::OrchestratorDesignation(
            OrchestratorDesignationCommand::Designate(OrchestratorDesignateCommand {
                designation_id: DESIGNATION_ID.to_owned(),
                project_id: ProjectId(PROJECT_ID.to_owned()),
                orchestrator_provider_instance: "codex:local-default".to_owned(),
                allowed_worker_provider_instances: Some(vec!["codex:local-default".to_owned()]),
                allowed_worker_models: None,
                concurrent_run_budget: 4,
                per_run_token_budget: None,
                per_run_time_budget_seconds: None,
                allowed_actions: vec![
                    nucleus_engine::EngineDelegationAction::Delegate,
                    nucleus_engine::EngineDelegationAction::RunStatus,
                ],
                steering_permitted: false,
                expected_revision: Some(revision),
            }),
        );
        let response = handler.handle(request(replacement));
        assert_eq!(response.status, ServerControlResponseStatus::Accepted);

        let record = handler
            .state()
            .orchestrator_designations()
            .get(&nucleus_core::PersistenceRecordId(DESIGNATION_ID.to_owned()))
            .expect("designation get")
            .expect("designation record");
        let designation = decode_orchestrator_designation(&record.payload.bytes).expect("decode");
        assert_eq!(designation.concurrent_run_budget, 4);
        assert_eq!(designation.allowed_worker_models, None);
    }

    #[test]
    fn revoked_designation_stops_session_delegation() {
        let (_temp, mut handler) = handler();
        seed_project(&handler);
        assert_eq!(
            handler.handle(request(designate_command("command:designate:fixture", None))).status,
            ServerControlResponseStatus::Accepted
        );
        let active = active_designation_for_instance(
            &handler.state(),
            PROJECT_ID,
            "codex:local-default",
        )
        .expect("active lookup");
        assert!(active.is_some());

        let revoke = ServerCommand {
            id: ServerCommandId("command:revoke:fixture".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::OrchestratorDesignation(
                OrchestratorDesignationCommand::Revoke(
                    crate::commands::OrchestratorRevokeDesignationCommand {
                        designation_id: DESIGNATION_ID.to_owned(),
                        expected_revision: None,
                    },
                ),
            ),
        };
        assert_eq!(
            handler.handle(request(revoke)).status,
            ServerControlResponseStatus::Accepted
        );

        // Revocation blocks new delegation: no active designation remains.
        let active = active_designation_for_instance(
            &handler.state(),
            PROJECT_ID,
            "codex:local-default",
        )
        .expect("active lookup");
        assert!(active.is_none());
    }

    #[test]
    fn stored_domain_matches_designation_persistence_kind() {
        let record = LocalStoreRecord {
            id: PersistenceRecordId(DESIGNATION_ID.to_owned()),
            domain: PersistenceDomain::OrchestratorDesignations,
            kind: PersistenceRecordKind::OrchestratorDesignation,
            revision_id: nucleus_core::RevisionId("rev:designation:1".to_owned()),
            payload: LocalStoreRecordPayload {
                media_type: Some("application/json".to_owned()),
                bytes: Vec::new(),
            },
        };
        assert_eq!(
            record.domain,
            PersistenceDomain::OrchestratorDesignations
        );
        assert_eq!(
            record.kind,
            PersistenceRecordKind::OrchestratorDesignation
        );
    }
}
