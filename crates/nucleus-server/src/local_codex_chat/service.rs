//! The chat service: live session registry, task review snapshot store,
//! turn timeout, and the query and wrapper surface over turn orchestration.
//!
//! Split from the local_codex_chat god file; behavior unchanged.

use std::collections::HashMap;
use std::time::Duration;

use nucleus_agent_protocol::AgentTurnCancellation;
use nucleus_local_store::LocalStoreBackend;

use super::persistence::{
    delete_thread, list_threads, read_history, rename_thread, LocalCodexChatHistory,
    LocalCodexChatThreadSummary,
};
use super::routing::CHAT_TURN_TIMEOUT;
use super::types::{
    LocalCodexChatPlanDecisionReply, LocalCodexChatPlanDecisionRequest, LocalCodexChatReply,
    LocalCodexChatRequest,
};
use super::LocalCodexChatQuestionRegistry;
use super::AgentChatProviderCatalogue;
use crate::control_api::ServerControlRequest;
use crate::ServerStateService;

pub struct LocalCodexChatService {
    pub(super) sessions: HashMap<String, super::runtime::LocalCodexChatSession>,
    pub(super) task_review_snapshot_store: Option<crate::TaskReviewSnapshotStore>,
    pub(super) turn_timeout: Duration,
}

impl Default for LocalCodexChatService {
    fn default() -> Self {
        Self {
            sessions: HashMap::new(),
            task_review_snapshot_store: None,
            turn_timeout: CHAT_TURN_TIMEOUT,
        }
    }
}

impl LocalCodexChatService {
    pub fn provider_catalogue() -> Result<AgentChatProviderCatalogue, String> {
        AgentChatProviderCatalogue::discover()
    }

    pub fn with_task_review_snapshot_store(store: crate::TaskReviewSnapshotStore) -> Self {
        Self {
            sessions: HashMap::new(),
            task_review_snapshot_store: Some(store),
            turn_timeout: CHAT_TURN_TIMEOUT,
        }
    }

    pub fn with_task_review_snapshot_store_and_turn_timeout(
        store: crate::TaskReviewSnapshotStore,
        turn_timeout: Duration,
    ) -> Self {
        Self {
            sessions: HashMap::new(),
            task_review_snapshot_store: Some(store),
            turn_timeout,
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

    pub fn threads<B>(
        &self,
        state: &ServerStateService<B>,
    ) -> Result<Vec<LocalCodexChatThreadSummary>, String>
    where
        B: LocalStoreBackend,
    {
        list_threads(state)
    }

    pub fn rename_thread<B>(
        &self,
        state: &ServerStateService<B>,
        project_id: &str,
        conversation_id: &str,
        title: &str,
    ) -> Result<(), String>
    where
        B: LocalStoreBackend,
    {
        rename_thread(state, project_id, conversation_id, title)
    }

    pub fn delete_thread<B>(
        &mut self,
        state: &ServerStateService<B>,
        project_id: &str,
        conversation_id: &str,
    ) -> Result<u64, String>
    where
        B: LocalStoreBackend,
    {
        // Dropping the live session closes the provider session; the chat
        // mutex on the Tauri boundary guarantees no turn is in flight.
        self.sessions.remove(conversation_id);
        delete_thread(state, project_id, conversation_id)
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
        F: FnMut(ServerControlRequest) -> Result<(), String>,
    {
        let mut ignore_activity = |_, _| Ok(());
        let mut ignore_question = |_| Ok(());
        let questions = LocalCodexChatQuestionRegistry::default();
        self.send_message_with_task_authoring_and_cancellation(
            state,
            request,
            AgentTurnCancellation::new(),
            &questions,
            execute,
            &mut ignore_activity,
            &mut ignore_question,
        )
    }

    pub fn decide_plan<B>(
        &mut self,
        state: &ServerStateService<B>,
        request: LocalCodexChatPlanDecisionRequest,
    ) -> Result<LocalCodexChatPlanDecisionReply, String>
    where
        B: LocalStoreBackend + Clone,
    {
        let mut ignore_activity = |_, _| Ok(());
        let mut ignore_question = |_| Ok(());
        let questions = LocalCodexChatQuestionRegistry::default();
        self.decide_plan_with_task_authoring_and_cancellation(
            state,
            request,
            AgentTurnCancellation::new(),
            &questions,
            &mut |_| Err("agent task authoring is unavailable on this chat boundary".to_owned()),
            &mut ignore_activity,
            &mut ignore_question,
        )
    }
}
