//! Codex read-only smoke: one bounded provider session proving transport and
//! protocol readiness without tool calls or file mutation.
//!
//! Module index over the smoke surface: the runner, turn driving, and
//! outcome composition.

mod drive;
mod outcome;
#[cfg(test)]
mod tests;

use std::path::Path;
use std::time::Duration;

use futures_executor::block_on;
use swallowtail_adapter_codex::{CodexAppServerDriver, CodexSessionProfileInput};
use swallowtail_core::ReasoningMode;
use swallowtail_runtime::{
    InteractiveSessionDriver, OperationContent, SessionOptions, TurnRequest,
};

use super::{host, preparation, request_id, runtime_error, runtime_turn_id};

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
    let host = host::local_host(working_directory)?;
    let services = host.services();
    let prepared = block_on(preparation::app_server(&host))?;
    let driver = CodexAppServerDriver::new(prepared.environment().clone());
    let options = SessionOptions::default()
        .with_developer_instructions(
            OperationContent::new(
                "Run the requested read-only connectivity check. Do not call tools or modify files.",
            )
            .map_err(|error| error.to_string())?,
        )
        .with_reasoning_mode(reasoning);
    let prepared_session = prepared
        .prepare_read_only_session(CodexSessionProfileInput::new(
            request_id("diagnostic-session")?,
            preparation::model(model)?,
            host.working_resource().clone(),
            None,
            options,
        ))
        .map_err(preparation::error)?;
    let (_, plan, open_request) = prepared_session.into_parts();
    let mut session = block_on(driver.open_session(plan, open_request, services.clone()))
        .map_err(runtime_error)?;
    let thread_id = match session.provider_session_ref() {
        Some(reference) => reference.as_provider_value().to_owned(),
        None => {
            let cleanup = block_on(
                session.close(host::cleanup_request(&services, timeout), services.clone()),
            );
            return Err(format!(
                "Codex diagnostic session returned no provider thread id; session_cleanup={}",
                outcome::cleanup_label(&cleanup)
            ));
        }
    };
    let deadline = match services.time() {
        Some(time) => host::deadline_after(time.as_ref(), timeout),
        None => {
            let cleanup = block_on(
                session.close(host::cleanup_request(&services, timeout), services.clone()),
            );
            return Err(format!(
                "Codex diagnostic time service is unavailable; session_cleanup={}",
                outcome::cleanup_label(&cleanup)
            ));
        }
    };
    let turn = block_on(
        session.start_turn(
            TurnRequest::new(
                runtime_turn_id("diagnostic")?,
                OperationContent::new(prompt).map_err(|error| error.to_string())?,
            )
            .with_deadline(deadline),
            services.clone(),
        ),
    );
    let mut turn = match turn {
        Ok(turn) => turn,
        Err(error) => {
            let cleanup = block_on(
                session.close(host::cleanup_request(&services, timeout), services.clone()),
            );
            return Err(format!(
                "{}; session_cleanup={}",
                runtime_error(error),
                outcome::cleanup_label(&cleanup)
            ));
        }
    };
    let turn_id = match turn.provider_turn_ref() {
        Some(reference) => reference.as_provider_value().to_owned(),
        None => {
            let _ = block_on(turn.cancellation().request());
            let turn_cleanup = block_on(turn.close());
            let session_cleanup = block_on(
                session.close(host::cleanup_request(&services, timeout), services.clone()),
            );
            return Err(format!(
                "Codex diagnostic turn returned no provider turn id; turn_cleanup={}, session_cleanup={}",
                outcome::cleanup_label(&turn_cleanup),
                outcome::cleanup_label(&session_cleanup)
            ));
        }
    };

    let observation = block_on(drive::drive_smoke_turn(turn.as_mut()));
    let turn_cleanup = block_on(turn.close());
    let session_cleanup =
        block_on(session.close(host::cleanup_request(&services, timeout), services));
    Ok(outcome::finish_outcome(
        thread_id,
        turn_id,
        observation,
        turn_cleanup,
        session_cleanup,
    ))
}
