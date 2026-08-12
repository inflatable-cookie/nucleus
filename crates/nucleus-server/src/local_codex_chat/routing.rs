//! Chat request resolution: provider route selection, working-context
//! resolution, context folding, and the shared chat defaults.
//!
//! Split from the local_codex_chat god file; behavior unchanged.

use nucleus_core::{PersistenceRecordId, PersistenceRecordKind};
use nucleus_local_store::LocalStoreBackend;

use super::persistence::StoredChatSession;
use super::task_inspection::active_task;
use super::types::{LocalCodexChatHarnessMode, LocalCodexChatRequest};
use super::AgentChatProviderCatalogue;
use super::goal_inspection;
use crate::project_resource_target::resolve_optional_project_resource_target;
use crate::ServerStateService;

pub(crate) const CHAT_MODEL: &str = "gpt-5.4-mini";
#[cfg(test)]
pub(crate) const CHAT_REASONING_EFFORT: &str = "low";
#[cfg(test)]
pub(crate) const CHAT_ADAPTER_ID: &str = "codex-app-server";
pub(crate) const CHAT_PROVIDER_INSTANCE_ID: &str = "codex:local-default";
pub(crate) const CHAT_TASK_TOOLSET_VERSION: u32 = 5;
pub(crate) const CHAT_TURN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

/// Sentinel target resource id for resource-free chats. Stored sessions
/// persist it as their resource id, so it must never be resolved as a real
/// project resource.
const RESOURCE_FREE_TARGET_ID: &str = "resource:none";

pub(crate) fn resolve_chat_working_context<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    resource_id: Option<&str>,
) -> Result<(Option<crate::project_resource_target::ResolvedProjectResourceTarget>, String, String), String>
where
    B: LocalStoreBackend,
{
    // Stored sessions of resource-free chats carry the sentinel as their
    // resource id; it names no real resource and must resolve as absent.
    let resource_id = resource_id.filter(|id| *id != RESOURCE_FREE_TARGET_ID);
    let target = resolve_optional_project_resource_target(state, project_id, resource_id)?;
    let (root, target_resource_id) = match &target {
        Some(target) => (
            target.root.to_string_lossy().into_owned(),
            target.resource_id.clone(),
        ),
        None => (
            std::env::var_os("HOME")
                .map(|home| home.to_string_lossy().into_owned())
                .ok_or_else(|| {
                    "resource-free chat requires a resolvable host home directory".to_owned()
                })?,
            RESOURCE_FREE_TARGET_ID.to_owned(),
        ),
    };
    Ok((target, root, target_resource_id))
}

pub(crate) fn ensure_chat_project_present<B>(
    state: &ServerStateService<B>,
    project_id: &str,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    state
        .projects()
        .get(&PersistenceRecordId(project_id.to_owned()))
        .map_err(|error| format!("chat project lookup failed: {error:?}"))?
        .filter(|record| record.kind == PersistenceRecordKind::Project)
        .map(|_| ())
        .ok_or_else(|| format!("chat project expired before provider turn start: {project_id}"))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SelectedAgentChatRoute {
    pub runtime_adapter_id: String,
    pub provider_instance_id: String,
    pub provider_instance_revision: String,
    pub protocol_facade_id: String,
    pub provider_id: Option<String>,
    pub model: String,
    pub reasoning_effort: String,
    pub harness_mode: LocalCodexChatHarnessMode,
}

pub(crate) fn selected_route(
    request: &LocalCodexChatRequest,
    stored: Option<&StoredChatSession>,
    catalogue: &AgentChatProviderCatalogue,
) -> Result<SelectedAgentChatRoute, String> {
    let requested_instance =
        normalize_route_value(request.provider_instance_id.as_deref(), "provider instance")?
            .or_else(|| {
                stored
                    .filter(|session| !session.provider_instance_id.is_empty())
                    .map(|session| session.provider_instance_id.clone())
            });
    let instance = match requested_instance {
        Some(instance_id) => catalogue
            .instance(&instance_id)
            .ok_or_else(|| format!("configured provider instance is unavailable: {instance_id}"))?,
        None => catalogue.sole_ready_instance().ok_or_else(|| {
            "provider selection is required because no single ready instance exists".to_owned()
        })?,
    };
    if instance.selection_readiness != "ready" {
        return Err(format!(
            "configured provider instance is not ready: {}",
            instance.provider_instance_id
        ));
    }
    let protocol_facade_id =
        normalize_route_value(request.protocol_facade_id.as_deref(), "protocol facade")?
            .or_else(|| {
                stored
                    .filter(|session| !session.protocol_facade_id.is_empty())
                    .map(|session| session.protocol_facade_id.clone())
            })
            .unwrap_or_else(|| instance.protocol_facade_id.clone());
    if protocol_facade_id != instance.protocol_facade_id {
        return Err("selected protocol facade does not belong to provider instance".to_owned());
    }
    let provider_instance_revision = normalize_route_value(
        request.provider_instance_revision.as_deref(),
        "provider instance revision",
    )?
    .or_else(|| {
        stored
            .filter(|session| !session.provider_instance_revision.is_empty())
            .map(|session| session.provider_instance_revision.clone())
    })
    .unwrap_or_else(|| instance.instance_revision.clone());
    if provider_instance_revision != instance.instance_revision {
        return Err("selected provider instance revision is stale".to_owned());
    }
    let model = normalize_route_value(request.model.as_deref(), "chat model")?
        .or_else(|| stored.map(|session| session.model.clone()))
        .unwrap_or_else(|| CHAT_MODEL.to_owned());
    let requested_provider_id = normalize_route_value(request.provider_id.as_deref(), "provider")?
        .or_else(|| stored.and_then(|session| session.provider_id.clone()));
    let matching_models = instance
        .models
        .iter()
        .filter(|entry| entry.model == model)
        .collect::<Vec<_>>();
    let selected_model = if let Some(provider_id) = requested_provider_id.as_deref() {
        matching_models
            .iter()
            .copied()
            .find(|entry| entry.provider_id.as_deref() == Some(provider_id))
    } else if matching_models.len() == 1 {
        matching_models.first().copied()
    } else {
        matching_models
            .iter()
            .copied()
            .find(|entry| entry.provider_id.is_none())
    }
    .ok_or_else(|| "selected model does not belong to provider instance".to_owned())?;
    let reasoning_effort =
        normalize_route_value(request.reasoning_effort.as_deref(), "chat reasoning effort")?
            .or_else(|| stored.and_then(|session| session.reasoning_effort.clone()))
            .unwrap_or_else(|| selected_model.default_reasoning_effort.clone());
    if !selected_model.supported_reasoning_efforts.is_empty()
        && !selected_model
            .supported_reasoning_efforts
            .iter()
            .any(|option| option.reasoning_effort == reasoning_effort)
    {
        return Err("selected reasoning effort is unsupported by the model".to_owned());
    }

    Ok(SelectedAgentChatRoute {
        runtime_adapter_id: instance.runtime_adapter_id.clone(),
        provider_instance_id: instance.provider_instance_id.clone(),
        provider_instance_revision,
        protocol_facade_id,
        provider_id: selected_model.provider_id.clone(),
        model,
        reasoning_effort,
        harness_mode: request.harness_mode,
    })
}

fn normalize_route_value(value: Option<&str>, label: &str) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() || value.len() > 128 {
        return Err(format!("{label} must contain between 1 and 128 characters"));
    }
    if !value.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':' | '/' | '@')
    }) {
        return Err(format!("{label} contains unsupported characters"));
    }
    Ok(Some(value.to_owned()))
}

pub(crate) fn focused_context_message<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    goal_id: Option<&str>,
    task_id: Option<&str>,
    message: &str,
) -> Result<String, String>
where
    B: LocalStoreBackend,
{
    let mut contexts = Vec::new();
    if let Some(goal_id) = goal_id {
        let goal = goal_inspection::goal_record(state, project_id, goal_id)?;
        contexts.push(
            serde_json::to_string(&serde_json::json!({
                "kind": "goal",
                "goal_id": goal.goal_id,
                "revision_id": goal.revision_id,
                "title": goal.title,
                "desired_outcome": goal.desired_outcome,
                "scope": goal.scope,
                "status": goal.status,
                "ordered_task_refs": goal.ordered_task_refs,
                "stop_conditions": goal.stop_conditions,
                "current_next_task_ref": goal.current_next_task_ref,
                "next_action": goal.next_action,
            }))
            .map_err(|error| format!("failed to encode active goal context: {error}"))?,
        );
    }
    if let Some(task_id) = task_id {
        let task = active_task(state, project_id, task_id)?;
        contexts.push(
            serde_json::to_string(&task)
                .map_err(|error| format!("failed to encode active task context: {error}"))?,
        );
    }
    if contexts.is_empty() {
        return Ok(message.to_owned());
    }
    Ok(format!(
        "Nucleus selected context for this turn follows. Treat selection as current focus only. It is not a mandate or authority to execute, mutate lifecycle, assign, or dispatch work. Use task_ledger inspect before any requested update.\n\n{}\n\nOperator message:\n{message}",
        contexts.join("\n")
    ))
}

pub(crate) fn conversation_context<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    conversation_id: &str,
) -> Result<String, String>
where
    B: LocalStoreBackend,
{
    let history = super::persistence::read_history(state, project_id, conversation_id)?;
    let mut lines = history
        .messages
        .iter()
        .rev()
        .take(12)
        .map(|message| {
            let role = match message.role {
                super::persistence::ChatMessageRole::User => "User",
                super::persistence::ChatMessageRole::Assistant => "Assistant",
            };
            format!("{role}: {}", message.text)
        })
        .collect::<Vec<_>>();
    lines.reverse();
    let mut context = lines.join("\n\n");
    if context.len() > 8_000 {
        context = context
            .chars()
            .rev()
            .take(8_000)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
    }
    Ok(context)
}
