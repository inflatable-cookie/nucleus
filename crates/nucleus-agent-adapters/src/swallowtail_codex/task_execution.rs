use nucleus_agent_protocol::{
    TaskExecutionLinkage, TaskExecutionOutcome, TaskExecutionRequest, TaskExecutionRuntime,
    TaskExecutionStartedHandler,
};
use std::future::poll_fn;
use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::task::Poll;
use std::thread;
use swallowtail_adapter_codex::{
    codex_approval_request_extension, codex_bounded_workspace_access_policy,
    codex_user_input_request_extension, CodexAppServerDriver,
};
use swallowtail_core::ReasoningMode;
use swallowtail_runtime::{
    CallbackRequestKind, CleanupOutcome, InteractiveSessionDriver, OpenSessionRequest,
    OperationContent, RuntimeFailure, RuntimeTurnId, SessionOptions, TerminalOutcome,
    TerminalStatus, TurnHandle, TurnRequest,
};

use super::{host, preflight, request_id, runtime_error};

pub const CODEX_PROVIDER_INSTANCE_ID: &str = "codex:local-default";

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
        let plan = preflight::task_session_plan(&request.model, reasoning.clone())
            .map_err(runtime_error)?;
        let host = Arc::new(host::local_host(Path::new(&request.working_directory))?);
        let services = host::services(&host);
        let options = SessionOptions::default()
            .with_developer_instructions(
                OperationContent::new(request.developer_instructions)
                    .map_err(|error| error.to_string())?,
            )
            .with_reasoning_mode(reasoning);
        let prompt = OperationContent::new(request.prompt).map_err(|error| error.to_string())?;
        let runtime_turn_id = task_turn_id()?;
        let mut session = block_on_worker(
            CodexAppServerDriver::new(host::environment_ref()?).open_session(
                plan,
                OpenSessionRequest::new(
                    request_id("task-session")?,
                    host::working_resource_ref()?,
                    None,
                )
                .with_options(options)
                .with_access_policy(codex_bounded_workspace_access_policy()),
                services.clone(),
            ),
        )
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
                reason: cleanup_reason(
                    &format!("failed to persist provider start linkage: {reason}"),
                    None,
                    &turn_cleanup,
                    &session_cleanup,
                ),
            });
        }

        let terminal = block_on_worker(drive_task_turn(turn.as_mut()));
        let turn_cleanup = block_on_worker(turn.close());
        let session_cleanup = block_on_worker(session.close());
        Ok(map_outcome(
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

enum TaskTurnActivity {
    Terminal(TerminalOutcome),
    Callback(CallbackRequestKind),
    CallbackClosed,
    CallbackFailed(RuntimeFailure),
    Event,
    EventsClosed,
    EventFailed(RuntimeFailure),
}

async fn drive_task_turn(turn: &mut dyn TurnHandle) -> Result<TerminalOutcome, String> {
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

fn map_outcome(
    linkage: TaskExecutionLinkage,
    terminal: Result<TerminalOutcome, String>,
    turn_cleanup: CleanupOutcome,
    session_cleanup: CleanupOutcome,
) -> TaskExecutionOutcome {
    let terminal = match terminal {
        Ok(terminal) => terminal,
        Err(reason) => {
            return TaskExecutionOutcome::RecoveryRequired {
                linkage: Some(linkage),
                reason: cleanup_reason(&reason, None, &turn_cleanup, &session_cleanup),
            };
        }
    };
    if cleanup_failed(terminal.cleanup())
        || cleanup_failed(&turn_cleanup)
        || cleanup_failed(&session_cleanup)
    {
        return TaskExecutionOutcome::RecoveryRequired {
            linkage: Some(linkage),
            reason: cleanup_reason(
                "Codex task execution ended with uncertain cleanup",
                Some(terminal.cleanup()),
                &turn_cleanup,
                &session_cleanup,
            ),
        };
    }
    match terminal.status() {
        TerminalStatus::Completed => TaskExecutionOutcome::Completed(linkage),
        TerminalStatus::Cancelled => TaskExecutionOutcome::Cancelled {
            linkage: Some(linkage),
            reason: "Codex task turn was cancelled.".to_owned(),
        },
        TerminalStatus::TimedOut => TaskExecutionOutcome::RecoveryRequired {
            linkage: Some(linkage),
            reason: "Codex task turn timed out; workspace state requires recovery review."
                .to_owned(),
        },
        TerminalStatus::ProviderRequestObserved(observation)
            if observation.namespace() == &codex_approval_request_extension() =>
        {
            TaskExecutionOutcome::WaitingForApproval(linkage)
        }
        TerminalStatus::ProviderRequestObserved(observation)
            if observation.namespace() == &codex_user_input_request_extension() =>
        {
            TaskExecutionOutcome::WaitingForUserInput(linkage)
        }
        TerminalStatus::ProviderRequestObserved(_) => TaskExecutionOutcome::Failed {
            linkage: Some(linkage),
            reason: "Codex task turn observed an undeclared provider request.".to_owned(),
        },
        TerminalStatus::ProviderFailed(diagnostic) => TaskExecutionOutcome::Failed {
            linkage: Some(linkage),
            reason: format!("Codex provider failed: {}", diagnostic.message()),
        },
        TerminalStatus::HostFailed(diagnostic) => TaskExecutionOutcome::Failed {
            linkage: Some(linkage),
            reason: format!("Codex host failed: {}", diagnostic.message()),
        },
        TerminalStatus::RuntimeFailed(diagnostic) => TaskExecutionOutcome::Failed {
            linkage: Some(linkage),
            reason: format!("Codex runtime failed: {}", diagnostic.message()),
        },
    }
}

fn cleanup_failed(cleanup: &CleanupOutcome) -> bool {
    matches!(
        cleanup,
        CleanupOutcome::Degraded(_) | CleanupOutcome::Failed(_)
    )
}

fn cleanup_reason(
    reason: &str,
    terminal: Option<&CleanupOutcome>,
    turn: &CleanupOutcome,
    session: &CleanupOutcome,
) -> String {
    format!(
        "{reason}; terminal_cleanup={}, turn_cleanup={}, session_cleanup={}",
        cleanup_label(terminal.unwrap_or(&CleanupOutcome::NotApplicable)),
        cleanup_label(turn),
        cleanup_label(session)
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

fn task_turn_id() -> Result<RuntimeTurnId, String> {
    RuntimeTurnId::new(format!(
        "nucleus-task-turn-{}",
        super::REQUEST_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ))
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use swallowtail_core::{ProviderRequestRef, SafeDiagnostic};
    use swallowtail_runtime::{CallbackId, ProviderRequestObservation};

    fn linkage() -> TaskExecutionLinkage {
        TaskExecutionLinkage {
            session_id: "session-1".to_owned(),
            thread_id: "thread-1".to_owned(),
            turn_id: "turn-1".to_owned(),
        }
    }

    fn observed(namespace: swallowtail_core::ExtensionNamespace) -> TerminalOutcome {
        TerminalOutcome::new(
            TerminalStatus::ProviderRequestObserved(ProviderRequestObservation::new(
                CallbackId::new("callback-1").expect("callback id"),
                namespace,
                ProviderRequestRef::new("provider-request-1").expect("provider request"),
            )),
            CleanupOutcome::NotApplicable,
        )
    }

    #[test]
    fn provider_requests_keep_approval_and_user_input_distinct() {
        assert!(matches!(
            map_outcome(
                linkage(),
                Ok(observed(codex_approval_request_extension())),
                CleanupOutcome::NotApplicable,
                CleanupOutcome::Clean,
            ),
            TaskExecutionOutcome::WaitingForApproval(_)
        ));
        assert!(matches!(
            map_outcome(
                linkage(),
                Ok(observed(codex_user_input_request_extension())),
                CleanupOutcome::NotApplicable,
                CleanupOutcome::Clean,
            ),
            TaskExecutionOutcome::WaitingForUserInput(_)
        ));
    }

    #[test]
    fn task_futures_can_run_from_inside_an_existing_local_executor() {
        let result = futures_executor::block_on(async { block_on_worker(async { 42 }) });

        assert_eq!(result, 42);
    }

    #[test]
    fn timeout_and_cleanup_uncertainty_require_recovery() {
        let timeout = TerminalOutcome::new(TerminalStatus::TimedOut, CleanupOutcome::NotApplicable);
        assert!(matches!(
            map_outcome(
                linkage(),
                Ok(timeout),
                CleanupOutcome::NotApplicable,
                CleanupOutcome::Clean,
            ),
            TaskExecutionOutcome::RecoveryRequired { .. }
        ));
        let completed =
            TerminalOutcome::new(TerminalStatus::Completed, CleanupOutcome::NotApplicable);
        assert!(matches!(
            map_outcome(
                linkage(),
                Ok(completed),
                CleanupOutcome::NotApplicable,
                CleanupOutcome::Failed(SafeDiagnostic::new("fixture.cleanup", "cleanup failed",)),
            ),
            TaskExecutionOutcome::RecoveryRequired { .. }
        ));
    }

    #[test]
    fn completed_cancelled_and_failed_outcomes_remain_distinct() {
        assert!(matches!(
            map_outcome(
                linkage(),
                Ok(TerminalOutcome::new(
                    TerminalStatus::Completed,
                    CleanupOutcome::NotApplicable,
                )),
                CleanupOutcome::NotApplicable,
                CleanupOutcome::Clean,
            ),
            TaskExecutionOutcome::Completed(_)
        ));
        assert!(matches!(
            map_outcome(
                linkage(),
                Ok(TerminalOutcome::new(
                    TerminalStatus::Cancelled,
                    CleanupOutcome::NotApplicable,
                )),
                CleanupOutcome::NotApplicable,
                CleanupOutcome::Clean,
            ),
            TaskExecutionOutcome::Cancelled { .. }
        ));
        assert!(matches!(
            map_outcome(
                linkage(),
                Ok(TerminalOutcome::new(
                    TerminalStatus::ProviderFailed(SafeDiagnostic::new(
                        "fixture.provider",
                        "provider failed",
                    )),
                    CleanupOutcome::NotApplicable,
                )),
                CleanupOutcome::NotApplicable,
                CleanupOutcome::Clean,
            ),
            TaskExecutionOutcome::Failed { .. }
        ));
    }
}
