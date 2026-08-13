//! Server-owned orchestration run lifecycle command wiring.
//!
//! Each run command rides the contract-018 spine: admission (family `Run`)
//! appends the `command_admitted` event, the engine service enforces the
//! lifecycle state machine and persists the run record, and a runtime
//! receipt (contract 020) records every accepted transition as effect
//! evidence. Invalid transitions are rejected without state mutation.

use nucleus_core::{PersistenceRecordId, RevisionId};
use nucleus_engine::{
    EngineRevisionExpectation, EngineRunBudgetEnvelope, EngineRunCloseout, EngineRunCommand,
    EngineRunCommandError, EngineRunCommandOutcome, EngineRunCommandService, EngineRunDeliverCommand,
    EngineRunDispatchCommand, EngineRunId, EngineRunLifecycleState, EngineRunObjective,
    EngineRunProposeCommand, EngineRunRecord, EngineRunRepository, EngineRunTransitionCommand,
    EngineRunTransitionRecord, EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptRecord,
    EngineRuntimeReceiptRecordId, EngineRuntimeReceiptRef, EngineRuntimeReceiptStatus,
};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    RevisionExpectation,
};

use super::handler::LocalControlRequestHandler;
use crate::commands::{
    RunCommand, RunDeliverCommand, RunDispatchCommand, RunProposeCommand, RunTransitionCommand,
};
use crate::control_api::{ServerCommandReceiptStatus, ServerControlError};
use crate::runtime_receipt_state::write_runtime_receipt;
use crate::state::ServerStateService;

pub(crate) fn handle_run_command<B>(
    handler: &LocalControlRequestHandler<B>,
    command_id: &str,
    command: RunCommand,
) -> ServerCommandReceiptStatus
where
    B: LocalStoreBackend + Clone,
{
    let run_id = run_id_from_command(&command).clone();
    let repository = ServerRunCommandRepository::new(handler.state());
    let service = EngineRunCommandService::new(repository);

    match service.execute(command_id, engine_run_command(command)) {
        Ok(EngineRunCommandOutcome::Mutated { transition }) => {
            match write_run_transition_receipt(handler.state(), command_id, &run_id, &transition) {
                Ok(()) => ServerCommandReceiptStatus::AcceptedForStateMutation,
                Err(error) => ServerCommandReceiptStatus::Rejected(error),
            }
        }
        Err(error) => ServerCommandReceiptStatus::Rejected(engine_run_error(error)),
    }
}

fn run_id_from_command(command: &RunCommand) -> &EngineRunId {
    match command {
        RunCommand::Propose(command) => &command.run_id,
        RunCommand::Dispatch(command) => &command.run_id,
        RunCommand::MarkRunning(command) => &command.run_id,
        RunCommand::Deliver(command) => &command.run_id,
        RunCommand::Accept(command) => &command.run_id,
        RunCommand::Reject(command) => &command.run_id,
        RunCommand::Fail(command) => &command.run_id,
        RunCommand::Cancel(command) => &command.run_id,
    }
}

/// Write the contract-020 receipt for one accepted run transition.
fn write_run_transition_receipt<B>(
    state: &ServerStateService<B>,
    command_id: &str,
    run_id: &EngineRunId,
    transition: &EngineRunTransitionRecord,
) -> Result<(), ServerControlError>
where
    B: LocalStoreBackend,
{
    let from = transition
        .from
        .map(state_label)
        .unwrap_or("none");
    let receipt = EngineRuntimeReceiptRecord {
        receipt_id: EngineRuntimeReceiptRecordId(format!("receipt:run:{}:{}", run_id.0, command_id)),
        family: EngineRuntimeReceiptEffectFamily::CommandExecution,
        status: EngineRuntimeReceiptStatus::Completed,
        command_ref: Some(EngineRuntimeReceiptRef::CommandId(command_id.to_owned())),
        effect_ref: Some(EngineRuntimeReceiptRef::Custom(format!(
            "run:{}:transition-to:{}",
            run_id.0,
            state_label(transition.to)
        ))),
        evidence_refs: vec![EngineRuntimeReceiptRef::EventId(format!(
            "event:{command_id}:admitted"
        ))],
        artifact_refs: Vec::new(),
        summary: Some(format!(
            "run {} transition {from} -> {} accepted by command {command_id}",
            run_id.0,
            state_label(transition.to)
        )),
    };

    write_runtime_receipt(
        state,
        &receipt,
        RevisionId(format!("rev:receipt:run:{command_id}")),
        RevisionExpectation::MustNotExist,
    )
    .map(|_| ())
    .map_err(local_store_error)
}

pub(crate) fn state_label(state: EngineRunLifecycleState) -> &'static str {
    match state {
        EngineRunLifecycleState::Proposed => "proposed",
        EngineRunLifecycleState::Dispatched => "dispatched",
        EngineRunLifecycleState::Running => "running",
        EngineRunLifecycleState::Delivered => "delivered",
        EngineRunLifecycleState::Accepted => "accepted",
        EngineRunLifecycleState::Rejected => "rejected",
        EngineRunLifecycleState::Failed => "failed",
        EngineRunLifecycleState::Cancelled => "cancelled",
    }
}

fn engine_run_command(command: RunCommand) -> EngineRunCommand {
    match command {
        RunCommand::Propose(command) => EngineRunCommand::Propose(engine_propose_command(command)),
        RunCommand::Dispatch(command) => EngineRunCommand::Dispatch(engine_dispatch_command(command)),
        RunCommand::MarkRunning(command) => {
            EngineRunCommand::MarkRunning(engine_transition_command(command))
        }
        RunCommand::Deliver(command) => EngineRunCommand::Deliver(engine_deliver_command(command)),
        RunCommand::Accept(command) => EngineRunCommand::Accept(engine_transition_command(command)),
        RunCommand::Reject(command) => EngineRunCommand::Reject(engine_transition_command(command)),
        RunCommand::Fail(command) => EngineRunCommand::Fail(engine_transition_command(command)),
        RunCommand::Cancel(command) => EngineRunCommand::Cancel(engine_transition_command(command)),
    }
}

fn engine_propose_command(command: RunProposeCommand) -> EngineRunProposeCommand {
    EngineRunProposeCommand {
        run_id: command.run_id,
        project_id: command.project_id,
        objective: EngineRunObjective {
            scope: command.objective_scope,
            acceptance: command.acceptance,
            stop_conditions: command.stop_conditions,
        },
        worktree_ref: command.worktree_ref,
        provider_instance: command.provider_instance,
        provider_model: command.provider_model,
        orchestrator_designation: command.orchestrator_designation,
        budget: EngineRunBudgetEnvelope {
            token_budget: command.token_budget,
            time_budget_seconds: command.time_budget_seconds,
        },
    }
}

fn engine_dispatch_command(command: RunDispatchCommand) -> EngineRunDispatchCommand {
    EngineRunDispatchCommand {
        run_id: command.run_id,
        operation_id: command.operation_id,
        conversation_id: command.conversation_id,
        expected_revision: command.expected_revision,
    }
}

fn engine_transition_command(command: RunTransitionCommand) -> EngineRunTransitionCommand {
    EngineRunTransitionCommand {
        run_id: command.run_id,
        expected_revision: command.expected_revision,
        reason: command.reason,
    }
}

fn engine_deliver_command(command: RunDeliverCommand) -> EngineRunDeliverCommand {
    EngineRunDeliverCommand {
        run_id: command.run_id,
        closeout: EngineRunCloseout {
            summary: command.closeout_summary,
            evidence_refs: command.closeout_evidence_refs,
            diff_ref: command.closeout_diff_ref,
        },
        expected_revision: command.expected_revision,
    }
}

struct ServerRunCommandRepository<'a, B>
where
    B: LocalStoreBackend,
{
    state: &'a ServerStateService<B>,
}

impl<'a, B> ServerRunCommandRepository<'a, B>
where
    B: LocalStoreBackend,
{
    fn new(state: &'a ServerStateService<B>) -> Self {
        Self { state }
    }
}

impl<B> EngineRunRepository for ServerRunCommandRepository<'_, B>
where
    B: LocalStoreBackend,
{
    type Error = LocalStoreError;

    fn get_run(
        &self,
        run_id: &PersistenceRecordId,
    ) -> Result<Option<EngineRunRecord>, Self::Error> {
        self.state
            .orchestration_runs()
            .get(run_id)
            .map(|record| record.map(engine_record_from_local))
    }

    fn put_run(
        &self,
        record: EngineRunRecord,
        revision: EngineRevisionExpectation,
    ) -> Result<(), Self::Error> {
        self.state
            .orchestration_runs()
            .put(local_record_from_engine(record), local_revision(revision))?;
        Ok(())
    }
}

fn engine_record_from_local(record: LocalStoreRecord) -> EngineRunRecord {
    EngineRunRecord {
        id: record.id,
        domain: record.domain,
        kind: record.kind,
        revision_id: record.revision_id,
        payload: record.payload.bytes,
    }
}

fn local_record_from_engine(record: EngineRunRecord) -> LocalStoreRecord {
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

fn engine_run_error(error: EngineRunCommandError<LocalStoreError>) -> ServerControlError {
    match error {
        EngineRunCommandError::InvalidRequest { reason } => {
            ServerControlError::InvalidRequest { reason }
        }
        EngineRunCommandError::InvalidTransition { from, to } => {
            ServerControlError::InvalidRequest {
                reason: format!(
                    "run transition {} -> {} is not allowed",
                    state_label(from),
                    state_label(to)
                ),
            }
        }
        EngineRunCommandError::NotFound { reason } => ServerControlError::NotFound { reason },
        EngineRunCommandError::Conflict { reason } => ServerControlError::Conflict { reason },
        EngineRunCommandError::Unsupported { reason } => {
            ServerControlError::Unsupported { reason }
        }
        EngineRunCommandError::Storage(error) => local_store_error(error),
    }
}

fn local_store_error(error: LocalStoreError) -> ServerControlError {
    match error {
        LocalStoreError::RecordNotFound { record_id } => ServerControlError::NotFound {
            reason: format!("run record not found: {}", record_id.0),
        },
        LocalStoreError::RevisionConflict(conflict) => ServerControlError::Conflict {
            reason: format!("run revision conflict for {}", conflict.record_id.0),
        },
        LocalStoreError::InvalidRecord { reason } => ServerControlError::InvalidRequest {
            reason: format!("run storage payload is invalid: {reason}"),
        },
        LocalStoreError::UnsupportedDomain { domain } => ServerControlError::Unsupported {
            reason: format!("unsupported storage domain: {domain:?}"),
        },
        LocalStoreError::UnsupportedRecordKind { reason } => {
            ServerControlError::Unsupported { reason }
        }
        LocalStoreError::DuplicateRecord { record_id } => ServerControlError::Conflict {
            reason: format!("duplicate run record: {}", record_id.0),
        },
        LocalStoreError::Unavailable { reason }
        | LocalStoreError::TransactionRejected { reason }
        | LocalStoreError::BackendBusy { reason }
        | LocalStoreError::BackendRejected { reason } => {
            ServerControlError::StorageUnavailable { reason }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_core::RevisionId;
    use nucleus_engine::decode_run_storage_record;
    use nucleus_local_store::SqliteBackend;
    use nucleus_orchestration::{
        decode_orchestration_event_store_record, OrchestrationCommandFamily,
        OrchestrationEventKind,
    };
    use nucleus_projects::{ImportanceLevel, ProjectId};

    use crate::commands::{ServerCommand, ServerCommandKind};
    use crate::control_api::{
        ServerCommandReceipt, ServerCommandReceiptStatus, ServerControlError,
        ServerControlResponseStatus,
    };
    use crate::ids::{ClientId, ServerCommandId, ServerControlRequestId};
    use crate::project_seed::{seed_local_project, LocalProjectSeed};
    use crate::request_handler::LocalControlRequestHandler;
    use crate::runtime_receipt_state::read_runtime_receipts;
    use crate::{
        ServerControlRequest, ServerControlRequestKind, ServerControlResponseBody,
    };

    fn handler() -> (
        tempfile::TempDir,
        LocalControlRequestHandler<SqliteBackend>,
    ) {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        (
            temp_dir,
            LocalControlRequestHandler::new(backend, None),
        )
    }

    fn propose_command(run_id: &str) -> RunCommand {
        RunCommand::Propose(RunProposeCommand {
            run_id: EngineRunId(run_id.to_owned()),
            project_id: ProjectId("project:run-registry".to_owned()),
            objective_scope: "implement the run registry".to_owned(),
            acceptance: vec!["aggregate persists".to_owned()],
            stop_conditions: vec!["tests red".to_owned()],
            worktree_ref: Some("worktree:1".to_owned()),
            provider_instance: "provider:codex".to_owned(),
            provider_model: "codex-mini".to_owned(),
            orchestrator_designation: None,
            token_budget: Some(100_000),
            time_budget_seconds: Some(3600),
        })
    }

    fn request(command_id: &str, command: RunCommand) -> ServerControlRequest {
        ServerControlRequest {
            id: ServerControlRequestId(format!("request:{command_id}")),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerControlRequestKind::Command(ServerCommand {
                id: ServerCommandId(command_id.to_owned()),
                client_id: ClientId("client:desktop".to_owned()),
                kind: ServerCommandKind::Run(command),
            }),
        }
    }

    fn seed_project(handler: &LocalControlRequestHandler<SqliteBackend>) {
        seed_local_project(
            handler.state(),
            LocalProjectSeed {
                project_id: "project:run-registry".to_owned(),
                display_name: "Run Registry".to_owned(),
                importance_level: ImportanceLevel::Normal,
            },
        )
        .expect("seed project");
    }

    #[test]
    fn handler_executes_run_lifecycle_with_events_and_receipts() {
        let (_temp_dir, mut handler) = handler();
        seed_project(&handler);

        for (command_id, command) in [
            ("command:run:propose:1", propose_command("run:1")),
            (
                "command:run:dispatch:1",
                RunCommand::Dispatch(RunDispatchCommand {
                    run_id: EngineRunId("run:1".to_owned()),
                    operation_id: Some("operation:1".to_owned()),
                    conversation_id: Some("conversation:1".to_owned()),
                    expected_revision: None,
                }),
            ),
            (
                "command:run:running:1",
                RunCommand::MarkRunning(RunTransitionCommand {
                    run_id: EngineRunId("run:1".to_owned()),
                    expected_revision: None,
                    reason: None,
                }),
            ),
            (
                "command:run:deliver:1",
                RunCommand::Deliver(RunDeliverCommand {
                    run_id: EngineRunId("run:1".to_owned()),
                    closeout_summary: "worker finished with evidence".to_owned(),
                    closeout_evidence_refs: vec!["evidence:1".to_owned()],
                    closeout_diff_ref: Some("diff:1".to_owned()),
                    expected_revision: None,
                }),
            ),
            (
                "command:run:accept:1",
                RunCommand::Accept(RunTransitionCommand {
                    run_id: EngineRunId("run:1".to_owned()),
                    expected_revision: None,
                    reason: None,
                }),
            ),
        ] {
            let response = handler.handle(request(command_id, command));
            assert_eq!(
                response.status,
                ServerControlResponseStatus::Accepted,
                "command {command_id} should be accepted"
            );
            assert!(matches!(
                response.body,
                ServerControlResponseBody::Command(ServerCommandReceipt {
                    status: ServerCommandReceiptStatus::AcceptedForStateMutation,
                    ..
                })
            ));
        }

        let run_records = handler
            .state()
            .orchestration_runs()
            .list()
            .expect("run records");
        assert_eq!(run_records.len(), 1);
        let run_record = decode_run_storage_record(&run_records[0].payload.bytes).expect("decode");
        assert_eq!(run_record.state, EngineRunLifecycleState::Accepted);
        assert_eq!(run_record.transitions.len(), 5);
        assert!(run_record.closeout.is_some());

        let events = handler
            .state()
            .event_journal()
            .list_in_insertion_order()
            .expect("events");
        assert_eq!(events.len(), 5);
        for (index, command_id) in [
            "command:run:propose:1",
            "command:run:dispatch:1",
            "command:run:running:1",
            "command:run:deliver:1",
            "command:run:accept:1",
        ]
        .iter()
        .enumerate()
        {
            let event_store_record =
                decode_orchestration_event_store_record(&events[index].payload.bytes)
                    .expect("decode event");
            let event = event_store_record.into_payload();
            assert_eq!(event.kind, OrchestrationEventKind::CommandAdmitted);
            assert_eq!(event.family, OrchestrationCommandFamily::Run);
            assert_eq!(event.command_id.0, *command_id);
            assert_eq!(event.target_ref.as_deref(), Some("run:1"));
        }

        let receipts = read_runtime_receipts(&handler.state()).expect("receipts");
        assert_eq!(receipts.len(), 5);
        for command_id in [
            "command:run:propose:1",
            "command:run:dispatch:1",
            "command:run:running:1",
            "command:run:deliver:1",
            "command:run:accept:1",
        ] {
            let receipt = receipts
                .iter()
                .find(|receipt| {
                    receipt.command_ref
                        == Some(EngineRuntimeReceiptRef::CommandId(command_id.to_owned()))
                })
                .expect("receipt for command");
            assert_eq!(receipt.receipt_id.0, format!("receipt:run:run:1:{command_id}"));
            assert!(receipt
                .summary
                .as_deref()
                .is_some_and(|summary| summary.contains("run:1")));
        }
    }

    #[test]
    fn handler_rejects_invalid_transition_without_mutation() {
        let (_temp_dir, mut handler) = handler();
        seed_project(&handler);

        let response = handler.handle(request("command:run:propose:1", propose_command("run:1")));
        assert_eq!(response.status, ServerControlResponseStatus::Accepted);

        // proposed -> running skips dispatch.
        let response = handler.handle(request(
            "command:run:running:1",
            RunCommand::MarkRunning(RunTransitionCommand {
                run_id: EngineRunId("run:1".to_owned()),
                expected_revision: None,
                reason: None,
            }),
        ));
        assert_eq!(response.status, ServerControlResponseStatus::Rejected);
        assert!(matches!(
            response.body,
            ServerControlResponseBody::Command(ServerCommandReceipt {
                status: ServerCommandReceiptStatus::Rejected(
                    ServerControlError::InvalidRequest { reason }
                ),
                ..
            }) if reason == "run transition proposed -> running is not allowed"
        ));

        let run_records = handler
            .state()
            .orchestration_runs()
            .list()
            .expect("run records");
        let run_record = decode_run_storage_record(&run_records[0].payload.bytes).expect("decode");
        assert_eq!(run_record.state, EngineRunLifecycleState::Proposed);
        assert_eq!(run_record.transitions.len(), 1);
    }

    #[test]
    fn handler_rejects_stale_revision_conflict() {
        let (_temp_dir, mut handler) = handler();
        seed_project(&handler);
        handler.handle(request("command:run:propose:1", propose_command("run:1")));

        let response = handler.handle(request(
            "command:run:cancel:1",
            RunCommand::Cancel(RunTransitionCommand {
                run_id: EngineRunId("run:1".to_owned()),
                expected_revision: Some(RevisionId("rev:stale".to_owned())),
                reason: None,
            }),
        ));
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
    fn run_commands_are_admitted_under_run_family() {
        let command = ServerCommand {
            id: ServerCommandId("command:run:cancel:1".to_owned()),
            client_id: ClientId("client:1".to_owned()),
            kind: ServerCommandKind::Run(RunCommand::Cancel(RunTransitionCommand {
                run_id: EngineRunId("run:1".to_owned()),
                expected_revision: None,
                reason: None,
            })),
        };
        assert!(matches!(
            super::super::command_admission::admit_state_command(&command),
            super::super::command_admission::CommandAdmissionOutcome::Accepted(_)
        ));
    }
}
