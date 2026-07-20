//! Local Codex-backed product chat with durable Nucleus timeline records.

mod goal_authoring;
mod goal_execution;
mod goal_inspection;
mod goal_run;
mod goal_update;
mod mandates;
mod persistence;
mod review_evidence;
mod rework_context;
mod runtime;
mod task_authoring;
mod task_execution;
mod task_inspection;
mod task_ledger;
mod task_update;
mod task_workflow;

use std::collections::HashMap;

use nucleus_local_store::LocalStoreBackend;
use serde::{Deserialize, Serialize};

pub use goal_execution::{
    execute_goal_run, GoalRunExecutionRecord, GoalRunExecutionRequest, GoalRunExecutionStatus,
    GoalTaskExecutionRecord,
};
pub use goal_run::{
    admit_goal_run, inspect_goal_run, read_goal_run_plan, GoalRunAdmissionRequest, GoalRunBlocker,
    GoalRunInspection, GoalRunOutcome, GoalRunPlan, GoalRunPlanTask, GoalRunRoute,
    GoalRunTaskInspection,
};
pub use mandates::{
    cancel_workflow_mandate, create_workflow_mandate, read_workflow_mandate,
    revoke_workflow_mandate, WorkflowMandate, WorkflowMandateAdmission, WorkflowMandateScope,
    WorkflowMandateStatus,
};
use persistence::{
    canonical_turn_id, persist_session, persist_turn_completion, persist_turn_failure,
    persist_turn_start, read_history, read_session,
};
pub use persistence::{ChatMessageRole, LocalCodexChatHistory, StoredChatMessage};
use runtime::{available_models, LocalCodexChatSession};
use task_ledger::execute as execute_task_ledger;

pub use task_authoring::{GoalCreationReceipt, TaskAuthoringReceipt, TaskCreationReceipt};
pub use task_workflow::{TaskWorkflowReceipt, TaskWorkflowReceiptStatus};

use crate::ServerStateService;

const CHAT_MODEL: &str = "gpt-5.4-mini";
const CHAT_REASONING_EFFORT: &str = "low";
const CHAT_ADAPTER_ID: &str = "codex-app-server";
const CHAT_PROVIDER_INSTANCE_ID: &str = "codex:local-default";
const CHAT_TASK_TOOLSET_VERSION: u32 = 5;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LocalCodexChatRequest {
    pub conversation_id: String,
    pub project_id: String,
    #[serde(default)]
    pub resource_id: Option<String>,
    pub message: String,
    #[serde(default)]
    pub active_task_id: Option<String>,
    #[serde(default)]
    pub active_goal_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LocalCodexChatModelOption {
    pub model: String,
    pub display_name: String,
    pub description: String,
    pub default_reasoning_effort: String,
    pub supported_reasoning_efforts: Vec<LocalCodexChatReasoningOption>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LocalCodexChatReasoningOption {
    pub reasoning_effort: String,
    pub description: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LocalCodexChatReply {
    pub session_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub assistant_message: String,
    pub task_receipts: Vec<TaskAuthoringReceipt>,
    pub workflow_receipts: Vec<TaskWorkflowReceipt>,
}

pub struct LocalCodexChatService {
    sessions: HashMap<String, LocalCodexChatSession>,
    task_review_snapshot_store: Option<crate::TaskReviewSnapshotStore>,
}

impl Default for LocalCodexChatService {
    fn default() -> Self {
        Self {
            sessions: HashMap::new(),
            task_review_snapshot_store: None,
        }
    }
}

impl LocalCodexChatService {
    pub fn available_models() -> Result<Vec<LocalCodexChatModelOption>, String> {
        available_models()
    }

    pub fn with_task_review_snapshot_store(store: crate::TaskReviewSnapshotStore) -> Self {
        Self {
            sessions: HashMap::new(),
            task_review_snapshot_store: Some(store),
        }
    }
    pub fn history<B>(
        &self,
        state: &ServerStateService<B>,
        project_id: &str,
        conversation_id: &str,
    ) -> Result<LocalCodexChatHistory, String>
    where
        B: LocalStoreBackend,
    {
        read_history(state, project_id, conversation_id)
    }

    pub fn send_message<B>(
        &mut self,
        state: &ServerStateService<B>,
        request: LocalCodexChatRequest,
    ) -> Result<LocalCodexChatReply, String>
    where
        B: LocalStoreBackend + Clone,
    {
        self.send_message_with_task_authoring(state, request, &mut |_| {
            Err("agent task authoring is unavailable on this chat boundary".to_owned())
        })
    }

    pub fn send_message_with_task_authoring<B, F>(
        &mut self,
        state: &ServerStateService<B>,
        request: LocalCodexChatRequest,
        execute: &mut F,
    ) -> Result<LocalCodexChatReply, String>
    where
        B: LocalStoreBackend + Clone,
        F: FnMut(crate::control_api::ServerControlRequest) -> Result<(), String>,
    {
        let message = request.message.trim();
        if message.is_empty() {
            return Err("chat message must not be empty".to_owned());
        }

        // Resource-free (transient chat) projects run against the host
        // user's home as an honest read-only working context, matching the
        // terminal's zero-resource fallback; file-backed actions still
        // require an attached resource.
        let project_target =
            crate::project_resource_target::resolve_optional_project_resource_target(
                state,
                &request.project_id,
                request.resource_id.as_deref(),
            )?;
        let (project_root, target_resource_id) = match &project_target {
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
                "resource:none".to_owned(),
            ),
        };
        let provider_message = focused_context_message(
            state,
            &request.project_id,
            request.active_goal_id.as_deref(),
            request.active_task_id.as_deref(),
            message,
        )?;
        let stored = read_session(state, &request.conversation_id)?;
        if stored
            .as_ref()
            .is_some_and(|stored| stored.project_id != request.project_id)
        {
            return Err("chat conversation belongs to another project".to_owned());
        }
        let (selected_model, selected_reasoning_effort) =
            selected_route(&request, stored.as_ref())?;
        let existing_session_matches =
            self.sessions
                .get(&request.conversation_id)
                .is_some_and(|session| {
                    session.targets_resource(&target_resource_id)
                        && session.targets_route(&selected_model, &selected_reasoning_effort)
                });
        if self.sessions.contains_key(&request.conversation_id) && !existing_session_matches {
            self.sessions.remove(&request.conversation_id);
        }
        let migration_context = if !existing_session_matches && stored.is_some() {
            Some(conversation_context(
                state,
                &request.project_id,
                &request.conversation_id,
            )?)
        } else {
            None
        };
        let session = match self.sessions.entry(request.conversation_id.clone()) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(LocalCodexChatSession::start(
                    &request.conversation_id,
                    &project_root,
                    &target_resource_id,
                    stored.as_ref(),
                    migration_context.as_deref(),
                    &selected_model,
                    &selected_reasoning_effort,
                )?)
            }
        };
        let project_id = request.project_id.clone();
        let resource_id = project_target
            .as_ref()
            .map(|target| target.resource_id.clone());
        let conversation_id = request.conversation_id.clone();
        let snapshot_store = self.task_review_snapshot_store.as_ref();
        let mut task_tool = |tool: &str, turn_id: &str, call_id: &str, arguments| match tool {
            "task_ledger" => execute_task_ledger(
                state,
                &project_id,
                &conversation_id,
                turn_id,
                call_id,
                arguments,
                execute,
            ),
            "task_workflow" => task_workflow::execute(
                state,
                snapshot_store,
                &project_id,
                &conversation_id,
                resource_id.as_deref(),
                arguments,
            ),
            _ => Err(format!("unsupported dynamic tool: {tool}")),
        };
        let turn_count = stored.map_or(1, |stored| stored.turn_count + 1);
        let canonical_turn_id = canonical_turn_id(&request.conversation_id, turn_count);
        persist_turn_start(
            state,
            session.stored_session(
                request.conversation_id.clone(),
                request.project_id.clone(),
                target_resource_id.clone(),
                turn_count,
            ),
            &canonical_turn_id,
            message,
            request.active_goal_id.clone(),
        )?;
        let reply = match session.send_turn(
            &provider_message,
            &selected_model,
            &selected_reasoning_effort,
            &mut task_tool,
        ) {
            Ok(reply) => reply,
            Err(error) => {
                persist_turn_failure(state, &canonical_turn_id, &error)?;
                return Err(error);
            }
        };
        persist_session(
            state,
            &session.stored_session(
                request.conversation_id.clone(),
                request.project_id.clone(),
                target_resource_id.clone(),
                turn_count,
            ),
        )?;
        persist_turn_completion(
            state,
            &canonical_turn_id,
            &reply.turn_id,
            &reply.assistant_message,
            &reply.task_receipts,
            &reply.workflow_receipts,
        )?;

        Ok(reply)
    }
}

fn selected_route(
    request: &LocalCodexChatRequest,
    stored: Option<&persistence::StoredChatSession>,
) -> Result<(String, String), String> {
    let model = normalize_route_value(request.model.as_deref(), "chat model")?
        .or_else(|| stored.map(|session| session.model.clone()))
        .unwrap_or_else(|| CHAT_MODEL.to_owned());
    let reasoning_effort =
        normalize_route_value(request.reasoning_effort.as_deref(), "chat reasoning effort")?
            .or_else(|| stored.and_then(|session| session.reasoning_effort.clone()))
            .unwrap_or_else(|| CHAT_REASONING_EFFORT.to_owned());

    Ok((model, reasoning_effort))
}

fn normalize_route_value(value: Option<&str>, label: &str) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() || value.len() > 128 {
        return Err(format!("{label} must contain between 1 and 128 characters"));
    }
    if !value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
    {
        return Err(format!("{label} contains unsupported characters"));
    }
    Ok(Some(value.to_owned()))
}

fn focused_context_message<B>(
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
        let task = task_inspection::active_task(state, project_id, task_id)?;
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

fn conversation_context<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    conversation_id: &str,
) -> Result<String, String>
where
    B: LocalStoreBackend,
{
    let history = read_history(state, project_id, conversation_id)?;
    let mut lines = history
        .messages
        .iter()
        .rev()
        .take(12)
        .map(|message| {
            let role = match message.role {
                ChatMessageRole::User => "User",
                ChatMessageRole::Assistant => "Assistant",
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

#[cfg(test)]
mod tests;
