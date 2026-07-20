//! Nucleus translation layer over Swallowtail's Codex app-server driver.
//!
//! Nucleus retains its blocking consumer facade, tool semantics, receipts, and
//! persisted records. Swallowtail owns provider process, protocol, callback,
//! timeout, capability negotiation, event normalization, and cleanup mechanics.

use futures_executor::block_on;
use nucleus_agent_protocol::{
    AgentLiveSession, AgentModelOption, AgentReasoningOption, AgentSessionRuntime,
    AgentSessionStartRequest, AgentStartedSessionInfo, AgentToolCallHandler, AgentTurnReply,
    AgentTurnRequest,
};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use swallowtail_adapter_codex::CodexAppServerDriver;
use swallowtail_core::ReasoningMode;
use swallowtail_runtime::{
    HostServices, InteractiveSessionDriver, InteractiveSessionHandle, ModelCatalogDriver,
    ModelCatalogRequest, OpenSessionRequest, OperationContent, RequestId, RuntimeFailure,
    RuntimeTurnId, SchemaDocument, SessionOptions, TurnRequest,
};

mod host;
mod preflight;
mod smoke;
mod task_execution;
mod tools;
mod turn;

pub use smoke::{
    run_codex_read_only_smoke, CodexReadOnlySmokeCleanup, CodexReadOnlySmokeOutcome,
    CodexReadOnlySmokeStatus,
};
pub use task_execution::{SwallowtailCodexTaskExecutionRuntime, CODEX_PROVIDER_INSTANCE_ID};

use tools::tool_declarations;
use turn::{completed_output, drive_turn, require_clean_turn};

pub const CODEX_LIVE_ADAPTER_ID: &str = "codex-app-server";

const CATALOG_TIMEOUT: Duration = Duration::from_secs(30);
const TURN_TIMEOUT: Duration = Duration::from_secs(180);

static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

pub struct SwallowtailCodexSessionRuntime;

impl AgentSessionRuntime for SwallowtailCodexSessionRuntime {
    fn adapter_id(&self) -> &str {
        CODEX_LIVE_ADAPTER_ID
    }

    fn start_session(
        &self,
        request: AgentSessionStartRequest,
    ) -> Result<Box<dyn AgentLiveSession + Send>, String> {
        if request.resume_provider_thread_id.is_some() {
            return Err(
                "stored tool-enabled Codex sessions must reopen with transcript context".to_owned(),
            );
        }
        let tools = tool_declarations(request.dynamic_tools)?;
        let reasoning =
            ReasoningMode::new(&request.reasoning_effort).map_err(|error| error.to_string())?;
        let maximum_schema_bytes = tools
            .iter()
            .map(|tool| match tool.input_schema() {
                SchemaDocument::Inline(bytes) => bytes.len(),
                SchemaDocument::Reference(_) => 0,
            })
            .max()
            .unwrap_or(0);
        let plan = preflight::session_plan(
            &request.model,
            reasoning.clone(),
            u32::try_from(tools.len()).unwrap_or(u32::MAX),
            u64::try_from(maximum_schema_bytes).unwrap_or(u64::MAX),
        )
        .map_err(runtime_error)?;
        let host = Arc::new(host::local_host(Path::new(&request.working_directory))?);
        let services = host::services(&host);
        let options = SessionOptions::default()
            .with_developer_instructions(
                OperationContent::new(request.developer_instructions)
                    .map_err(|error| error.to_string())?,
            )
            .with_reasoning_mode(reasoning)
            .with_tools(tools);
        let session = block_on(
            CodexAppServerDriver::new(host::environment_ref()?).open_session(
                plan,
                OpenSessionRequest::new(
                    request_id("session")?,
                    host::working_resource_ref()?,
                    None,
                )
                .with_options(options),
                services.clone(),
            ),
        )
        .map_err(runtime_error)?;
        let provider_thread_id = session
            .provider_session_ref()
            .ok_or_else(|| "Codex session did not return a provider thread id".to_owned())?
            .as_provider_value()
            .to_owned();

        Ok(Box::new(SwallowtailCodexLiveSession {
            info: AgentStartedSessionInfo {
                provider_thread_id,
                model: request.model,
                reasoning_effort: Some(request.reasoning_effort),
            },
            session: Some(session),
            services,
        }))
    }

    fn model_catalog(&self) -> Result<Vec<AgentModelOption>, String> {
        let current = std::env::current_dir()
            .map_err(|_| "Nucleus could not resolve its host working directory".to_owned())?;
        let host = Arc::new(host::local_host(&current)?);
        let services = host::services(&host);
        let deadline = host::deadline_after(host.as_ref(), CATALOG_TIMEOUT);
        let models = block_on(
            CodexAppServerDriver::new(host::environment_ref()?).list_models(
                preflight::catalog_plan().map_err(runtime_error)?,
                ModelCatalogRequest::new(request_id("catalog")?).with_deadline(deadline),
                services,
            ),
        )
        .map_err(runtime_error)?;

        Ok(models
            .into_iter()
            .map(|entry| {
                let metadata = entry.metadata();
                let reasoning = metadata.reasoning();
                AgentModelOption {
                    model: entry.id().as_str().to_owned(),
                    display_name: metadata
                        .display_name()
                        .unwrap_or_else(|| entry.id().as_str())
                        .to_owned(),
                    description: metadata.description().unwrap_or_default().to_owned(),
                    default_reasoning_effort: reasoning
                        .and_then(|value| value.default_mode())
                        .map(|mode| mode.as_str().to_owned())
                        .unwrap_or_else(|| "low".to_owned()),
                    supported_reasoning_efforts: reasoning
                        .map(|value| {
                            value
                                .supported_modes()
                                .map(|mode| AgentReasoningOption {
                                    reasoning_effort: mode.as_str().to_owned(),
                                    description: String::new(),
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                }
            })
            .collect())
    }
}

struct SwallowtailCodexLiveSession {
    info: AgentStartedSessionInfo,
    session: Option<Box<dyn InteractiveSessionHandle>>,
    services: HostServices,
}

impl AgentLiveSession for SwallowtailCodexLiveSession {
    fn info(&self) -> &AgentStartedSessionInfo {
        &self.info
    }

    fn send_turn(
        &mut self,
        request: AgentTurnRequest,
        on_tool_call: &mut AgentToolCallHandler<'_>,
    ) -> Result<AgentTurnReply, String> {
        if request.model != self.info.model
            || Some(request.reasoning_effort.as_str()) != self.info.reasoning_effort.as_deref()
        {
            return Err("chat route changed; reopen the provider session".to_owned());
        }
        let session = self
            .session
            .as_mut()
            .ok_or_else(|| "Codex session is already closed".to_owned())?;
        let deadline = self
            .services
            .time()
            .map(|time| host::deadline_after(time.as_ref(), TURN_TIMEOUT))
            .ok_or_else(|| "Codex turn time service is unavailable".to_owned())?;
        let mut turn = block_on(
            session.start_turn(
                TurnRequest::new(
                    runtime_turn_id()?,
                    OperationContent::new(request.message).map_err(|error| error.to_string())?,
                )
                .with_deadline(deadline),
                self.services.clone(),
            ),
        )
        .map_err(runtime_error)?;
        let provider_turn_id = turn
            .provider_turn_ref()
            .ok_or_else(|| "Codex turn did not return a provider turn id".to_owned())?
            .as_provider_value()
            .to_owned();
        let outcome = block_on(drive_turn(turn.as_mut(), &provider_turn_id, on_tool_call));
        let cleanup = block_on(turn.close());
        let outcome = outcome?;
        require_clean_turn(cleanup)?;
        let assistant_message = completed_output(&outcome)?;

        Ok(AgentTurnReply {
            turn_id: provider_turn_id,
            assistant_message,
        })
    }
}

impl Drop for SwallowtailCodexLiveSession {
    fn drop(&mut self) {
        if let Some(session) = self.session.take() {
            let _ = block_on(session.close());
        }
    }
}

fn request_id(kind: &str) -> Result<RequestId, String> {
    RequestId::new(format!(
        "nucleus-{kind}-{}",
        REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ))
    .map_err(|error| error.to_string())
}

fn runtime_turn_id() -> Result<RuntimeTurnId, String> {
    RuntimeTurnId::new(format!(
        "nucleus-chat-turn-{}",
        REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ))
    .map_err(|error| error.to_string())
}

fn runtime_error(error: RuntimeFailure) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::turn::callback_response;
    use super::*;
    use nucleus_agent_protocol::AgentToolCall;
    use serde_json::json;
    use swallowtail_runtime::{
        CallbackId, CallbackPayload, CallbackRequest, CallbackResult, CleanupOutcome,
        TerminalOutcome, TerminalStatus,
    };

    #[test]
    fn nucleus_tool_specs_map_to_bounded_swallowtail_declarations() {
        let tools = tool_declarations(vec![json!({
            "type": "function",
            "name": "task_ledger",
            "description": "Inspect tasks",
            "inputSchema": { "type": "object" }
        })])
        .expect("tool declaration");

        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name(), "task_ledger");
        assert_eq!(
            tools[0].description().map(OperationContent::as_str),
            Some("Inspect tasks")
        );
    }

    #[test]
    fn callback_bridge_preserves_provider_turn_and_callback_identity() {
        let request = CallbackRequest::tool_call(
            CallbackId::new("callback-1").expect("callback id"),
            RuntimeTurnId::new("runtime-turn-1").expect("turn id"),
            1,
            None,
            "task_ledger",
            CallbackPayload::new(br#"{"action":"inspect"}"#.to_vec(), 1024).expect("arguments"),
        )
        .expect("callback request");
        let mut observed = None;
        let mut handler = |call: AgentToolCall| {
            observed = Some(call);
            Ok("done".to_owned())
        };

        let response = callback_response(&request, "provider-turn-1", &mut handler);
        let call = observed.expect("tool call reached Nucleus");
        assert_eq!(call.tool, "task_ledger");
        assert_eq!(call.turn_id, "provider-turn-1");
        assert_eq!(call.call_id, "callback-1");
        assert!(matches!(response.result(), CallbackResult::Success(_)));
    }

    #[test]
    fn completed_turn_requires_non_empty_output() {
        let outcome =
            TerminalOutcome::new(TerminalStatus::Completed, CleanupOutcome::NotApplicable);

        assert!(completed_output(&outcome).is_err());
    }

    #[test]
    fn stored_tool_enabled_provider_ids_are_rejected_before_process_work() {
        let failure = SwallowtailCodexSessionRuntime
            .start_session(AgentSessionStartRequest {
                working_directory: "/not/used".to_owned(),
                model: "gpt-5.4-mini".to_owned(),
                reasoning_effort: "low".to_owned(),
                developer_instructions: "instructions".to_owned(),
                dynamic_tools: Vec::new(),
                resume_provider_thread_id: Some("thread:stored".to_owned()),
            })
            .err()
            .expect("unsafe resume is rejected");

        assert!(failure.contains("transcript context"));
    }
}
