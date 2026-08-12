//! Task turn driving: poll the terminal outcome, provider-request callbacks,
//! and event streams, cancelling on the first undeclared stream error.
//!
//! Split from the task_execution god file; behavior unchanged.

use std::future::poll_fn;
use std::task::Poll;

use swallowtail_runtime::{
    CallbackRequestKind, RuntimeFailure, TerminalOutcome, TurnHandle,
};

use super::super::runtime_error;

enum TaskTurnActivity {
    Terminal(TerminalOutcome),
    Callback(CallbackRequestKind),
    CallbackClosed,
    CallbackFailed(RuntimeFailure),
    Event,
    EventsClosed,
    EventFailed(RuntimeFailure),
}

pub(super) async fn drive_task_turn(turn: &mut dyn TurnHandle) -> Result<TerminalOutcome, String> {
    let mut events = turn
        .take_events()
        .ok_or_else(|| "Swallowtail returned no task event stream".to_owned())?;
    let mut callbacks = turn
        .take_callbacks()
        .ok_or_else(|| "Swallowtail returned no provider-request stream".to_owned())?;
    let mut callback_requests = callbacks
        .take_requests()
        .ok_or_else(|| "Swallowtail provider-request stream is unavailable".to_owned())?;
    let mut terminal = turn
        .take_terminal_outcome()
        .ok_or_else(|| "Swallowtail returned no task terminal outcome".to_owned())?;
    let mut callbacks_open = true;
    let mut events_open = true;
    let mut first_stream_error = None;
    let mut cancellation_requested = false;

    loop {
        let activity = poll_fn(|context| {
            if let Poll::Ready(outcome) = terminal.as_mut().poll(context) {
                return Poll::Ready(TaskTurnActivity::Terminal(outcome));
            }
            if callbacks_open {
                match callback_requests.as_mut().poll_next(context) {
                    Poll::Ready(Some(Ok(request))) => {
                        return Poll::Ready(TaskTurnActivity::Callback(request.kind().clone()));
                    }
                    Poll::Ready(Some(Err(error))) => {
                        return Poll::Ready(TaskTurnActivity::CallbackFailed(error));
                    }
                    Poll::Ready(None) => return Poll::Ready(TaskTurnActivity::CallbackClosed),
                    Poll::Pending => {}
                }
            }
            if events_open {
                match events.as_mut().poll_next(context) {
                    Poll::Ready(Some(Ok(_))) => return Poll::Ready(TaskTurnActivity::Event),
                    Poll::Ready(Some(Err(error))) => {
                        return Poll::Ready(TaskTurnActivity::EventFailed(error));
                    }
                    Poll::Ready(None) => return Poll::Ready(TaskTurnActivity::EventsClosed),
                    Poll::Pending => {}
                }
            }
            Poll::Pending
        })
        .await;

        match activity {
            TaskTurnActivity::Terminal(outcome) => {
                return first_stream_error.map_or(Ok(outcome), Err);
            }
            TaskTurnActivity::Callback(CallbackRequestKind::Extension(_))
            | TaskTurnActivity::Event => {}
            TaskTurnActivity::Callback(CallbackRequestKind::ToolCall { .. }) => {
                first_stream_error.get_or_insert_with(|| {
                    "task execution received an undeclared product tool call".to_owned()
                });
            }
            TaskTurnActivity::Callback(CallbackRequestKind::HarnessUserInput(_)) => {
                first_stream_error.get_or_insert_with(|| {
                    "task execution received unsupported typed user input".to_owned()
                });
            }
            TaskTurnActivity::CallbackClosed => callbacks_open = false,
            TaskTurnActivity::CallbackFailed(error) => {
                callbacks_open = false;
                first_stream_error.get_or_insert_with(|| runtime_error(error));
            }
            TaskTurnActivity::EventsClosed => events_open = false,
            TaskTurnActivity::EventFailed(error) => {
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
