//! Server-owned orchestration run lifecycle command wiring.
//!
//! Each run command rides the contract-018 spine: admission (family `Run`)
//! appends the `command_admitted` event, the engine service enforces the
//! lifecycle state machine and persists the run record, and a runtime
//! receipt (contract 020) records every accepted transition as effect
//! evidence. Invalid transitions are rejected without state mutation.

use std::path::Path;
use std::time::Duration;

use nucleus_core::{PersistenceRecordId, RevisionId};
use nucleus_engine::{
    EngineRevisionExpectation, EngineRunBudgetEnvelope, EngineRunCloseout, EngineRunCommand,
    EngineRunCommandError, EngineRunCommandOutcome, EngineRunCommandService, EngineRunDeliverCommand,
    EngineRunDispatchCommand, EngineRunId, EngineRunLifecycleState, EngineRunObjective,
    EngineRunProposeCommand, EngineRunRecord, EngineRunRepository, EngineRunStorageRecord,
    EngineRunTransitionCommand, EngineRunTransitionRecord, EngineRuntimeReceiptEffectFamily,
    EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId, EngineRuntimeReceiptRef,
    EngineRuntimeReceiptStatus,
};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    RevisionExpectation,
};

use super::git_branch_worktree_runner_commands::{
    confirmation_ref, write_confirmed_worktree_effect_intent,
};
use super::handler::LocalControlRequestHandler;
use super::project_resource_commands::mutate_project_resource;
use crate::commands::{
    ProjectResourceAction, ProjectResourceCommand, RunCommand, RunDeliverCommand,
    RunDispatchCommand, RunDispatchExecutionCommand, RunProposeCommand, RunTransitionCommand,
};
use crate::control_api::{ServerCommandReceiptStatus, ServerControlError};
use crate::provider_git_branch_worktree_runner_authority::{
    run_dispatch_handoff_lane, run_dispatch_target_refs, run_git_branch_worktree_runner,
    GitBranchWorktreeRunnerExecutionError, GitBranchWorktreeRunnerExecutionInput,
    GitBranchWorktreeRunnerOperatorEffectIntentRecord,
    GitBranchWorktreeRunnerOperatorEffectIntentStatus, RunDispatchLaneInput,
};
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

/// Run dispatch execution (operator-confirmed): write the durable
/// branch/worktree runner operator effect intent for this run, drive the
/// gated isolated-worktree creation, register the worktree as a project
/// resource, and transition the run `proposed -> dispatched` binding the
/// deterministic run conversation and the realized worktree.
///
/// The dispatch command itself is the operator confirmation — the dispatch
/// dialog's explicit confirm act. Nothing spawns unless the authority chain
/// reaches `ReadyForRunner` from the durable intent, the admitted handoff
/// lane, and the approved target refs.
pub(crate) fn handle_run_dispatch_execution<B>(
    handler: &LocalControlRequestHandler<B>,
    command_id: &str,
    command: RunDispatchExecutionCommand,
) -> ServerCommandReceiptStatus
where
    B: LocalStoreBackend + Clone,
{
    if command.operator_ref.trim().is_empty() {
        return ServerCommandReceiptStatus::Rejected(ServerControlError::InvalidRequest {
            reason: "run dispatch requires an operator ref".to_owned(),
        });
    }

    let run = match load_run_record(
        handler.state(),
        &command.run_id,
        command.expected_revision.as_ref(),
    ) {
        Ok(run) => run,
        Err(error) => return ServerCommandReceiptStatus::Rejected(error),
    };
    if run.state != EngineRunLifecycleState::Proposed {
        return ServerCommandReceiptStatus::Rejected(ServerControlError::InvalidRequest {
            reason: format!(
                "run dispatch requires the run to be proposed, not {}",
                state_label(run.state)
            ),
        });
    }

    let project = match load_project_record(handler.state(), &run.project_id) {
        Ok(project) => project,
        Err(error) => return ServerCommandReceiptStatus::Rejected(error),
    };
    let project_revision_id = project.1;
    let project = project.0;
    let repo_root = project.primary_location().map(Path::new).map(Path::to_path_buf);
    let Some(repo_root) = repo_root else {
        return ServerCommandReceiptStatus::Rejected(ServerControlError::InvalidRequest {
            reason: format!(
                "project {} has no primary working resource to create the run worktree beside",
                run.project_id
            ),
        });
    };
    let repo_name = repo_root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "repo".to_owned());

    let slug = run_slug(&command.run_id);
    let branch_ref = format!("run/{slug}");
    let worktree_location_ref = format!("../{repo_name}-wt/{slug}");
    let worktree_path = worktree_absolute_path(&repo_root, &repo_name, &slug);

    // Admitted handoff lane for one isolated-worktree dispatch.
    let lane = run_dispatch_handoff_lane(RunDispatchLaneInput {
        run_id: command.run_id.0.clone(),
        operator_ref: command.operator_ref.clone(),
    });
    let target_refs = run_dispatch_target_refs(&lane, &branch_ref, &worktree_location_ref);

    // The dispatch dialog's confirmation IS this command: record the durable
    // operator effect intent before anything can spawn.
    let intent_status = write_confirmed_worktree_effect_intent(
        handler.state(),
        command_id,
        GitBranchWorktreeRunnerOperatorEffectIntentRecord {
            confirmation_ref: confirmation_ref(&command.run_id.0),
            run_id: command.run_id.0.clone(),
            handoff_id: lane.handoff_id.clone(),
            branch_ref: branch_ref.clone(),
            worktree_location_ref: worktree_location_ref.clone(),
            allow_primary_tree_checkout: false,
            allow_isolated_worktree_creation: true,
            operator_ref: command.operator_ref.clone(),
            idempotency_key: command.run_id.0.clone(),
            status: GitBranchWorktreeRunnerOperatorEffectIntentStatus::Confirmed,
        },
    );
    if let ServerCommandReceiptStatus::Rejected(error) = intent_status {
        return ServerCommandReceiptStatus::Rejected(error);
    }

    let execution = run_git_branch_worktree_runner(
        handler.state(),
        GitBranchWorktreeRunnerExecutionInput {
            confirmation_ref: confirmation_ref(&command.run_id.0),
            handoffs: lane.handoffs.clone(),
            target_refs,
            repo_working_directory: repo_root.clone(),
            run_id: command.run_id.0.clone(),
            operator_ref: command.operator_ref.clone(),
            idempotency_key: command.run_id.0.clone(),
            timeout: Duration::from_secs(60),
            stdout_limit_bytes: 4096,
            stderr_limit_bytes: 4096,
        },
    );
    let result = match execution {
        Ok(result) => result,
        Err(error) => {
            return ServerCommandReceiptStatus::Rejected(dispatch_execution_error(error));
        }
    };
    if !result.outcomes.worktree_created {
        let spawn = result
            .spawn
            .map(|summary| {
                format!(
                    "git exit {:?}, stdout {} bytes, stderr {} bytes",
                    summary.exit_status, summary.stdout_captured_bytes, summary.stderr_captured_bytes
                )
            })
            .unwrap_or_else(|| "no spawn ran".to_owned());
        return ServerCommandReceiptStatus::Rejected(ServerControlError::InvalidRequest {
            reason: format!("run dispatch gated execution did not create a worktree: {spawn}"),
        });
    }

    // Register the worktree as the run's project resource (GitRepository).
    if let Err(error) = mutate_project_resource(
        handler,
        &format!("{command_id}:attach-worktree"),
        ProjectResourceCommand {
            project_id: nucleus_projects::ProjectId(run.project_id.clone()),
            expected_revision: project_revision_id,
            actor_ref: command.operator_ref.clone(),
            authority_host_ref: handler.authority_host_id().0.clone(),
            idempotency_key: format!("run-dispatch:{}", command.run_id.0),
            action: ProjectResourceAction::Attach {
                locator: worktree_path.clone(),
            },
        },
    ) {
        return ServerCommandReceiptStatus::Rejected(error);
    }

    // Bind the deterministic run conversation and the realized worktree;
    // the operation id binds when the first turn actually starts.
    let repository = ServerRunCommandRepository::new(handler.state());
    let service = EngineRunCommandService::new(repository);
    match service.execute(
        command_id,
        EngineRunCommand::Dispatch(engine_dispatch_command(RunDispatchCommand {
            run_id: command.run_id.clone(),
            operation_id: None,
            conversation_id: Some(crate::local_codex_chat::run_transitions::run_conversation_id(
                &command.run_id.0,
            )),
            worktree_ref: Some(worktree_path.display().to_string()),
            expected_revision: command.expected_revision.clone(),
        })),
    ) {
        Ok(EngineRunCommandOutcome::Mutated { transition }) => {
            match write_run_transition_receipt(handler.state(), command_id, &command.run_id, &transition)
            {
                Ok(()) => ServerCommandReceiptStatus::AcceptedForStateMutation,
                Err(error) => ServerCommandReceiptStatus::Rejected(error),
            }
        }
        Err(error) => ServerCommandReceiptStatus::Rejected(engine_run_error(error)),
    }
}

fn run_slug(run_id: &EngineRunId) -> String {
    run_id
        .0
        .strip_prefix("run:")
        .filter(|slug| !slug.is_empty())
        .unwrap_or(&run_id.0)
        .to_owned()
}

/// Absolute worktree path: sibling `<repo>-wt/<run-slug>` per the playbook.
fn worktree_absolute_path(repo_root: &std::path::Path, repo_name: &str, slug: &str) -> std::path::PathBuf {
    repo_root
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!("{repo_name}-wt"))
        .join(slug)
}

fn load_run_record<B>(
    state: &ServerStateService<B>,
    run_id: &EngineRunId,
    expected_revision: Option<&RevisionId>,
) -> Result<EngineRunStorageRecord, ServerControlError>
where
    B: LocalStoreBackend,
{
    let record_id = PersistenceRecordId(run_id.0.clone());
    let repository = ServerRunCommandRepository::new(state);
    let record = repository
        .get_run(&record_id)
        .map_err(local_store_error)?
        .ok_or_else(|| ServerControlError::NotFound {
            reason: format!("run record not found: {}", record_id.0),
        })?;
    if let Some(expected) = expected_revision {
        if &record.revision_id != expected {
            return Err(ServerControlError::Conflict {
                reason: format!("run revision conflict for {}", record_id.0),
            });
        }
    }
    nucleus_engine::decode_run_storage_record(&record.payload).map_err(|error| {
        ServerControlError::InvalidRequest {
            reason: format!("run storage payload is invalid: {error:?}"),
        }
    })
}

fn load_project_record<B>(
    state: &ServerStateService<B>,
    project_id: &str,
) -> Result<(nucleus_projects::ProjectStorageRecord, RevisionId), ServerControlError>
where
    B: LocalStoreBackend,
{
    let record_id = PersistenceRecordId(project_id.to_owned());
    let record = state
        .projects()
        .get(&record_id)
        .map_err(local_store_error)?
        .ok_or_else(|| ServerControlError::NotFound {
            reason: format!("project record not found: {}", record_id.0),
        })?;
    if record.kind != nucleus_core::PersistenceRecordKind::Project {
        return Err(ServerControlError::InvalidRequest {
            reason: "run dispatch target is not a project record".to_owned(),
        });
    }
    let revision = record.revision_id.clone();
    nucleus_projects::decode_project_storage_record(&record.payload.bytes)
        .map(|project| (project, revision))
        .map_err(|error| ServerControlError::InvalidRequest {
            reason: format!("project storage payload is invalid: {error:?}"),
        })
}

fn dispatch_execution_error(
    error: GitBranchWorktreeRunnerExecutionError,
) -> ServerControlError {
    match error {
        GitBranchWorktreeRunnerExecutionError::Blocked {
            blockers, reason, ..
        } => ServerControlError::InvalidRequest {
            reason: format!("{reason}: {blockers:?}"),
        },
        GitBranchWorktreeRunnerExecutionError::CommandNotReady { reason } => {
            ServerControlError::InvalidRequest { reason }
        }
        GitBranchWorktreeRunnerExecutionError::SpawnFailed { reason } => {
            ServerControlError::RuntimeUnavailable { reason }
        }
        GitBranchWorktreeRunnerExecutionError::Persistence(error) => {
            ServerControlError::StorageUnavailable {
                reason: format!("{error:?}"),
            }
        }
    }
}

/// Drive one run transition from observed chat operation truth (turn start
/// activity or turn failure), not timers.
///
/// Mirrors the command path end to end: the transition rides the contract-018
/// admission spine (family `Run`, target = run id), the engine service
/// enforces the lifecycle, and the contract-020 receipt records the accepted
/// transition. `operation_id` binds only on `mark-running` (the provider
/// mints it per activity, so the first observed activity of a dispatched
/// run's conversation binds it).
pub(crate) fn run_transition_from_operation_truth<B>(
    state: &ServerStateService<B>,
    command_id: &str,
    run_id: &EngineRunId,
    operation_id: Option<String>,
    to: EngineRunLifecycleState,
    reason: Option<String>,
) -> Result<EngineRunTransitionRecord, ServerControlError>
where
    B: LocalStoreBackend,
{
    use nucleus_orchestration::{
        OrchestrationAcceptedCommand, OrchestrationCommandFamily, OrchestrationCommandId,
    };

    let admitted = OrchestrationAcceptedCommand {
        command_id: OrchestrationCommandId(command_id.to_owned()),
        family: OrchestrationCommandFamily::Run,
        target_ref: Some(run_id.0.clone()),
    };
    super::command_events::append_command_admitted_event(state, &admitted).map_err(|error| {
        ServerControlError::StorageUnavailable {
            reason: format!("{error:?}"),
        }
    })?;

    let command = match to {
        EngineRunLifecycleState::Running => EngineRunCommand::MarkRunning(
            EngineRunTransitionCommand {
                run_id: run_id.clone(),
                operation_id,
                expected_revision: None,
                reason,
            },
        ),
        EngineRunLifecycleState::Failed => EngineRunCommand::Fail(EngineRunTransitionCommand {
            run_id: run_id.clone(),
            operation_id: None,
            expected_revision: None,
            reason,
        }),
        _ => {
            return Err(ServerControlError::InvalidRequest {
                reason: format!(
                    "operation truth can only drive mark-running or fail, not {:?}",
                    to
                ),
            });
        }
    };

    let repository = ServerRunCommandRepository::new(state);
    let service = EngineRunCommandService::new(repository);
    match service.execute(command_id, command) {
        Ok(EngineRunCommandOutcome::Mutated { transition }) => {
            write_run_transition_receipt(state, command_id, run_id, &transition)
                .map(|()| transition)
        }
        Err(error) => Err(engine_run_error(error)),
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
        worktree_ref: command.worktree_ref,
        expected_revision: command.expected_revision,
    }
}

fn engine_transition_command(command: RunTransitionCommand) -> EngineRunTransitionCommand {
    EngineRunTransitionCommand {
        run_id: command.run_id,
        operation_id: command.operation_id,
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

    use crate::commands::{ProjectCommand, ServerCommand, ServerCommandKind};
    use crate::control_api::{
        ServerCommandReceipt, ServerCommandReceiptStatus, ServerControlError,
        ServerControlResponseStatus,
    };
    use crate::ids::{ClientId, ServerCommandId, ServerControlRequestId};
    use crate::project_seed::{seed_local_project, LocalProjectSeed};
    use crate::provider_git_branch_worktree_runner_authority::{
        read_git_branch_worktree_runner_operator_effect_intent_by_confirmation,
    };
    use crate::request_handler::git_branch_worktree_runner_commands::confirmation_ref;
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
        worktree_ref: None,
                    run_id: EngineRunId("run:1".to_owned()),
                    operation_id: Some("operation:1".to_owned()),
                    conversation_id: Some("conversation:1".to_owned()),
                    expected_revision: None,
                }),
            ),
            (
                "command:run:running:1",
                RunCommand::MarkRunning(RunTransitionCommand {
        operation_id: None,
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
        operation_id: None,
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
        operation_id: None,
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
        operation_id: None,
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
                operation_id: None,
                expected_revision: None,
                reason: None,
            })),
        };
        assert!(matches!(
            super::super::command_admission::admit_state_command(&command),
            super::super::command_admission::CommandAdmissionOutcome::Accepted(_)
        ));
    }

    #[test]
    fn run_dispatch_execution_creates_worktree_binds_conversation_and_dispatches() {
        let (directory, repo) = temp_repo();
        let (_temp_dir, mut handler) = handler();
        seed_project(&handler);
        attach_repo(&mut handler, &repo, "attach:repo");

        // Propose the run for the seeded project.
        let response = handler.handle(request(
            "command:run:propose:dispatch",
            propose_command("run:dispatch-fixture"),
        ));
        assert_eq!(response.status, ServerControlResponseStatus::Accepted);

        // Dispatch: the command itself is the operator confirmation; the
        // server writes the durable intent, drives the gated worktree
        // creation, registers the resource, and dispatches the run.
        let dispatch = control_request(
            "command:run:dispatch-exec:1",
            ServerCommandKind::RunDispatchExecution(RunDispatchExecutionCommand {
                run_id: EngineRunId("run:dispatch-fixture".to_owned()),
                expected_revision: None,
                operator_ref: "operator:tom".to_owned(),
            }),
        );
        let response = handler.handle(dispatch);
        assert_eq!(response.status, ServerControlResponseStatus::Accepted);
        assert!(matches!(
            response.body,
            ServerControlResponseBody::Command(ServerCommandReceipt {
                status: ServerCommandReceiptStatus::AcceptedForStateMutation,
                ..
            })
        ));

        // The worktree exists on disk per the playbook convention
        // `<repo>-wt/<run-slug>` with branch `run/<slug>`.
        let worktree = directory.path().join("repo-wt").join("dispatch-fixture");
        assert!(worktree.is_dir());
        assert!(worktree.join(".git").exists());
        let branch = std::process::Command::new("git")
            .args(["branch", "--show-current"])
            .current_dir(&worktree)
            .output()
            .expect("branch");
        assert_eq!(
            String::from_utf8(branch.stdout).expect("branch name").trim(),
            "run/dispatch-fixture"
        );

        // The run record is dispatched with the deterministic conversation
        // and the realized worktree ref.
        let run_records = handler
            .state()
            .orchestration_runs()
            .list()
            .expect("run records");
        let run_record = decode_run_storage_record(&run_records[0].payload.bytes).expect("decode");
        assert_eq!(run_record.state, EngineRunLifecycleState::Dispatched);
        assert_eq!(
            run_record.conversation_id.as_deref(),
            Some("conversation:run:run:dispatch-fixture")
        );
        assert_eq!(
            run_record.worktree_ref.as_deref(),
            Some(
                std::fs::canonicalize(&worktree)
                    .expect("canonical worktree")
                    .display()
                    .to_string()
                    .as_str()
            )
        );
        assert_eq!(run_record.operation_id, None, "operation binds at first turn");

        // The worktree is registered as a GitRepository project resource.
        let project = handler
            .state()
            .projects()
            .get(&PersistenceRecordId("project:run-registry".to_owned()))
            .expect("project get")
            .expect("project record");
        let project = nucleus_projects::decode_project_storage_record(&project.payload.bytes)
            .expect("decode project");
        let canonical_worktree = std::fs::canonicalize(&worktree)
            .expect("canonical worktree")
            .display()
            .to_string();
        let worktree_resource = project
            .resources
            .iter()
            .find(|resource| {
                resource.current_locator.as_deref() == Some(canonical_worktree.as_str())
            })
            .expect("worktree resource");
        assert_eq!(
            worktree_resource.kind,
            nucleus_projects::ProjectResourceStorageKind::GitRepository
        );

        // The durable operator effect intent exists (the confirmation).
        let intent = read_git_branch_worktree_runner_operator_effect_intent_by_confirmation(
            handler.state(),
            &confirmation_ref("run:dispatch-fixture"),
        )
        .expect("intent read")
        .expect("intent record");
        assert_eq!(intent.run_id, "run:dispatch-fixture");
        assert_eq!(intent.branch_ref, "run/dispatch-fixture");
        assert_eq!(intent.worktree_location_ref, "../repo-wt/dispatch-fixture");

        // Receipt trail: dispatch transition + worktree created + operator
        // effect intent confirmation.
        let receipts = read_runtime_receipts(&handler.state()).expect("receipts");
        assert!(receipts.iter().any(|receipt| receipt
            .effect_ref
            .as_ref()
            .is_some_and(|effect| effect
                == &EngineRuntimeReceiptRef::Custom(
                    "run:run:dispatch-fixture:transition-to:dispatched".to_owned()
                ))));
        assert!(receipts.iter().any(|receipt| receipt
            .effect_ref
            .as_ref()
            .is_some_and(|effect| effect
                == &EngineRuntimeReceiptRef::Custom(
                    "git-branch-worktree-runner:worktree-created:run:dispatch-fixture".to_owned()
                ))));
        assert!(receipts.iter().any(|receipt| receipt
            .effect_ref
            .as_ref()
            .is_some_and(|effect| effect
                == &EngineRuntimeReceiptRef::Custom(
                    "git-branch-worktree-runner:operator-effect-intent:confirmed:run:dispatch-fixture"
                        .to_owned()
                ))));

        // The spine carries the dispatch execution admission under family Run.
        let events = handler
            .state()
            .event_journal()
            .list_in_insertion_order()
            .expect("events");
        assert!(events.iter().any(|event| {
            let event =
                decode_orchestration_event_store_record(&event.payload.bytes).expect("decode");
            let event = event.into_payload();
            event.command_id.0 == "command:run:dispatch-exec:1"
                && event.family == OrchestrationCommandFamily::Run
        }));
    }

    #[test]
    fn run_dispatch_execution_requires_a_proposed_run_with_a_primary_location() {
        let (_temp_dir, mut handler) = handler();
        seed_project(&handler);

        // No run record: not found.
        let response = handler.handle(control_request(
            "command:run:dispatch-exec:missing",
            ServerCommandKind::RunDispatchExecution(RunDispatchExecutionCommand {
                run_id: EngineRunId("run:missing".to_owned()),
                expected_revision: None,
                operator_ref: "operator:tom".to_owned(),
            }),
        ));
        assert_eq!(response.status, ServerControlResponseStatus::Rejected);
        assert!(matches!(
            response.body,
            ServerControlResponseBody::Command(ServerCommandReceipt {
                status: ServerCommandReceiptStatus::Rejected(ServerControlError::NotFound { .. }),
                ..
            })
        ));

        // A proposed run without any working resource: invalid request, and
        // nothing is spawned.
        let response = handler.handle(request(
            "command:run:propose:no-location",
            propose_command("run:no-location"),
        ));
        assert_eq!(response.status, ServerControlResponseStatus::Accepted);
        let response = handler.handle(control_request(
            "command:run:dispatch-exec:no-location",
            ServerCommandKind::RunDispatchExecution(RunDispatchExecutionCommand {
                run_id: EngineRunId("run:no-location".to_owned()),
                expected_revision: None,
                operator_ref: "operator:tom".to_owned(),
            }),
        ));
        assert_eq!(response.status, ServerControlResponseStatus::Rejected);
        assert!(matches!(
            response.body,
            ServerControlResponseBody::Command(ServerCommandReceipt {
                status: ServerCommandReceiptStatus::Rejected(
                    ServerControlError::InvalidRequest { .. }
                ),
                ..
            })
        ));
        let run_records = handler
            .state()
            .orchestration_runs()
            .list()
            .expect("run records");
        assert_eq!(run_records.len(), 1);
        let run_record = decode_run_storage_record(&run_records[0].payload.bytes).expect("decode");
        assert_eq!(run_record.state, EngineRunLifecycleState::Proposed);
    }

    #[test]
    fn run_dispatch_execution_blocks_when_run_is_not_proposed() {
        let (_directory, repo) = temp_repo();
        let (_temp_dir, mut handler) = handler();
        seed_project(&handler);
        attach_repo(&mut handler, &repo, "attach:repo:2");
        handler.handle(request(
            "command:run:propose:dispatch",
            propose_command("run:dispatch-twice"),
        ));
        handler.handle(control_request(
            "command:run:dispatch-exec:1",
            ServerCommandKind::RunDispatchExecution(RunDispatchExecutionCommand {
                run_id: EngineRunId("run:dispatch-twice".to_owned()),
                expected_revision: None,
                operator_ref: "operator:tom".to_owned(),
            }),
        ));

        // Repeat dispatch of an already-dispatched run is rejected; the
        // gated execution replays, but the lifecycle transition is invalid.
        let response = handler.handle(control_request(
            "command:run:dispatch-exec:2",
            ServerCommandKind::RunDispatchExecution(RunDispatchExecutionCommand {
                run_id: EngineRunId("run:dispatch-twice".to_owned()),
                expected_revision: None,
                operator_ref: "operator:tom".to_owned(),
            }),
        ));
        assert_eq!(response.status, ServerControlResponseStatus::Rejected);
        assert!(matches!(
            response.body,
            ServerControlResponseBody::Command(ServerCommandReceipt {
                status: ServerCommandReceiptStatus::Rejected(
                    ServerControlError::InvalidRequest { .. }
                ),
                ..
            })
        ));
    }

    fn attach_repo(
        handler: &mut LocalControlRequestHandler<SqliteBackend>,
        repo: &std::path::Path,
        idempotency_key: &str,
    ) {
        let project = handler
            .state()
            .projects()
            .get(&PersistenceRecordId("project:run-registry".to_owned()))
            .expect("project get")
            .expect("project record");
        let project_revision = project.revision_id.clone();
        let attach = control_request(
            &format!("command:attach:{idempotency_key}"),
            ServerCommandKind::Project(ProjectCommand::Resource(ProjectResourceCommand {
                project_id: ProjectId("project:run-registry".to_owned()),
                expected_revision: project_revision,
                actor_ref: "operator:tom".to_owned(),
                authority_host_ref: handler.authority_host_id().0.clone(),
                idempotency_key: idempotency_key.to_owned(),
                action: ProjectResourceAction::Attach {
                    locator: repo.to_path_buf(),
                },
            })),
        );
        let response = handler.handle(attach);
        assert_eq!(response.status, ServerControlResponseStatus::Accepted);
    }

    fn control_request(
        command_id: &str,
        kind: ServerCommandKind,
    ) -> ServerControlRequest {
        ServerControlRequest {
            id: ServerControlRequestId(format!("request:{command_id}")),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerControlRequestKind::Command(ServerCommand {
                id: ServerCommandId(command_id.to_owned()),
                client_id: ClientId("client:desktop".to_owned()),
                kind,
            }),
        }
    }

    fn temp_repo() -> (tempfile::TempDir, std::path::PathBuf) {
        let directory = tempfile::tempdir().expect("directory");
        let repo = directory.path().join("repo");
        std::fs::create_dir(&repo).expect("repo");
        run_git(&repo, &["init", "-q"]);
        std::fs::write(repo.join("readme.md"), "# repo\n").expect("file");
        run_git(&repo, &["add", "readme.md"]);
        run_git(&repo, &["commit", "-q", "-m", "initial"]);
        (directory, repo)
    }

    fn run_git(cwd: &std::path::Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .status()
            .expect("git");
        assert!(status.success(), "git {args:?} failed");
    }
}
