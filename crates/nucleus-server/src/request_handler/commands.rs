use nucleus_local_store::LocalStoreBackend;

use super::handler::LocalControlRequestHandler;
use crate::commands::{AgentSessionCommand, ServerCommand, ServerCommandKind};
use crate::control_api::{
    ServerCommandReceipt, ServerCommandReceiptStatus, ServerControlError, ServerControlResponse,
    ServerControlResponseBody, ServerControlResponseStatus,
};
use crate::ids::ServerControlRequestId;
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
    let status = match command.kind {
        ServerCommandKind::Project(_)
        | ServerCommandKind::Task(_)
        | ServerCommandKind::Workspace(_)
        | ServerCommandKind::ConfigureModelRoute(_) => {
            ServerCommandReceiptStatus::AcceptedForStateMutation
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
    };

    let response_status = match status {
        ServerCommandReceiptStatus::AcceptedForStateMutation
        | ServerCommandReceiptStatus::AcceptedForRuntimeScheduling => {
            ServerControlResponseStatus::Accepted
        }
        ServerCommandReceiptStatus::Rejected(_) => ServerControlResponseStatus::Rejected,
    };

    ServerControlResponse {
        request_id,
        status: response_status,
        body: ServerControlResponseBody::Command(ServerCommandReceipt {
            command_id: command.id,
            status,
        }),
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
