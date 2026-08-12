//! Codex read-only smoke turn driving.
//!
//! Split from the smoke god file; behavior unchanged.

use std::future::poll_fn;
use std::task::Poll;

use swallowtail_runtime::{RuntimeFailure, TerminalOutcome, TurnHandle};

use super::super::runtime_error;

pub(super) struct SmokeObservation {
    pub(super) terminal: Result<TerminalOutcome, String>,
    pub(super) events_seen: usize,
    pub(super) provider_requests_seen: usize,
}

enum SmokeActivity {
    Terminal(TerminalOutcome),
    ProviderRequest,
    ProviderRequestsClosed,
    ProviderRequestFailed(RuntimeFailure),
    Event,
    EventsClosed,
    EventFailed(RuntimeFailure),
}

pub(super) async fn drive_smoke_turn(turn: &mut dyn TurnHandle) -> SmokeObservation {
    let mut events = turn.take_events();
    let mut callbacks = turn.take_callbacks();
    let mut callback_requests = callbacks
        .as_mut()
        .and_then(|exchange| exchange.take_requests());
    let Some(mut terminal) = turn.take_terminal_outcome() else {
        return SmokeObservation {
            terminal: Err("Swallowtail returned no Codex diagnostic terminal outcome".to_owned()),
            events_seen: 0,
            provider_requests_seen: 0,
        };
    };
    let mut events_open = events.is_some();
    let mut callbacks_open = callback_requests.is_some();
    let mut events_seen = 0;
    let mut provider_requests_seen = 0;
    let mut first_stream_error = None;
    let mut cancellation_requested = false;

    loop {
        let activity = poll_fn(|context| {
            if let Poll::Ready(outcome) = terminal.as_mut().poll(context) {
                return Poll::Ready(SmokeActivity::Terminal(outcome));
            }
            if callbacks_open {
                let requests = callback_requests
                    .as_mut()
                    .expect("open provider-request stream is present");
                match requests.as_mut().poll_next(context) {
                    Poll::Ready(Some(Ok(_))) => {
                        return Poll::Ready(SmokeActivity::ProviderRequest);
                    }
                    Poll::Ready(Some(Err(error))) => {
                        return Poll::Ready(SmokeActivity::ProviderRequestFailed(error));
                    }
                    Poll::Ready(None) => {
                        return Poll::Ready(SmokeActivity::ProviderRequestsClosed);
                    }
                    Poll::Pending => {}
                }
            }
            if events_open {
                let stream = events.as_mut().expect("open event stream is present");
                match stream.as_mut().poll_next(context) {
                    Poll::Ready(Some(Ok(_))) => return Poll::Ready(SmokeActivity::Event),
                    Poll::Ready(Some(Err(error))) => {
                        return Poll::Ready(SmokeActivity::EventFailed(error));
                    }
                    Poll::Ready(None) => return Poll::Ready(SmokeActivity::EventsClosed),
                    Poll::Pending => {}
                }
            }
            Poll::Pending
        })
        .await;

        match activity {
            SmokeActivity::Terminal(outcome) => {
                return SmokeObservation {
                    terminal: first_stream_error.map_or(Ok(outcome), Err),
                    events_seen,
                    provider_requests_seen,
                };
            }
            SmokeActivity::ProviderRequest => provider_requests_seen += 1,
            SmokeActivity::ProviderRequestsClosed => callbacks_open = false,
            SmokeActivity::ProviderRequestFailed(error) => {
                callbacks_open = false;
                first_stream_error.get_or_insert_with(|| runtime_error(error));
            }
            SmokeActivity::Event => events_seen += 1,
            SmokeActivity::EventsClosed => events_open = false,
            SmokeActivity::EventFailed(error) => {
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
