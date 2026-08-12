//! Swallowtail Codex adapter: the tool-enabled chat session runtime and
//! read-only smoke over the local Codex app-server.
//!
//! Module index over the adapter surface: the session runtime, the live
//! session, turn driving, and the read-only smoke.

use futures_executor::block_on;
use nucleus_agent_protocol::{AgentSessionRuntime, AgentSessionStartRequest};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use swallowtail_adapter_codex::{
    codex_app_server_descriptor, CodexAppServerDriver, CodexSessionProfileInput,
};
use swallowtail_core::{HarnessMode, ObservableActivityAvailability, ReasoningMode};
use swallowtail_runtime::{
    ConfiguredProviderInstanceAdmission, ConfiguredProviderInstanceRecord,
    ConfiguredProviderModelCatalogueInput, InteractiveSessionDriver, OperationContent, RequestId,
    RuntimeFailure, RuntimeTurnId, ScopeId, SessionOptions,
};

mod debug_observer;
mod host;
mod idioms;
mod preparation;
mod session;
mod smoke;
mod task_execution;
#[cfg(test)]
mod tests;
mod tools;
mod turn;

pub use smoke::{
    run_codex_read_only_smoke, CodexReadOnlySmokeCleanup, CodexReadOnlySmokeOutcome,
    CodexReadOnlySmokeStatus,
};
pub use task_execution::{SwallowtailCodexTaskExecutionRuntime, CODEX_PROVIDER_INSTANCE_ID};

use session::SwallowtailCodexLiveSession;
use tools::tool_declarations;


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
    ) -> Result<Box<dyn nucleus_agent_protocol::AgentLiveSession + Send>, String> {
        if request.resume_provider_thread_id.is_some() {
            return Err(
                "stored tool-enabled Codex sessions must reopen with transcript context".to_owned(),
            );
        }
        let tools = tool_declarations(request.dynamic_tools)?;
        let reasoning =
            ReasoningMode::new(&request.reasoning_effort).map_err(|error| error.to_string())?;
        let project_root = Path::new(&request.working_directory);
        let host = host::local_host(project_root)?;
        let wiring = idioms::wiring(project_root, request.idioms_enabled);
        let services = match wiring.source() {
            Some(source) => host.services().with_idiom_source(source),
            None => host.services(),
        };
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
        if let Some(idiom_option) = wiring.option() {
            options = options.with_idioms(idiom_option);
        }
        if request.harness_mode == nucleus_agent_protocol::AgentHarnessMode::Plan {
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
            info: nucleus_agent_protocol::AgentStartedSessionInfo {
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
