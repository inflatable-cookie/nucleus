use nucleus_local_store::LocalStoreBackend;

use super::command_admission::{admit_state_command, CommandAdmissionOutcome};
use super::command_events::append_command_admitted_event;
use super::goal_commands::handle_goal_command;
use super::handler::LocalControlRequestHandler;
use super::project_commands::handle_project_command;
use super::steward_commands::handle_steward_command;
use super::task_commands::handle_task_command;
use crate::memory_proposal_review_persistence::review_memory_proposal;
use std::path::Path;

use crate::commands::{AgentSessionCommand, ServerCommand, ServerCommandKind};
use crate::control_api::{
    ServerCommandReceipt, ServerCommandReceiptStatus, ServerControlError, ServerControlResponse,
    ServerControlResponseBody, ServerControlResponseStatus,
};
use crate::ids::ServerControlRequestId;
use crate::read_only_command_control::run_read_only_command_control;
use crate::scheduler::{
    RuntimeSchedulerAdmissionDecision, RuntimeSchedulerAdmissionRejection, RuntimeSchedulerRequest,
    RuntimeSchedulerRequestId, RuntimeSchedulerRequestKind, RuntimeSchedulerRequestRefs,
};

pub(crate) fn handle_command<B>(
    handler: &mut LocalControlRequestHandler<B>,
    request_id: ServerControlRequestId,
    command: ServerCommand,
) -> ServerControlResponse
where
    B: LocalStoreBackend + Clone,
{
    let command_id = command.id.clone();
    let admitted = match admit_state_command(&command) {
        CommandAdmissionOutcome::NotOrchestrated => None,
        CommandAdmissionOutcome::Accepted(accepted) => Some(accepted),
        CommandAdmissionOutcome::Rejected(rejected) => {
            return ServerControlResponse {
                request_id,
                status: ServerControlResponseStatus::Rejected,
                body: ServerControlResponseBody::Command(ServerCommandReceipt {
                    command_id: command.id,
                    status: rejected,
                }),
            };
        }
    };
    if let Some(admitted) = admitted.as_ref() {
        if let Err(error) = append_command_admitted_event(handler.state(), admitted) {
            let status =
                ServerCommandReceiptStatus::Rejected(ServerControlError::StorageUnavailable {
                    reason: format!("{error:?}"),
                });
            return command_response(request_id, command.id, status);
        }
    }

    let status = match command.kind {
        ServerCommandKind::Project(project_command) => {
            handle_project_command(handler, &command_id.0, project_command)
        }
        ServerCommandKind::Workspace(_) | ServerCommandKind::ConfigureModelRoute(_) => {
            ServerCommandReceiptStatus::AcceptedForStateMutation
        }
        ServerCommandKind::Task(task_command) => {
            handle_task_command(handler, &command_id.0, task_command)
        }
        ServerCommandKind::Goal(goal_command) => {
            handle_goal_command(handler, &command_id.0, goal_command)
        }
        ServerCommandKind::AgentSession(AgentSessionCommand::RegisterAdapter(_)) => {
            ServerCommandReceiptStatus::AcceptedForStateMutation
        }
        ServerCommandKind::AgentSession(AgentSessionCommand::StartSession {
            adapter_id: _,
            project_id,
        }) => {
            let decision = handler.scheduler.submit(RuntimeSchedulerRequest {
                id: RuntimeSchedulerRequestId(format!("scheduler:{}", command.id.0)),
                kind: RuntimeSchedulerRequestKind::Custom("agent-session-start".to_owned()),
                refs: RuntimeSchedulerRequestRefs {
                    project_id,
                    task_id: None,
                    adapter: None,
                    command_request_id: None,
                    server_event_id: None,
                    runtime_effect_record_id: None,
                    retained_refs: Vec::new(),
                },
                summary: Some("agent session start requires runtime admission".to_owned()),
            });
            scheduler_receipt_status(decision)
        }
        ServerCommandKind::AgentSession(
            AgentSessionCommand::CancelActiveTurn { .. } | AgentSessionCommand::CloseSession { .. },
        ) => ServerCommandReceiptStatus::Rejected(ServerControlError::Deferred {
            reason: "agent session runtime control is not implemented".to_owned(),
        }),
        ServerCommandKind::Steward(steward_command) => handle_steward_command(&steward_command),
        ServerCommandKind::MemoryProposalReview(command) => {
            match review_memory_proposal(handler.state(), command) {
                Ok(_) => ServerCommandReceiptStatus::AcceptedForStateMutation,
                Err(error) => ServerCommandReceiptStatus::Rejected(error),
            }
        }
        ServerCommandKind::ReadOnlyCommand(read_only_command) => {
            return handle_read_only_command(handler, request_id, command_id, read_only_command);
        }
    };

    command_response(request_id, command.id, status)
}

fn command_response(
    request_id: ServerControlRequestId,
    command_id: crate::ServerCommandId,
    status: ServerCommandReceiptStatus,
) -> ServerControlResponse {
    let response_status = match status {
        ServerCommandReceiptStatus::AcceptedForStateMutation
        | ServerCommandReceiptStatus::AcceptedForRuntimeScheduling
        | ServerCommandReceiptStatus::AcceptedForNativeStewardCommand => {
            ServerControlResponseStatus::Accepted
        }
        ServerCommandReceiptStatus::WaitingForApproval => ServerControlResponseStatus::Partial,
        ServerCommandReceiptStatus::Rejected(_) => ServerControlResponseStatus::Rejected,
    };

    ServerControlResponse {
        request_id,
        status: response_status,
        body: ServerControlResponseBody::Command(ServerCommandReceipt { command_id, status }),
    }
}

fn handle_read_only_command<B>(
    handler: &mut LocalControlRequestHandler<B>,
    request_id: ServerControlRequestId,
    command_id: crate::ServerCommandId,
    command: crate::ReadOnlyCommand,
) -> ServerControlResponse
where
    B: LocalStoreBackend + Clone,
{
    let artifact_store_root = Path::new(".nucleus/local/artifacts").to_path_buf();
    match run_read_only_command_control(handler.state(), command_id, command, artifact_store_root) {
        Ok(result) => {
            let status = if result.rejection.is_some() {
                ServerControlResponseStatus::Rejected
            } else {
                ServerControlResponseStatus::Complete
            };

            ServerControlResponse {
                request_id,
                status,
                body: ServerControlResponseBody::ReadOnlyCommand(result),
            }
        }
        Err(error) => ServerControlResponse {
            request_id,
            status: ServerControlResponseStatus::Rejected,
            body: ServerControlResponseBody::Error(ServerControlError::StorageUnavailable {
                reason: format!("{error:?}"),
            }),
        },
    }
}

fn scheduler_receipt_status(
    decision: RuntimeSchedulerAdmissionDecision,
) -> ServerCommandReceiptStatus {
    match decision {
        RuntimeSchedulerAdmissionDecision::Accepted(_) => {
            ServerCommandReceiptStatus::AcceptedForRuntimeScheduling
        }
        RuntimeSchedulerAdmissionDecision::Rejected(rejection) => {
            ServerCommandReceiptStatus::Rejected(ServerControlError::RuntimeUnavailable {
                reason: scheduler_rejection_reason(rejection),
            })
        }
    }
}

fn scheduler_rejection_reason(rejection: RuntimeSchedulerAdmissionRejection) -> String {
    match rejection {
        RuntimeSchedulerAdmissionRejection::MissingProject => {
            "scheduler admission requires a project ref".to_owned()
        }
        RuntimeSchedulerAdmissionRejection::MissingCommandAuthority => {
            "scheduler admission requires command authority".to_owned()
        }
        RuntimeSchedulerAdmissionRejection::MissingAdapter => {
            "scheduler admission requires an adapter ref".to_owned()
        }
        RuntimeSchedulerAdmissionRejection::MissingEventMetadata => {
            "scheduler admission requires event metadata refs".to_owned()
        }
        RuntimeSchedulerAdmissionRejection::UnsupportedRequestKind => {
            "scheduler request kind is unsupported".to_owned()
        }
        RuntimeSchedulerAdmissionRejection::RuntimeExecutionDeferred => {
            "runtime execution is deferred".to_owned()
        }
        RuntimeSchedulerAdmissionRejection::Custom(reason) => reason,
    }
}
