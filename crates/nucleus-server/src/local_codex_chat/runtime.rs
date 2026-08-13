//! Chat session wrapper over the live adapter boundary.
//!
//! Provider process, wire protocol, and turn-event handling live in
//! `nucleus-agent-adapters` behind `AgentSessionRuntime`; this module keeps
//! Nucleus-side concerns: tool instructions and specs, tool-call semantics
//! and receipts, stored-session mapping, and the chat reply shape.

use nucleus_agent_adapters::AgentAdapterRegistry;
use nucleus_agent_protocol::{
    AgentActivityHandler, AgentLiveSession, AgentSessionStartRequest, AgentToolCall,
    AgentTurnCancellation, AgentTurnFailure, AgentTurnRequest, AgentUserInputHandler,
};
use serde_json::Value;
use std::time::Duration;

mod tool_calls;

use super::persistence::StoredChatSession;
use super::task_authoring::{TaskAuthoringReceipt, TaskToolOutcome};
use super::task_ledger::dynamic_tool_spec as task_ledger_spec;
use super::task_workflow::{dynamic_tool_spec as task_workflow_spec, TaskWorkflowReceipt};
use super::delegation;
use super::routing::{CHAT_TASK_TOOLSET_VERSION, SelectedAgentChatRoute};
use super::{LocalCodexChatHarnessMode, LocalCodexChatReply};
use tool_calls::consolidate_task_receipts;

const TASK_TOOL_INSTRUCTIONS: &str = "You are operating inside Nucleus. You have exactly two Nucleus portals. task_ledger inspects, creates, and updates durable Goals and tasks; use inspect before updates and fill every inferable field. task_workflow inspects or runs exactly one task or one Goal snapshot. Task inspection returns current review context; when it reports rework_ready, a newly authorized task run creates a fresh work item carrying that durable review note and its provenance. Call task_workflow run only when the current operator message explicitly authorizes execution; copy an exact authorizing excerpt, cite the current scope revision, and supply a stable idempotency key. Selection, readiness, and a review decision are not execution authority. Never invent task arrays, project sweeps, lifecycle transitions, delegation stages, or dispatch stages. Provider completion does not accept review, complete tasks, achieve Goals, or publish SCM changes. The portals are independent of the chat thread's read-only repository sandbox.";

// Codex replaces its built-in plan-mode instructions when a client supplies
// developer instructions, so Nucleus must re-declare the proposed-plan
// presentation convention itself or the provider never emits plan items.
const PLAN_PRESENTATION_INSTRUCTIONS: &str = "Plan mode is active. When you present a complete plan for operator review, wrap the final plan in exactly one <proposed_plan>...</proposed_plan> block so the host can render review controls. Keep working notes and partial drafts outside the block; tag only the plan you ask the operator to accept.";

fn chat_developer_instructions(
    migration_context: Option<&str>,
    harness_mode: LocalCodexChatHarnessMode,
) -> String {
    let instructions = migration_context.map_or_else(
        || TASK_TOOL_INSTRUCTIONS.to_owned(),
        |context| {
            format!(
                "{TASK_TOOL_INSTRUCTIONS}\n\nThis Nucleus conversation moved to a tool-enabled provider thread. Use this prior transcript as context:\n\n{context}"
            )
        },
    );
    match harness_mode {
        LocalCodexChatHarnessMode::Plan => {
            format!("{instructions}\n\n{PLAN_PRESENTATION_INSTRUCTIONS}")
        }
        LocalCodexChatHarnessMode::Normal => instructions,
    }
}

pub(super) struct LocalCodexChatSession {
    session_id: String,
    resource_id: String,
    /// Whether this session was started with the orchestrator delegation
    /// tool set (the session's project had an active designation for its
    /// provider instance at start). Part of session identity: when the
    /// designation appears, changes, or is revoked, the session must be
    /// restarted (with migration context) so the declared tool set matches
    /// the designation state.
    delegation_tools: bool,
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
            harness_mode: match info.harness_mode {
                nucleus_agent_protocol::AgentHarnessMode::Normal => {
                    LocalCodexChatHarnessMode::Normal
                }
                nucleus_agent_protocol::AgentHarnessMode::Plan => LocalCodexChatHarnessMode::Plan,
            },
            adapter_id: info.adapter_id.clone(),
            provider_instance_id: info.provider_instance_id.clone(),
            provider_instance_revision: info.provider_instance_revision.clone(),
            protocol_facade_id: info.protocol_facade_id.clone(),
            provider_id: info.provider_id.clone(),
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
        route: &SelectedAgentChatRoute,
        turn_timeout: Duration,
        idioms_enabled: bool,
        delegation_tools: bool,
    ) -> Result<Self, String> {
        let developer_instructions =
            chat_developer_instructions(migration_context, route.harness_mode);
        let live =
            chat_runtime(&route.runtime_adapter_id)?.start_session(AgentSessionStartRequest {
                working_directory: project_root.to_owned(),
                provider_instance_id: route.provider_instance_id.clone(),
                provider_instance_revision: route.provider_instance_revision.clone(),
                protocol_facade_id: route.protocol_facade_id.clone(),
                provider_id: route.provider_id.clone(),
                model: route.model.clone(),
                reasoning_effort: route.reasoning_effort.clone(),
                harness_mode: route.harness_mode.agent_mode(),
                developer_instructions,
                dynamic_tools: dynamic_tool_specs(delegation_tools),
                // Current Codex schema evidence cannot safely redeclare dynamic
                // tools on thread/resume. Nucleus supplies transcript context and
                // opens fresh instead of resuming from a provider id alone.
                resume_provider_thread_id: None,
                idioms_enabled,
                turn_timeout,
            })?;

        Ok(Self {
            session_id: stored
                .map(|stored| stored.session_id.clone())
                .unwrap_or_else(|| format!("session:chat:{conversation_id}")),
            resource_id: resource_id.to_owned(),
            delegation_tools,
            live,
        })
    }

    pub(super) fn targets_resource(&self, resource_id: &str) -> bool {
        self.resource_id == resource_id
    }

    pub(super) fn targets_route(&self, route: &SelectedAgentChatRoute) -> bool {
        let info = self.live.info();
        info.adapter_id == route.runtime_adapter_id
            && info.provider_instance_id == route.provider_instance_id
            && info.provider_instance_revision == route.provider_instance_revision
            && info.protocol_facade_id == route.protocol_facade_id
            && info.provider_id == route.provider_id
            && info.model == route.model
            && info.reasoning_effort.as_deref() == Some(route.reasoning_effort.as_str())
            && info.harness_mode == route.harness_mode.agent_mode()
    }

    /// Whether the session was started with the orchestrator delegation tool
    /// set. Sessions must be restarted when this changes (designation
    /// created/revoked) so the declared tool set tracks the designation.
    pub(super) fn has_delegation_tools(&self) -> bool {
        self.delegation_tools
    }

    pub(super) fn send_turn<F>(
        &mut self,
        message: &str,
        model: &str,
        reasoning_effort: &str,
        cancellation: AgentTurnCancellation,
        on_activity: &mut AgentActivityHandler<'_>,
        on_user_input: &mut AgentUserInputHandler<'_>,
        task_tool: &mut F,
    ) -> Result<LocalCodexChatReply, AgentTurnFailure>
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
                cancellation,
            },
            on_activity,
            &mut on_tool_call,
            on_user_input,
        )?;

        let info = self.live.info();
        Ok(LocalCodexChatReply {
            session_id: self.session_id.clone(),
            thread_id: info.provider_thread_id.clone(),
            turn_id: reply.turn_id,
            timeline_turn_id: String::new(),
            provider_instance_id: info.provider_instance_id.clone(),
            provider_instance_revision: info.provider_instance_revision.clone(),
            protocol_facade_id: info.protocol_facade_id.clone(),
            provider_id: info.provider_id.clone(),
            model: info.model.clone(),
            reasoning_effort: info.reasoning_effort.clone(),
            harness_mode: match info.harness_mode {
                nucleus_agent_protocol::AgentHarnessMode::Normal => {
                    LocalCodexChatHarnessMode::Normal
                }
                nucleus_agent_protocol::AgentHarnessMode::Plan => LocalCodexChatHarnessMode::Plan,
            },
            assistant_message: reply.assistant_message,
            task_receipts: consolidate_task_receipts(task_receipts),
            workflow_receipts,
        })
    }
}

fn chat_runtime(
    adapter_id: &str,
) -> Result<std::sync::Arc<dyn nucleus_agent_protocol::AgentSessionRuntime + Send + Sync>, String> {
    AgentAdapterRegistry::with_builtin_adapters().runtime(adapter_id)
}

/// Dynamic tool declarations for one session start. The task portals are
/// always declared; the orchestrator delegation verbs are declared only when
/// the session's project has an active designation binding its provider
/// instance (contract 033: a non-designated session never receives the
/// delegation tools).
fn dynamic_tool_specs(delegation_tools: bool) -> Vec<Value> {
    let mut specs = vec![task_ledger_spec(), task_workflow_spec()];
    if delegation_tools {
        specs.extend(delegation::dynamic_tool_specs());
    }
    specs
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_agent_protocol::{
        AgentHarnessMode, AgentStartedSessionInfo, AgentToolCallHandler, AgentTurnReply,
    };

    struct FixtureLiveSession {
        info: AgentStartedSessionInfo,
    }

    impl AgentLiveSession for FixtureLiveSession {
        fn info(&self) -> &AgentStartedSessionInfo {
            &self.info
        }

        fn send_turn(
            &mut self,
            _request: AgentTurnRequest,
            _on_activity: &mut AgentActivityHandler<'_>,
            _on_tool_call: &mut AgentToolCallHandler<'_>,
            _on_user_input: &mut AgentUserInputHandler<'_>,
        ) -> Result<AgentTurnReply, AgentTurnFailure> {
            unreachable!("route matching does not send a provider turn")
        }
    }

    #[test]
    fn chat_projects_exactly_the_two_nucleus_portals_without_delegation() {
        let specs = dynamic_tool_specs(false);
        let names: Vec<&str> = specs
            .iter()
            .filter_map(|spec| spec.get("name").and_then(Value::as_str))
            .collect();

        assert_eq!(names, vec!["task_ledger", "task_workflow"]);
    }

    #[test]
    fn chat_projects_the_delegation_verbs_only_for_designated_sessions() {
        let plain = dynamic_tool_specs(false);
        let delegated = dynamic_tool_specs(true);
        assert!(delegated.len() > plain.len());

        let names: Vec<&str> = delegated
            .iter()
            .filter_map(|spec| spec.get("name").and_then(Value::as_str))
            .collect();
        for verb in [
            "delegate",
            "run_status",
            "cancel_run",
            "accept_delivery",
            "reject_delivery",
        ] {
            assert!(names.contains(&verb), "missing delegation verb {verb}");
        }
    }

    #[test]
    fn plan_mode_instructions_carry_the_proposed_plan_convention() {
        let plan = chat_developer_instructions(None, LocalCodexChatHarnessMode::Plan);
        assert!(plan.contains(TASK_TOOL_INSTRUCTIONS));
        assert!(plan.contains("<proposed_plan>"));

        let normal = chat_developer_instructions(None, LocalCodexChatHarnessMode::Normal);
        assert_eq!(normal, TASK_TOOL_INSTRUCTIONS);

        let migrated =
            chat_developer_instructions(Some("prior transcript"), LocalCodexChatHarnessMode::Plan);
        assert!(migrated.contains("prior transcript"));
        assert!(migrated.contains("<proposed_plan>"));
    }

    #[test]
    fn chat_adapter_resolves_through_the_live_registry() {
        assert!(chat_runtime("codex-app-server").is_ok());
    }

    #[test]
    fn live_session_reuse_requires_the_exact_immutable_route() {
        let route = SelectedAgentChatRoute {
            runtime_adapter_id: "codex-app-server".to_owned(),
            provider_instance_id: "codex:local-default".to_owned(),
            provider_instance_revision: "1".to_owned(),
            protocol_facade_id: "codex-app-server-v2".to_owned(),
            provider_id: None,
            model: "gpt-5.4-mini".to_owned(),
            reasoning_effort: "low".to_owned(),
            harness_mode: LocalCodexChatHarnessMode::Normal,
        };
        let session = LocalCodexChatSession {
            session_id: "session:test".to_owned(),
            resource_id: "resource:test".to_owned(),
            delegation_tools: false,
            live: Box::new(FixtureLiveSession {
                info: AgentStartedSessionInfo {
                    provider_thread_id: "thread:test".to_owned(),
                    adapter_id: route.runtime_adapter_id.clone(),
                    provider_instance_id: route.provider_instance_id.clone(),
                    provider_instance_revision: route.provider_instance_revision.clone(),
                    protocol_facade_id: route.protocol_facade_id.clone(),
                    provider_id: route.provider_id.clone(),
                    model: route.model.clone(),
                    reasoning_effort: Some(route.reasoning_effort.clone()),
                    harness_mode: AgentHarnessMode::Normal,
                },
            }),
        };

        assert!(session.targets_route(&route));
        for changed in [
            SelectedAgentChatRoute {
                provider_instance_revision: "2".to_owned(),
                ..route.clone()
            },
            SelectedAgentChatRoute {
                protocol_facade_id: "other-facade".to_owned(),
                ..route.clone()
            },
            SelectedAgentChatRoute {
                model: "other-model".to_owned(),
                ..route.clone()
            },
            SelectedAgentChatRoute {
                reasoning_effort: "high".to_owned(),
                ..route.clone()
            },
            SelectedAgentChatRoute {
                harness_mode: LocalCodexChatHarnessMode::Plan,
                ..route.clone()
            },
        ] {
            assert!(!session.targets_route(&changed));
        }
    }
}
