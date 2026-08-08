//! Nucleus translation layer over Swallowtail's Codex app-server driver.
//!
//! Nucleus retains its blocking consumer facade, tool semantics, receipts, and
//! persisted records. Swallowtail owns provider process, protocol, callback,
//! timeout, capability negotiation, event normalization, and cleanup mechanics.

use futures_executor::block_on;
use nucleus_agent_protocol::{
    AgentActivityHandler, AgentHarnessMode, AgentLiveSession, AgentSessionRuntime,
    AgentSessionStartRequest, AgentStartedSessionInfo, AgentToolCallHandler, AgentTurnFailure,
    AgentTurnReply, AgentTurnRequest, AgentUserInputHandler,
};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use swallowtail_adapter_codex::{
    codex_app_server_descriptor, CodexAppServerDriver, CodexSessionProfileInput,
};
use swallowtail_core::{HarnessMode, ObservableActivityAvailability, ReasoningMode};
use swallowtail_runtime::{
    ConfiguredProviderInstanceAdmission, ConfiguredProviderInstanceRecord,
    ConfiguredProviderModelCatalogueInput, HostServices, InteractiveSessionDriver,
    InteractiveSessionHandle, OperationContent, RequestId, RuntimeFailure, RuntimeTurnId, ScopeId,
    SessionOptions, TurnRequest,
};

mod host;
mod preparation;
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
        let host = host::local_host(Path::new(&request.working_directory))?;
        let services = host.services();
        let prepared = block_on(preparation::app_server(&host))?;
        if prepared.instance().id().as_str() != request.provider_instance_id {
            return Err("selected provider instance does not match prepared Codex".to_owned());
        }
        if prepared.instance().revision().as_str() != request.provider_instance_revision {
            return Err("selected provider instance revision is stale".to_owned());
        }
        if prepared.instance().protocol_facade_id().as_str() != request.protocol_facade_id {
            return Err("selected protocol facade does not match prepared Codex".to_owned());
        }
        let driver = CodexAppServerDriver::new(prepared.environment().clone());
        let mut options = SessionOptions::default()
            .with_developer_instructions(
                OperationContent::new(request.developer_instructions)
                    .map_err(|error| error.to_string())?,
            )
            .with_reasoning_mode(reasoning)
            .with_tools(tools);
        if request.harness_mode == AgentHarnessMode::Plan {
            options = options.with_harness_mode(HarnessMode::Plan);
        }
        let prepared_session = prepared
            .prepare_read_only_session(
                CodexSessionProfileInput::new(
                    request_id("session")?,
                    preparation::model(&request.model)?,
                    host.working_resource().clone(),
                    None,
                    options,
                )
                .with_user_input_exchange(),
            )
            .map_err(preparation::error)?;
        if prepared_session
            .evidence()
            .operation()
            .observable_activity()
            .availability()
            != ObservableActivityAvailability::Available
        {
            return Err("Codex Agent Chat prepared without observable activity".to_owned());
        }
        let (_, plan, open_request) = prepared_session.into_parts();
        let session = block_on(driver.open_session(plan, open_request, services.clone()))
            .map_err(runtime_error)?;
        let provider_thread_id = session
            .provider_session_ref()
            .ok_or_else(|| "Codex session did not return a provider thread id".to_owned())?
            .as_provider_value()
            .to_owned();

        Ok(Box::new(SwallowtailCodexLiveSession {
            info: AgentStartedSessionInfo {
                provider_thread_id,
                adapter_id: CODEX_LIVE_ADAPTER_ID.to_owned(),
                provider_instance_id: request.provider_instance_id,
                provider_instance_revision: request.provider_instance_revision,
                protocol_facade_id: request.protocol_facade_id,
                provider_id: request.provider_id,
                model: request.model,
                reasoning_effort: Some(request.reasoning_effort),
                harness_mode: request.harness_mode,
            },
            session: Some(session),
            services,
            turn_timeout: request.turn_timeout,
        }))
    }

    fn configured_provider_instance(&self) -> Result<ConfiguredProviderInstanceRecord, String> {
        let current = std::env::current_dir()
            .map_err(|_| "Nucleus could not resolve its host working directory".to_owned())?;
        let host = host::local_host(&current)?;
        let services = host.services();
        let prepared = block_on(preparation::app_server(&host))?;
        let time = services
            .time()
            .ok_or_else(|| "Codex catalog time service is unavailable".to_owned())?;
        let deadline = host::deadline_after(time.as_ref(), CATALOG_TIMEOUT);
        let catalogue = prepared
            .prepare_catalogue(request_id("catalog")?, Some(deadline))
            .map_err(preparation::error)?;
        let source = catalogue.evidence().operation().clone();
        let model_catalogue = match block_on(catalogue.list_models(services)) {
            Ok(models) => ConfiguredProviderModelCatalogueInput::available(source.clone(), models),
            Err(error) => ConfiguredProviderModelCatalogueInput::unavailable(
                source.clone(),
                error.diagnostic().clone(),
            ),
        };
        let admission = ConfiguredProviderInstanceAdmission::new(
            codex_app_server_descriptor(),
            prepared.instance().clone(),
            prepared.access_profile().clone(),
            prepared.access_evidence().clone(),
        )
        .with_prepared_routes([source])
        .with_model_catalogue(model_catalogue);
        ConfiguredProviderInstanceRecord::admit(admission).map_err(|error| error.to_string())
    }
}

struct SwallowtailCodexLiveSession {
    info: AgentStartedSessionInfo,
    session: Option<Box<dyn InteractiveSessionHandle>>,
    services: HostServices,
    turn_timeout: Duration,
}

impl AgentLiveSession for SwallowtailCodexLiveSession {
    fn info(&self) -> &AgentStartedSessionInfo {
        &self.info
    }

    fn send_turn(
        &mut self,
        request: AgentTurnRequest,
        on_activity: &mut AgentActivityHandler<'_>,
        on_tool_call: &mut AgentToolCallHandler<'_>,
        on_user_input: &mut AgentUserInputHandler<'_>,
    ) -> Result<AgentTurnReply, AgentTurnFailure> {
        if request.model != self.info.model
            || Some(request.reasoning_effort.as_str()) != self.info.reasoning_effort.as_deref()
        {
            return Err(AgentTurnFailure::Failed(
                "chat route changed; reopen the provider session".to_owned(),
            ));
        }
        let session = self
            .session
            .as_mut()
            .ok_or_else(|| "Codex session is already closed".to_owned())?;
        let deadline = self
            .services
            .time()
            .map(|time| host::deadline_after(time.as_ref(), self.turn_timeout))
            .ok_or_else(|| "Codex turn time service is unavailable".to_owned())?;
        let mut turn = block_on(
            session.start_turn(
                TurnRequest::new(
                    runtime_turn_id("chat")?,
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
        let outcome = block_on(drive_turn(
            turn.as_mut(),
            &provider_turn_id,
            &request.cancellation,
            on_activity,
            on_tool_call,
            on_user_input,
        ));
        let cleanup = block_on(turn.close());
        let outcome = outcome?;
        require_clean_turn(cleanup)?;
        let assistant_message =
            completed_output(&outcome, self.info.harness_mode == AgentHarnessMode::Plan)?;

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

fn scope_id(kind: &str) -> Result<ScopeId, String> {
    ScopeId::new(format!(
        "nucleus-{kind}-{}",
        REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ))
    .map_err(|error| error.to_string())
}

fn runtime_turn_id(kind: &str) -> Result<RuntimeTurnId, String> {
    RuntimeTurnId::new(format!(
        "nucleus-{kind}-turn-{}",
        uuid::Uuid::new_v4().simple()
    ))
    .map_err(|error| error.to_string())
}

fn runtime_error(error: RuntimeFailure) -> String {
    format!(
        "[{}] {}",
        error.diagnostic().code(),
        error.diagnostic().message()
    )
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
    fn runtime_turn_ids_are_unique_across_retained_operations() {
        let first = runtime_turn_id("chat").expect("first runtime turn id");
        let second = runtime_turn_id("chat").expect("second runtime turn id");

        assert_ne!(first, second);
        for turn_id in [&first, &second] {
            let random_identity = turn_id
                .as_str()
                .strip_prefix("nucleus-chat-turn-")
                .expect("Nucleus chat prefix");
            uuid::Uuid::parse_str(random_identity).expect("UUID-backed runtime identity");
        }
    }

    #[test]
    fn runtime_errors_keep_the_safe_diagnostic_code() {
        let failure = RuntimeFailure::new(swallowtail_core::SafeDiagnostic::new(
            "swallowtail.codex.app_server.malformed_notification",
            "Codex app-server returned a malformed notification",
        ));

        assert_eq!(
            runtime_error(failure),
            "[swallowtail.codex.app_server.malformed_notification] Codex app-server returned a malformed notification"
        );
    }

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

        assert!(completed_output(&outcome, false).is_err());
        assert_eq!(completed_output(&outcome, true), Ok(None));

        let with_message = outcome
            .clone()
            .with_output(OperationContent::new("plan review follows").expect("output"));
        assert_eq!(
            completed_output(&with_message, true),
            Ok(Some("plan review follows".to_owned()))
        );
    }

    #[test]
    fn stored_tool_enabled_provider_ids_are_rejected_before_process_work() {
        let failure = SwallowtailCodexSessionRuntime
            .start_session(AgentSessionStartRequest {
                working_directory: "/not/used".to_owned(),
                provider_instance_id: CODEX_PROVIDER_INSTANCE_ID.to_owned(),
                provider_instance_revision: "1".to_owned(),
                protocol_facade_id: "codex-app-server-v2".to_owned(),
                provider_id: None,
                model: "gpt-5.4-mini".to_owned(),
                reasoning_effort: "low".to_owned(),
                harness_mode: AgentHarnessMode::Normal,
                developer_instructions: "instructions".to_owned(),
                dynamic_tools: Vec::new(),
                resume_provider_thread_id: Some("thread:stored".to_owned()),
                turn_timeout: Duration::from_secs(180),
            })
            .err()
            .expect("unsafe resume is rejected");

        assert!(failure.contains("transcript context"));
    }

    #[test]
    #[ignore = "requires a locally authenticated Codex installation"]
    fn current_local_codex_model_catalog_clears_full_preflight() {
        let instance = SwallowtailCodexSessionRuntime
            .configured_provider_instance()
            .expect("Codex configured provider instance");

        assert_eq!(instance.instance_id().as_str(), CODEX_PROVIDER_INSTANCE_ID);
        assert!(instance.model_catalogue().is_some());
    }

    #[test]
    #[ignore = "requires a locally authenticated Codex installation"]
    fn current_local_codex_chat_session_opens_with_its_preflight_policy() {
        let working_directory = std::env::current_dir().expect("working directory");
        let session = SwallowtailCodexSessionRuntime
            .start_session(AgentSessionStartRequest {
                working_directory: working_directory.display().to_string(),
                provider_instance_id: CODEX_PROVIDER_INSTANCE_ID.to_owned(),
                provider_instance_revision: "1".to_owned(),
                protocol_facade_id: "codex-app-server-v2".to_owned(),
                provider_id: None,
                model: "gpt-5.4-mini".to_owned(),
                reasoning_effort: "low".to_owned(),
                harness_mode: AgentHarnessMode::Normal,
                developer_instructions: "Nucleus integration smoke.".to_owned(),
                dynamic_tools: vec![json!({
                    "type": "function",
                    "name": "task_ledger",
                    "description": "Inspect tasks",
                    "inputSchema": { "type": "object" }
                })],
                resume_provider_thread_id: None,
                turn_timeout: Duration::from_secs(180),
            })
            .expect("Codex chat session");

        drop(session);
    }
}
