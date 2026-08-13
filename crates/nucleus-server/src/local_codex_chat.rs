//! Local Codex-backed product chat with durable Nucleus timeline records.
//!
//! Module index over the chat surface: wire types (`types`), the service
//! registry and queries (`service`), full-turn orchestration (`turn`),
//! request routing and context (`routing`), and the persistence records.

use nucleus_local_store::LocalStoreBackend;

mod cancellation;
mod credentials;
mod delegation;
mod goal_authoring;
mod goal_execution;
mod goal_inspection;
mod goal_run;
mod goal_update;
mod mandates;
mod persistence;
mod provider_catalogue;
mod questions;
mod review_evidence;
mod rework_context;
mod routing;
pub(crate) mod run_transitions;
mod runtime;
mod service;
mod subagent_directory;
mod subagent_selection;
mod task_authoring;
mod task_execution;
mod task_inspection;
mod task_ledger;
mod task_update;
mod task_workflow;
mod turn;
mod types;

pub use cancellation::{ActiveLocalCodexChatTurn, LocalCodexChatCancellationRegistry};
pub use credentials::{
    request_action as request_local_codex_credential_action, LocalCodexCredentialAction,
    LocalCodexCredentialActionAvailability, LocalCodexCredentialActionCapability,
    LocalCodexCredentialActionCode, LocalCodexCredentialActionOutcome,
    LocalCodexCredentialActionReceipt, LocalCodexCredentialActionRequest,
    LocalCodexCredentialActionUnavailableReason, LocalCodexCredentialEvidencePosture,
    LocalCodexCredentialMechanism, LocalCodexCredentialOwnership, LocalCodexCredentialStatus,
    LocalCodexCredentialSummary, LocalCodexEntitlementMetering,
};
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
pub use persistence::{
    read_native_proof_evidence, recover_interrupted_chat_state, ChatMessageRole,
    LocalCodexChatHistory, LocalCodexChatThreadSummary, NativeProofEvidenceSummary,
    StoredChatActivity, StoredChatMessage, StoredChatPlanDecision, StoredChatQuestion,
    StoredChatQuestionAnswer, StoredChatQuestionExchange, StoredChatQuestionOption,
    StoredChatSubagent, StoredChatTaskListItem,
};
#[cfg(test)]
pub(crate) use persistence::{
    persist_turn_completion as persist_test_turn_completion,
    persist_turn_start as persist_test_turn_start, StoredChatSession as TestStoredChatSession,
};
pub use provider_catalogue::{
    AgentChatCredentialPosture, AgentChatProviderCatalogue, AgentChatProviderInstance,
};
pub use questions::{
    LocalCodexChatQuestionAnswer, LocalCodexChatQuestionAnswerRequest,
    LocalCodexChatQuestionRegistry,
};
pub use service::LocalCodexChatService;
pub use subagent_directory::StoredChatSubagentDirectory;
pub use subagent_selection::{
    select_chat_actor, LocalCodexChatActorSelectionKind, LocalCodexChatActorSelectionRequest,
    StoredChatActorSelection,
};
pub use task_authoring::{GoalCreationReceipt, TaskAuthoringReceipt, TaskCreationReceipt};
pub use task_workflow::{TaskWorkflowReceipt, TaskWorkflowReceiptStatus};
pub use types::{
    LocalCodexChatHarnessMode, LocalCodexChatModelOption, LocalCodexChatPlanDecisionKind,
    LocalCodexChatPlanDecisionReply, LocalCodexChatPlanDecisionRequest,
    LocalCodexChatReasoningOption, LocalCodexChatReply, LocalCodexChatRequest,
};

use crate::ServerStateService;

pub fn answer_local_codex_chat_question<B>(
    state: &ServerStateService<B>,
    registry: &LocalCodexChatQuestionRegistry,
    request: LocalCodexChatQuestionAnswerRequest,
) -> Result<StoredChatQuestionExchange, String>
where
    B: LocalStoreBackend,
{
    let turn_id = request.turn_id.clone();
    let callback_id = request.callback_id.clone();
    let mut persisted = None;
    registry.answer_with(request, |question, response| {
        persisted = Some(persistence::persist_question_answer(
            state,
            &turn_id,
            &callback_id,
            question,
            response,
        )?);
        Ok(())
    })?;
    persisted.ok_or_else(|| "Agent Chat question answer was not persisted".to_owned())
}

#[cfg(test)]
pub(crate) fn persist_test_turn_failure<B>(
    state: &ServerStateService<B>,
    turn_id: &str,
    reason: &str,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    persistence::persist_turn_failure(
        state,
        turn_id,
        persistence::ChatTurnFailureStatus::Failed,
        reason,
    )
}

pub(crate) fn project_has_active_chat_turn<B>(
    state: &ServerStateService<B>,
    project_id: &str,
) -> Result<bool, String>
where
    B: LocalStoreBackend,
{
    persistence::project_has_active_turn(state, project_id)
}

#[cfg(test)]
mod tests;
