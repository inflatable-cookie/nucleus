//! Swallowtail Codex task execution runtime.
//!
//! Module index over the task execution surface: the runtime adapter, turn
//! driving, and outcome mapping.

mod drive;
mod outcome;
#[cfg(test)]
mod tests;

use std::future::Future;
use std::path::Path;
use std::thread;

use nucleus_agent_protocol::{
    TaskExecutionLinkage, TaskExecutionOutcome, TaskExecutionRequest, TaskExecutionRuntime,
    TaskExecutionStartedHandler,
};
use swallowtail_adapter_codex::{
    CodexAppServerDriver, CodexSessionProfileInput,
};
use swallowtail_core::ReasoningMode;
use swallowtail_runtime::{
    InteractiveSessionDriver, OperationContent, SessionOptions, TurnRequest,
};

use super::{host, idioms, preparation, request_id, runtime_error};

pub const CODEX_PROVIDER_INSTANCE_ID: &str = "codex:local-default";

#[derive(Debug)]
pub struct SwallowtailCodexTaskExecutionRuntime;

impl TaskExecutionRuntime for SwallowtailCodexTaskExecutionRuntime {
    fn adapter_id(&self) -> &str {
        super::CODEX_LIVE_ADAPTER_ID
    }

    fn execute(
        &self,
        request: TaskExecutionRequest,
        on_started: &mut TaskExecutionStartedHandler<'_>,
    ) -> Result<TaskExecutionOutcome, String> {
        if request.provider_instance_id != CODEX_PROVIDER_INSTANCE_ID {
            return Err(format!(
                "task route selected unsupported provider instance {}",
                request.provider_instance_id
            ));
        }
        if request.session_id.trim().is_empty() {
            return Err("task execution requires a Nucleus session id".to_owned());
        }
        let reasoning =
            ReasoningMode::new(&request.reasoning_effort).map_err(|error| error.to_string())?;
        let project_root = Path::new(&request.working_directory);
        let host = host::local_host(project_root)?;
        let wiring = idioms::wiring(project_root, request.idioms_enabled);
        let services = match wiring.source() {
            Some(source) => host.services().with_idiom_source(source),
            None => host.services(),
        };
        let prepared = block_on_worker(preparation::app_server(&host))?;
        let driver = CodexAppServerDriver::new(prepared.environment().clone());
        let mut options = SessionOptions::default()
            .with_developer_instructions(
                OperationContent::new(request.developer_instructions)
                    .map_err(|error| error.to_string())?,
            )
            .with_reasoning_mode(reasoning);
        if let Some(idiom_option) = wiring.option() {
            options = options.with_idioms(idiom_option);
        }
        let prompt = OperationContent::new(request.prompt).map_err(|error| error.to_string())?;
        let runtime_turn_id = super::runtime_turn_id("task")?;
        let prepared_session = prepared
            .prepare_bounded_workspace_session(CodexSessionProfileInput::new(
                request_id("task-session")?,
                preparation::model(&request.model)?,
                host.working_resource().clone(),
                None,
                options,
            ))
            .map_err(preparation::error)?;
        let (_, plan, open_request) = prepared_session.into_parts();
        let mut session =
            block_on_worker(driver.open_session(plan, open_request, services.clone()))
                .map_err(runtime_error)?;
        let provider_thread_id = match session.provider_session_ref() {
            Some(reference) => reference.as_provider_value().to_owned(),
            None => {
                let _ = block_on_worker(session.close());
                return Err("Codex task session did not return a provider thread id".to_owned());
            }
        };
        let deadline = match services.time() {
            Some(time) => host::deadline_after(time.as_ref(), request.timeout),
            None => {
                let _ = block_on_worker(session.close());
                return Err("Codex task time service is unavailable".to_owned());
            }
        };
        let turn = block_on_worker(session.start_turn(
            TurnRequest::new(runtime_turn_id, prompt).with_deadline(deadline),
            services,
        ));
        let mut turn = match turn {
            Ok(turn) => turn,
            Err(error) => {
                let _ = block_on_worker(session.close());
                return Err(runtime_error(error));
            }
        };
        let provider_turn_id = match turn.provider_turn_ref() {
            Some(reference) => reference.as_provider_value().to_owned(),
            None => {
                let _ = block_on_worker(turn.cancellation().request());
                let _ = block_on_worker(turn.close());
                let _ = block_on_worker(session.close());
                return Err("Codex task turn did not return a provider turn id".to_owned());
            }
        };
        let linkage = TaskExecutionLinkage {
            session_id: request.session_id,
            thread_id: provider_thread_id,
            turn_id: provider_turn_id,
        };
        if let Err(reason) = on_started(&linkage) {
            let _ = block_on_worker(turn.cancellation().request());
            let turn_cleanup = block_on_worker(turn.close());
            let session_cleanup = block_on_worker(session.close());
            return Ok(TaskExecutionOutcome::RecoveryRequired {
                linkage: Some(linkage),
                reason: outcome::cleanup_reason(
                    &format!("failed to persist provider start linkage: {reason}"),
                    None,
                    &turn_cleanup,
                    &session_cleanup,
                ),
            });
        }

        let terminal = block_on_worker(drive::drive_task_turn(turn.as_mut()));
        let turn_cleanup = block_on_worker(turn.close());
        let session_cleanup = block_on_worker(session.close());
        Ok(outcome::map_outcome(
            linkage,
            terminal,
            turn_cleanup,
            session_cleanup,
        ))
    }
}

fn block_on_worker<F>(future: F) -> F::Output
where
    F: Future + Send,
    F::Output: Send,
{
    thread::scope(|scope| {
        scope
            .spawn(move || futures_executor::block_on(future))
            .join()
            .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
    })
}
