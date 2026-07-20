//! Chat session wrapper over the live adapter boundary.
//!
//! Provider process, wire protocol, and turn-event handling live in
//! `nucleus-agent-adapters` behind `AgentSessionRuntime`; this module keeps
//! Nucleus-side concerns: tool instructions and specs, tool-call semantics
//! and receipts, stored-session mapping, and the chat reply shape.

use nucleus_agent_adapters::AgentAdapterRegistry;
use nucleus_agent_protocol::{
    AgentLiveSession, AgentSessionStartRequest, AgentToolCall, AgentTurnRequest,
};
use serde_json::Value;

mod tool_calls;

use super::persistence::StoredChatSession;
use super::task_authoring::{TaskAuthoringReceipt, TaskToolOutcome};
use super::task_ledger::dynamic_tool_spec as task_ledger_spec;
use super::task_workflow::{dynamic_tool_spec as task_workflow_spec, TaskWorkflowReceipt};
use super::{
    LocalCodexChatModelOption, LocalCodexChatReasoningOption, LocalCodexChatReply, CHAT_ADAPTER_ID,
    CHAT_PROVIDER_INSTANCE_ID, CHAT_TASK_TOOLSET_VERSION,
};
use tool_calls::consolidate_task_receipts;

const TASK_TOOL_INSTRUCTIONS: &str = "You are operating inside Nucleus. You have exactly two Nucleus portals. task_ledger inspects, creates, and updates durable Goals and tasks; use inspect before updates and fill every inferable field. task_workflow inspects or runs exactly one task or one Goal snapshot. Task inspection returns current review context; when it reports rework_ready, a newly authorized task run creates a fresh work item carrying that durable review note and its provenance. Call task_workflow run only when the current operator message explicitly authorizes execution; copy an exact authorizing excerpt, cite the current scope revision, and supply a stable idempotency key. Selection, readiness, and a review decision are not execution authority. Never invent task arrays, project sweeps, lifecycle transitions, delegation stages, or dispatch stages. Provider completion does not accept review, complete tasks, achieve Goals, or publish SCM changes. The portals are independent of the chat thread's read-only repository sandbox.";

pub(super) struct LocalCodexChatSession {
    session_id: String,
    resource_id: String,
    live: Box<dyn AgentLiveSession + Send>,
}

impl LocalCodexChatSession {
    pub(super) fn stored_session(
        &self,
        conversation_id: String,
        project_id: String,
        resource_id: String,
        turn_count: u64,
    ) -> StoredChatSession {
        let info = self.live.info();
        StoredChatSession {
            conversation_id,
            project_id,
            resource_id: Some(resource_id),
            session_id: self.session_id.clone(),
            provider_thread_id: info.provider_thread_id.clone(),
            model: info.model.clone(),
            reasoning_effort: info.reasoning_effort.clone(),
            adapter_id: CHAT_ADAPTER_ID.to_owned(),
            provider_instance_id: CHAT_PROVIDER_INSTANCE_ID.to_owned(),
            turn_count,
            task_toolset_version: CHAT_TASK_TOOLSET_VERSION,
        }
    }

    pub(super) fn start(
        conversation_id: &str,
        project_root: &str,
        resource_id: &str,
        stored: Option<&StoredChatSession>,
        migration_context: Option<&str>,
        model: &str,
        reasoning_effort: &str,
    ) -> Result<Self, String> {
        let developer_instructions = migration_context.map_or_else(
            || TASK_TOOL_INSTRUCTIONS.to_owned(),
            |context| {
                format!(
                    "{TASK_TOOL_INSTRUCTIONS}\n\nThis Nucleus conversation moved to a tool-enabled provider thread. Use this prior transcript as context:\n\n{context}"
                )
            },
        );
        let live = chat_runtime()?.start_session(AgentSessionStartRequest {
            working_directory: project_root.to_owned(),
            model: model.to_owned(),
            reasoning_effort: reasoning_effort.to_owned(),
            developer_instructions,
            dynamic_tools: dynamic_tool_specs(),
            // Current Codex schema evidence cannot safely redeclare dynamic
            // tools on thread/resume. Nucleus supplies transcript context and
            // opens fresh instead of resuming from a provider id alone.
            resume_provider_thread_id: None,
        })?;

        Ok(Self {
            session_id: stored
                .map(|stored| stored.session_id.clone())
                .unwrap_or_else(|| format!("session:chat:{conversation_id}")),
            resource_id: resource_id.to_owned(),
            live,
        })
    }

    pub(super) fn targets_resource(&self, resource_id: &str) -> bool {
        self.resource_id == resource_id
    }

    pub(super) fn targets_route(&self, model: &str, reasoning_effort: &str) -> bool {
        let info = self.live.info();
        info.model == model && info.reasoning_effort.as_deref() == Some(reasoning_effort)
    }

    pub(super) fn send_turn<F>(
        &mut self,
        message: &str,
        model: &str,
        reasoning_effort: &str,
        task_tool: &mut F,
    ) -> Result<LocalCodexChatReply, String>
    where
        F: FnMut(&str, &str, &str, Value) -> Result<TaskToolOutcome, String>,
    {
        let mut task_receipts: Vec<TaskAuthoringReceipt> = Vec::new();
        let mut workflow_receipts: Vec<TaskWorkflowReceipt> = Vec::new();
        let mut on_tool_call = |call: AgentToolCall| -> Result<String, String> {
            let outcome = task_tool(&call.tool, &call.turn_id, &call.call_id, call.arguments)?;
            if let Some(receipt) = outcome.receipt {
                task_receipts.push(receipt);
            }
            if let Some(receipt) = outcome.workflow_receipt {
                workflow_receipts.push(receipt);
            }
            Ok(outcome.text)
        };
        let reply = self.live.send_turn(
            AgentTurnRequest {
                message: message.to_owned(),
                model: model.to_owned(),
                reasoning_effort: reasoning_effort.to_owned(),
            },
            &mut on_tool_call,
        )?;

        let info = self.live.info();
        Ok(LocalCodexChatReply {
            session_id: self.session_id.clone(),
            thread_id: info.provider_thread_id.clone(),
            turn_id: reply.turn_id,
            model: info.model.clone(),
            reasoning_effort: info.reasoning_effort.clone(),
            assistant_message: reply.assistant_message,
            task_receipts: consolidate_task_receipts(task_receipts),
            workflow_receipts,
        })
    }
}

fn chat_runtime(
) -> Result<std::sync::Arc<dyn nucleus_agent_protocol::AgentSessionRuntime + Send + Sync>, String> {
    AgentAdapterRegistry::with_builtin_adapters().runtime(CHAT_ADAPTER_ID)
}

pub(super) fn available_models() -> Result<Vec<LocalCodexChatModelOption>, String> {
    Ok(chat_runtime()?
        .model_catalog()?
        .into_iter()
        .map(|option| LocalCodexChatModelOption {
            model: option.model,
            display_name: option.display_name,
            description: option.description,
            default_reasoning_effort: option.default_reasoning_effort,
            supported_reasoning_efforts: option
                .supported_reasoning_efforts
                .into_iter()
                .map(|effort| LocalCodexChatReasoningOption {
                    reasoning_effort: effort.reasoning_effort,
                    description: effort.description,
                })
                .collect(),
        })
        .collect())
}

fn dynamic_tool_specs() -> Vec<Value> {
    vec![task_ledger_spec(), task_workflow_spec()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_projects_exactly_the_two_nucleus_portals() {
        let specs = dynamic_tool_specs();
        let names: Vec<&str> = specs
            .iter()
            .filter_map(|spec| spec.get("name").and_then(Value::as_str))
            .collect();

        assert_eq!(names, vec!["task_ledger", "task_workflow"]);
    }

    #[test]
    fn chat_adapter_resolves_through_the_live_registry() {
        assert!(chat_runtime().is_ok());
    }
}
