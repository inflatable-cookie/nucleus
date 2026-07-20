use nucleus_agent_protocol::{AgentToolCall, AgentToolCallHandler};
use serde_json::Value;
use std::future::poll_fn;
use std::task::Poll;
use swallowtail_runtime::{
    CallbackFailureKind, CallbackPayload, CallbackRequest, CallbackRequestKind, CallbackResponse,
    CallbackResult, CleanupOutcome, RuntimeFailure, TerminalOutcome, TerminalStatus, TurnHandle,
};

use super::runtime_error;

const MAXIMUM_CALLBACK_RESULT_BYTES: usize = 1024 * 1024;

enum TurnActivity {
    Terminal(TerminalOutcome),
    Callback(CallbackRequest),
    CallbackClosed,
    CallbackFailed(RuntimeFailure),
    Event,
    EventsClosed,
    EventFailed(RuntimeFailure),
}

pub(super) async fn drive_turn(
    turn: &mut dyn TurnHandle,
    provider_turn_id: &str,
    on_tool_call: &mut AgentToolCallHandler<'_>,
) -> Result<TerminalOutcome, String> {
    let mut events = turn
        .take_events()
        .ok_or_else(|| "Swallowtail returned no Codex event stream".to_owned())?;
    let mut callbacks = turn.take_callbacks();
    let responder = callbacks.as_ref().map(|exchange| exchange.responder());
    let mut callback_requests = callbacks
        .as_mut()
        .and_then(|exchange| exchange.take_requests());
    let mut terminal = turn
        .take_terminal_outcome()
        .ok_or_else(|| "Swallowtail returned no Codex terminal outcome".to_owned())?;
    let mut events_open = true;
    let mut callbacks_open = callback_requests.is_some();
    let mut first_stream_error = None;
    let mut cancellation_requested = false;

    loop {
        let activity = poll_fn(|context| {
            if let Poll::Ready(outcome) = terminal.as_mut().poll(context) {
                return Poll::Ready(TurnActivity::Terminal(outcome));
            }
            if callbacks_open {
                let callbacks = callback_requests
                    .as_mut()
                    .expect("open callback stream is present");
                match callbacks.as_mut().poll_next(context) {
                    Poll::Ready(Some(Ok(request))) => {
                        return Poll::Ready(TurnActivity::Callback(request));
                    }
                    Poll::Ready(Some(Err(error))) => {
                        return Poll::Ready(TurnActivity::CallbackFailed(error));
                    }
                    Poll::Ready(None) => return Poll::Ready(TurnActivity::CallbackClosed),
                    Poll::Pending => {}
                }
            }
            if events_open {
                match events.as_mut().poll_next(context) {
                    Poll::Ready(Some(Ok(_))) => return Poll::Ready(TurnActivity::Event),
                    Poll::Ready(Some(Err(error))) => {
                        return Poll::Ready(TurnActivity::EventFailed(error));
                    }
                    Poll::Ready(None) => return Poll::Ready(TurnActivity::EventsClosed),
                    Poll::Pending => {}
                }
            }
            Poll::Pending
        })
        .await;

        match activity {
            TurnActivity::Terminal(outcome) => {
                if let Some(error) = first_stream_error {
                    return Err(error);
                }
                return Ok(outcome);
            }
            TurnActivity::Callback(request) => {
                let response = callback_response(&request, provider_turn_id, on_tool_call);
                if let Some(responder) = &responder {
                    if let Err(error) = responder.respond(response).await {
                        first_stream_error.get_or_insert_with(|| runtime_error(error));
                    }
                }
            }
            TurnActivity::CallbackClosed => callbacks_open = false,
            TurnActivity::CallbackFailed(error) => {
                callbacks_open = false;
                first_stream_error.get_or_insert_with(|| runtime_error(error));
            }
            TurnActivity::Event => {}
            TurnActivity::EventsClosed => events_open = false,
            TurnActivity::EventFailed(error) => {
                events_open = false;
                first_stream_error.get_or_insert_with(|| runtime_error(error));
            }
        }

        if first_stream_error.is_some() && !cancellation_requested {
            let _ = turn.cancellation().request().await;
            cancellation_requested = true;
        }
    }
}

pub(super) fn callback_response(
    request: &CallbackRequest,
    provider_turn_id: &str,
    on_tool_call: &mut AgentToolCallHandler<'_>,
) -> CallbackResponse {
    let result = match request.kind() {
        CallbackRequestKind::ToolCall {
            tool_name,
            arguments,
        } => serde_json::from_slice::<Value>(arguments.as_bytes())
            .map_err(|_| "dynamic tool arguments were not valid JSON".to_owned())
            .and_then(|arguments| {
                on_tool_call(AgentToolCall {
                    tool: tool_name.clone(),
                    turn_id: provider_turn_id.to_owned(),
                    call_id: request.callback_id().as_str().to_owned(),
                    arguments,
                })
            }),
        CallbackRequestKind::Extension(_) => {
            Err("unsupported provider callback extension".to_owned())
        }
    };
    let result = match result {
        Ok(text) => match CallbackPayload::new(text.into_bytes(), MAXIMUM_CALLBACK_RESULT_BYTES) {
            Ok(payload) => CallbackResult::Success(payload),
            Err(_) => callback_failure("dynamic tool result exceeded the callback limit"),
        },
        Err(error) => callback_failure(&error),
    };
    CallbackResponse::new(
        request.callback_id().clone(),
        request.turn_id().clone(),
        result,
    )
}

fn callback_failure(detail: &str) -> CallbackResult {
    CallbackResult::Failure {
        kind: CallbackFailureKind::ConsumerFailed,
        detail: CallbackPayload::new(detail.as_bytes().to_vec(), MAXIMUM_CALLBACK_RESULT_BYTES)
            .ok(),
    }
}

pub(super) fn completed_output(outcome: &TerminalOutcome) -> Result<String, String> {
    match outcome.status() {
        TerminalStatus::Completed => outcome
            .output()
            .map(|output| output.as_str().trim().to_owned())
            .filter(|output| !output.is_empty())
            .ok_or_else(|| "Codex completed the turn without an assistant message".to_owned()),
        TerminalStatus::Cancelled => Err("Codex turn was cancelled".to_owned()),
        TerminalStatus::TimedOut => Err("Codex turn timed out".to_owned()),
        TerminalStatus::ProviderRequestObserved(_) => {
            Err("Codex turn stopped for an unsupported provider request".to_owned())
        }
        TerminalStatus::ProviderFailed(diagnostic) => {
            Err(format!("Codex provider failed: {}", diagnostic.message()))
        }
        TerminalStatus::HostFailed(diagnostic) => {
            Err(format!("Codex host failed: {}", diagnostic.message()))
        }
        TerminalStatus::RuntimeFailed(diagnostic) => {
            Err(format!("Codex runtime failed: {}", diagnostic.message()))
        }
    }
}

pub(super) fn require_clean_turn(cleanup: CleanupOutcome) -> Result<(), String> {
    match cleanup {
        CleanupOutcome::Clean | CleanupOutcome::NotApplicable => Ok(()),
        CleanupOutcome::Degraded(diagnostic) | CleanupOutcome::Failed(diagnostic) => Err(format!(
            "Codex turn cleanup failed: {}",
            diagnostic.message()
        )),
    }
}
