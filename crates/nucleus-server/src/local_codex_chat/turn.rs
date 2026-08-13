//! Full-turn orchestration: send and plan-decision flows with task authoring,
//! cancellation, activity forwarding, and question persistence.
//!
//! Split from the local_codex_chat god file; behavior unchanged.

use std::collections::HashMap;

use nucleus_agent_protocol::{
    AgentActivityEvent, AgentTurnCancellation, AgentTurnFailure, AgentUserInputRequest,
};
use nucleus_local_store::LocalStoreBackend;

use super::persistence::{
    canonical_turn_id, persist_activity, persist_plan_pending, persist_question_pending,
    persist_session, persist_turn_completion, persist_turn_failure, persist_turn_start,
    project_activity, project_question, read_session, settle_pending_plan_for_conversation,
    settle_pending_questions_for_turn, now_unix_ms, ChatTurnFailureStatus, StoredChatActivity,
    StoredChatPlanDecision, StoredChatQuestionExchange,
};
use super::routing::{
    conversation_context, ensure_chat_project_present, focused_context_message,
    resolve_chat_working_context, selected_route,
};
use super::subagent_directory::{
    persist_subagent_directory, ChatSubagentDirectories, StoredChatSubagentDirectory,
};
use super::task_ledger::execute as execute_task_ledger;
use super::types::{
    LocalCodexChatHarnessMode, LocalCodexChatPlanDecisionKind, LocalCodexChatPlanDecisionReply,
    LocalCodexChatPlanDecisionRequest, LocalCodexChatReply, LocalCodexChatRequest,
};
use super::LocalCodexChatQuestionRegistry;
use super::task_workflow;
use super::runtime::LocalCodexChatSession;
use crate::control_api::ServerControlRequest;
use crate::ServerStateService;

/// Accumulates plan-activity content during one turn so a completed Plan-mode
/// turn can persist the exact proposed plan snapshot. Mirrors the desktop
/// delta/replacement accumulation over one activity identity.
#[derive(Default)]
pub(super) struct PlanDraftAccumulator {
    held: HashMap<(String, String), (u64, String)>,
}

impl PlanDraftAccumulator {
    pub(super) fn observe(&mut self, activity: &StoredChatActivity) {
        if activity.kind != "plan" {
            return;
        }
        let key = (
            activity.runtime_operation_id.clone(),
            activity.activity_id.clone(),
        );
        let entry = self
            .held
            .entry(key)
            .or_insert_with(|| (activity.sequence, String::new()));
        entry.0 = activity.sequence;
        match (
            activity.content_change.as_deref(),
            activity.content.as_deref(),
        ) {
            (Some("replacement_snapshot"), Some(content)) => entry.1 = content.to_owned(),
            (Some("delta"), Some(content)) => entry.1.push_str(content),
            _ => {}
        }
    }

    pub(super) fn finish(self) -> Option<(String, String, String)> {
        self.held
            .into_iter()
            .filter(|(_, (_, text))| !text.trim().is_empty())
            .max_by_key(|(_, (sequence, _))| *sequence)
            .map(|((operation, activity), (_, text))| (operation, activity, text))
    }
}

impl super::LocalCodexChatService {
    pub fn send_message_with_task_authoring_and_cancellation<B, F, A, Q>(
        &mut self,
        state: &ServerStateService<B>,
        request: LocalCodexChatRequest,
        cancellation: AgentTurnCancellation,
        questions: &LocalCodexChatQuestionRegistry,
        execute: &mut F,
        on_activity: &mut A,
        on_question: &mut Q,
    ) -> Result<LocalCodexChatReply, String>
    where
        B: LocalStoreBackend + Clone,
        F: FnMut(ServerControlRequest) -> Result<(), String>,
        A: FnMut(StoredChatActivity, Option<StoredChatSubagentDirectory>) -> Result<(), String>,
        Q: FnMut(StoredChatQuestionExchange) -> Result<(), String>,
    {
        let message = request.message.trim();
        if message.is_empty() {
            return Err("chat message must not be empty".to_owned());
        }

        // Resource-free (transient chat) projects run against the host
        // user's home as an honest read-only working context, matching the
        // terminal's zero-resource fallback; file-backed actions still
        // require an attached resource.
        let (project_target, project_root, target_resource_id) = resolve_chat_working_context(
            state,
            &request.project_id,
            request.resource_id.as_deref(),
        )?;
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
        let catalogue = super::AgentChatProviderCatalogue::discover()?;
        let selected_route = selected_route(&request, stored.as_ref(), &catalogue)?;
        let existing_session_matches =
            self.sessions
                .get(&request.conversation_id)
                .is_some_and(|session| {
                    session.targets_resource(&target_resource_id)
                        && session.targets_route(&selected_route)
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
        let turn_timeout = self.turn_timeout;
        let session = match self.sessions.entry(request.conversation_id.clone()) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(LocalCodexChatSession::start(
                    &request.conversation_id,
                    &project_root,
                    &target_resource_id,
                    stored.as_ref(),
                    migration_context.as_deref(),
                    &selected_route,
                    turn_timeout,
                    request.idioms_enabled,
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
        if let Err(error) = ensure_chat_project_present(state, &request.project_id) {
            persist_turn_failure(
                state,
                &canonical_turn_id,
                ChatTurnFailureStatus::Failed,
                &error,
            )?;
            return Err(error);
        }
        // An ordinary message sent while a plan awaits its decision is the
        // revise channel: the pending plan settles exactly once as revised.
        settle_pending_plan_for_conversation(
            state,
            &request.conversation_id,
            "revised",
            now_unix_ms(),
        )?;
        let mut plan_draft = PlanDraftAccumulator::default();
        let mut subagent_directories = ChatSubagentDirectories::default();
        // A dispatched run's worker operation starts when its conversation
        // emits its first activity: transition dispatched -> running from
        // that observed truth (never timers), binding the provider-minted
        // operation identity.
        let mut run_marked_running = false;
        let mut project_and_forward_activity = |event: AgentActivityEvent| -> Result<(), String> {
            let directory = subagent_directories.observe(
                &request.project_id,
                &request.conversation_id,
                &canonical_turn_id,
                turn_count,
                &event,
            )?;
            let activity = project_activity(
                &request.conversation_id,
                &canonical_turn_id,
                turn_count,
                event,
            );
            if !run_marked_running {
                run_marked_running = super::run_transitions::mark_run_running_on_first_activity(
                    state,
                    &request.conversation_id,
                    &canonical_turn_id,
                    &activity.runtime_operation_id,
                )?;
            }
            plan_draft.observe(&activity);
            persist_activity(state, &activity)?;
            if let Some(directory) = &directory {
                persist_subagent_directory(state, directory)?;
            }
            on_activity(activity, directory)
        };
        let mut persist_and_forward_question =
            |question: AgentUserInputRequest| {
                let exchange =
                    project_question(&request.conversation_id, &canonical_turn_id, &question)?;
                let wait = questions.register(
                    &request.project_id,
                    &request.conversation_id,
                    &canonical_turn_id,
                    question,
                )?;
                if let Err(error) = persist_question_pending(state, &exchange) {
                    drop(wait);
                    return Err(error);
                }
                on_question(exchange)?;
                Ok(wait)
            };
        let mut reply = match session.send_turn(
            &provider_message,
            &selected_route.model,
            &selected_route.reasoning_effort,
            cancellation,
            &mut project_and_forward_activity,
            &mut persist_and_forward_question,
            &mut task_tool,
        ) {
            Ok(reply) => reply,
            Err(error) => {
                let status = match &error {
                    AgentTurnFailure::Cancelled => ChatTurnFailureStatus::Cancelled,
                    AgentTurnFailure::TimedOut => ChatTurnFailureStatus::TimedOut,
                    AgentTurnFailure::CleanupFailed(_) => ChatTurnFailureStatus::Failed,
                    AgentTurnFailure::Failed(_) => ChatTurnFailureStatus::Failed,
                };
                let reason = error.to_string();
                // A failed worker turn fails the run (observed terminal
                // truth); best effort so the turn error is not masked.
                let _ = super::run_transitions::fail_run_on_turn_failure(
                    state,
                    &request.conversation_id,
                    &canonical_turn_id,
                    &reason,
                );
                let question_status = match status {
                    ChatTurnFailureStatus::Cancelled => "cancelled",
                    ChatTurnFailureStatus::TimedOut => "timed_out",
                    ChatTurnFailureStatus::Failed => "failed",
                };
                settle_pending_questions_for_turn(state, &canonical_turn_id, question_status)?;
                questions.abandon_turn(
                    &request.project_id,
                    &request.conversation_id,
                    &canonical_turn_id,
                    &reason,
                );
                persist_turn_failure(state, &canonical_turn_id, status, &reason)?;
                return Err(reason);
            }
        };
        settle_pending_questions_for_turn(state, &canonical_turn_id, "abandoned")?;
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
            reply.assistant_message.as_deref(),
            &reply.task_receipts,
            &reply.workflow_receipts,
        )?;
        if selected_route.harness_mode == LocalCodexChatHarnessMode::Plan {
            if let Some((runtime_operation_id, activity_id, plan)) = plan_draft.finish() {
                persist_plan_pending(
                    state,
                    &StoredChatPlanDecision {
                        conversation_id: request.conversation_id.clone(),
                        project_id: request.project_id.clone(),
                        turn_id: canonical_turn_id.clone(),
                        turn_ordinal: turn_count,
                        runtime_operation_id,
                        activity_id,
                        plan,
                        status: "pending".to_owned(),
                        decided_at_unix_ms: None,
                        accept_turn_id: None,
                    },
                )?;
            }
        }
        reply.timeline_turn_id = canonical_turn_id;

        Ok(reply)
    }

    pub fn decide_plan_with_task_authoring_and_cancellation<B, F, A, Q>(
        &mut self,
        state: &ServerStateService<B>,
        request: LocalCodexChatPlanDecisionRequest,
        cancellation: AgentTurnCancellation,
        questions: &LocalCodexChatQuestionRegistry,
        execute: &mut F,
        on_activity: &mut A,
        on_question: &mut Q,
    ) -> Result<LocalCodexChatPlanDecisionReply, String>
    where
        B: LocalStoreBackend + Clone,
        F: FnMut(ServerControlRequest) -> Result<(), String>,
        A: FnMut(StoredChatActivity, Option<StoredChatSubagentDirectory>) -> Result<(), String>,
        Q: FnMut(StoredChatQuestionExchange) -> Result<(), String>,
    {
        let stored = read_session(state, &request.conversation_id)?
            .filter(|session| session.project_id == request.project_id)
            .ok_or_else(|| {
                format!(
                    "Agent Chat plan conversation is unknown: {}",
                    request.conversation_id
                )
            })?;
        let accept_turn_id = (request.decision == LocalCodexChatPlanDecisionKind::Accepted)
            .then(|| canonical_turn_id(&request.conversation_id, stored.turn_count + 1));
        let decision = super::persistence::settle_plan_decision(
            state,
            &request,
            now_unix_ms(),
            accept_turn_id,
        )?;
        let follow_up = if request.decision == LocalCodexChatPlanDecisionKind::Accepted {
            let accept = LocalCodexChatRequest {
                conversation_id: request.conversation_id.clone(),
                project_id: request.project_id.clone(),
                resource_id: stored.resource_id.clone(),
                message: format!(
                    "The operator accepted the proposed plan. Proceed with it as proposed. Accepted plan follows.\n\n{}",
                    decision.plan
                ),
                active_task_id: None,
                active_goal_id: None,
                provider_instance_id: None,
                provider_instance_revision: None,
                protocol_facade_id: None,
                provider_id: None,
                model: None,
                reasoning_effort: None,
                harness_mode: LocalCodexChatHarnessMode::Normal,
                idioms_enabled: true,
            };
            Some(self.send_message_with_task_authoring_and_cancellation(
                state,
                accept,
                cancellation,
                questions,
                execute,
                on_activity,
                on_question,
            )?)
        } else {
            None
        };
        Ok(LocalCodexChatPlanDecisionReply {
            decision,
            follow_up,
        })
    }
}
