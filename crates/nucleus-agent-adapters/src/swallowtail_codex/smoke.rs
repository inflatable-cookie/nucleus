//! Separately confirmed, read-only Codex diagnostic over Swallowtail.
//!
//! This is deliberately not a product execution port. The caller owns the
//! confirmation gate and durable evidence; this module owns only provider
//! transport, normalized observation, and cleanup.

use futures_executor::block_on;
use std::future::poll_fn;
use std::path::Path;
use std::sync::Arc;
use std::task::Poll;
use std::time::Duration;
use swallowtail_adapter_codex::CodexAppServerDriver;
use swallowtail_core::ReasoningMode;
use swallowtail_runtime::{
    CleanupOutcome, InteractiveSessionDriver, OpenSessionRequest, OperationContent, RuntimeFailure,
    RuntimeTurnId, SessionOptions, TerminalOutcome, TerminalStatus, TurnHandle, TurnRequest,
};

use super::{host, preflight, request_id, runtime_error, REQUEST_SEQUENCE};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexReadOnlySmokeStatus {
    Completed,
    Failed(String),
    TimedOut,
    CleanupRequired(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexReadOnlySmokeCleanup {
    Completed,
    Failed(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexReadOnlySmokeOutcome {
    pub provider_turn_started: bool,
    pub thread_id: String,
    pub turn_id: String,
    pub turn_status: String,
    pub events_seen: usize,
    pub provider_requests_seen: usize,
    pub status: CodexReadOnlySmokeStatus,
    pub cleanup: CodexReadOnlySmokeCleanup,
}

pub fn run_codex_read_only_smoke(
    working_directory: &Path,
    model: &str,
    reasoning_effort: &str,
    prompt: &str,
    timeout: Duration,
) -> Result<CodexReadOnlySmokeOutcome, String> {
    let reasoning = ReasoningMode::new(reasoning_effort).map_err(|error| error.to_string())?;
    let plan = preflight::session_plan(model, reasoning.clone(), 0, 0).map_err(runtime_error)?;
    let host = Arc::new(host::local_host(working_directory)?);
    let services = host::services(&host);
    let options = SessionOptions::default()
        .with_developer_instructions(
            OperationContent::new(
                "Run the requested read-only connectivity check. Do not call tools or modify files.",
            )
            .map_err(|error| error.to_string())?,
        )
        .with_reasoning_mode(reasoning);
    let mut session = block_on(
        CodexAppServerDriver::new(host::environment_ref()?).open_session(
            plan,
            OpenSessionRequest::new(
                request_id("diagnostic-session")?,
                host::working_resource_ref()?,
                None,
            )
            .with_options(options),
            services.clone(),
        ),
    )
    .map_err(runtime_error)?;
    let thread_id = match session.provider_session_ref() {
        Some(reference) => reference.as_provider_value().to_owned(),
        None => {
            let cleanup = block_on(session.close());
            return Err(format!(
                "Codex diagnostic session returned no provider thread id; session_cleanup={}",
                cleanup_label(&cleanup)
            ));
        }
    };
    let deadline = match services.time() {
        Some(time) => host::deadline_after(time.as_ref(), timeout),
        None => {
            let cleanup = block_on(session.close());
            return Err(format!(
                "Codex diagnostic time service is unavailable; session_cleanup={}",
                cleanup_label(&cleanup)
            ));
        }
    };
    let turn = block_on(
        session.start_turn(
            TurnRequest::new(
                diagnostic_turn_id()?,
                OperationContent::new(prompt).map_err(|error| error.to_string())?,
            )
            .with_deadline(deadline),
            services,
        ),
    );
    let mut turn = match turn {
        Ok(turn) => turn,
        Err(error) => {
            let cleanup = block_on(session.close());
            return Err(format!(
                "{}; session_cleanup={}",
                runtime_error(error),
                cleanup_label(&cleanup)
            ));
        }
    };
    let turn_id = match turn.provider_turn_ref() {
        Some(reference) => reference.as_provider_value().to_owned(),
        None => {
            let _ = block_on(turn.cancellation().request());
            let turn_cleanup = block_on(turn.close());
            let session_cleanup = block_on(session.close());
            return Err(format!(
                "Codex diagnostic turn returned no provider turn id; turn_cleanup={}, session_cleanup={}",
                cleanup_label(&turn_cleanup),
                cleanup_label(&session_cleanup)
            ));
        }
    };

    let observation = block_on(drive_smoke_turn(turn.as_mut()));
    let turn_cleanup = block_on(turn.close());
    let session_cleanup = block_on(session.close());
    Ok(finish_outcome(
        thread_id,
        turn_id,
        observation,
        turn_cleanup,
        session_cleanup,
    ))
}

struct SmokeObservation {
    terminal: Result<TerminalOutcome, String>,
    events_seen: usize,
    provider_requests_seen: usize,
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

async fn drive_smoke_turn(turn: &mut dyn TurnHandle) -> SmokeObservation {
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

fn finish_outcome(
    thread_id: String,
    turn_id: String,
    observation: SmokeObservation,
    turn_cleanup: CleanupOutcome,
    session_cleanup: CleanupOutcome,
) -> CodexReadOnlySmokeOutcome {
    let cleanup = combined_cleanup(
        observation
            .terminal
            .as_ref()
            .ok()
            .map(TerminalOutcome::cleanup),
        &turn_cleanup,
        &session_cleanup,
    );
    let (turn_status, mut status) = match observation.terminal {
        Ok(terminal) => terminal_status(terminal.status()),
        Err(reason) => (
            "runtime_failed".to_owned(),
            CodexReadOnlySmokeStatus::Failed(reason),
        ),
    };
    if let CodexReadOnlySmokeCleanup::Failed(reason) = &cleanup {
        status = CodexReadOnlySmokeStatus::CleanupRequired(reason.clone());
    }
    CodexReadOnlySmokeOutcome {
        provider_turn_started: true,
        thread_id,
        turn_id,
        turn_status,
        events_seen: observation.events_seen,
        provider_requests_seen: observation.provider_requests_seen,
        status,
        cleanup,
    }
}

fn terminal_status(status: &TerminalStatus) -> (String, CodexReadOnlySmokeStatus) {
    match status {
        TerminalStatus::Completed => ("completed".to_owned(), CodexReadOnlySmokeStatus::Completed),
        TerminalStatus::TimedOut => ("timed_out".to_owned(), CodexReadOnlySmokeStatus::TimedOut),
        TerminalStatus::Cancelled => (
            "cancelled".to_owned(),
            CodexReadOnlySmokeStatus::Failed("Codex diagnostic turn was cancelled".to_owned()),
        ),
        TerminalStatus::ProviderRequestObserved(_) => (
            "provider_request_observed".to_owned(),
            CodexReadOnlySmokeStatus::Failed(
                "Codex diagnostic observed a disallowed provider request".to_owned(),
            ),
        ),
        TerminalStatus::ProviderFailed(diagnostic) => (
            "provider_failed".to_owned(),
            CodexReadOnlySmokeStatus::Failed(format!(
                "Codex provider failed: {}",
                diagnostic.message()
            )),
        ),
        TerminalStatus::HostFailed(diagnostic) => (
            "host_failed".to_owned(),
            CodexReadOnlySmokeStatus::Failed(format!(
                "Codex host failed: {}",
                diagnostic.message()
            )),
        ),
        TerminalStatus::RuntimeFailed(diagnostic) => (
            "runtime_failed".to_owned(),
            CodexReadOnlySmokeStatus::Failed(format!(
                "Codex runtime failed: {}",
                diagnostic.message()
            )),
        ),
    }
}

fn combined_cleanup(
    terminal: Option<&CleanupOutcome>,
    turn: &CleanupOutcome,
    session: &CleanupOutcome,
) -> CodexReadOnlySmokeCleanup {
    if [terminal, Some(turn), Some(session)]
        .into_iter()
        .flatten()
        .any(cleanup_failed)
    {
        CodexReadOnlySmokeCleanup::Failed(format!(
            "terminal_cleanup={}, turn_cleanup={}, session_cleanup={}",
            terminal.map(cleanup_label).unwrap_or("unknown"),
            cleanup_label(turn),
            cleanup_label(session)
        ))
    } else {
        CodexReadOnlySmokeCleanup::Completed
    }
}

fn cleanup_failed(cleanup: &CleanupOutcome) -> bool {
    matches!(
        cleanup,
        CleanupOutcome::Degraded(_) | CleanupOutcome::Failed(_)
    )
}

fn cleanup_label(cleanup: &CleanupOutcome) -> &'static str {
    match cleanup {
        CleanupOutcome::Clean => "clean",
        CleanupOutcome::Degraded(_) => "degraded",
        CleanupOutcome::Failed(_) => "failed",
        CleanupOutcome::NotApplicable => "not_applicable",
    }
}

fn diagnostic_turn_id() -> Result<RuntimeTurnId, String> {
    RuntimeTurnId::new(format!(
        "nucleus-diagnostic-turn-{}",
        REQUEST_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ))
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use swallowtail_core::SafeDiagnostic;

    fn observation(status: TerminalStatus, cleanup: CleanupOutcome) -> SmokeObservation {
        SmokeObservation {
            terminal: Ok(TerminalOutcome::new(status, cleanup)),
            events_seen: 4,
            provider_requests_seen: 0,
        }
    }

    #[test]
    fn completed_smoke_preserves_safe_refs_counts_and_cleanup() {
        let outcome = finish_outcome(
            "thread-1".to_owned(),
            "turn-1".to_owned(),
            observation(TerminalStatus::Completed, CleanupOutcome::Clean),
            CleanupOutcome::Clean,
            CleanupOutcome::Clean,
        );

        assert_eq!(outcome.thread_id, "thread-1");
        assert_eq!(outcome.turn_id, "turn-1");
        assert_eq!(outcome.events_seen, 4);
        assert_eq!(outcome.status, CodexReadOnlySmokeStatus::Completed);
        assert_eq!(outcome.cleanup, CodexReadOnlySmokeCleanup::Completed);
    }

    #[test]
    fn cleanup_uncertainty_overrides_provider_completion() {
        let outcome = finish_outcome(
            "thread-1".to_owned(),
            "turn-1".to_owned(),
            observation(TerminalStatus::Completed, CleanupOutcome::Clean),
            CleanupOutcome::Clean,
            CleanupOutcome::Failed(SafeDiagnostic::new("fixture", "cleanup failed")),
        );

        assert!(matches!(
            outcome.status,
            CodexReadOnlySmokeStatus::CleanupRequired(_)
        ));
        assert!(matches!(
            outcome.cleanup,
            CodexReadOnlySmokeCleanup::Failed(_)
        ));
    }

    #[test]
    fn timeout_remains_distinct() {
        let outcome = finish_outcome(
            "thread-1".to_owned(),
            "turn-1".to_owned(),
            observation(TerminalStatus::TimedOut, CleanupOutcome::NotApplicable),
            CleanupOutcome::Clean,
            CleanupOutcome::Clean,
        );

        assert_eq!(outcome.status, CodexReadOnlySmokeStatus::TimedOut);
        assert_eq!(outcome.turn_status, "timed_out");
    }
}
