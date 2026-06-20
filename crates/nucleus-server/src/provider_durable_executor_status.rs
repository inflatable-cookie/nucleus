//! Durable provider executor status records.
//!
//! These records expose command lifecycle state without executing provider
//! writes, retaining raw material, or mutating task/review/provider authority.

use serde::{Deserialize, Serialize};

use crate::{DurableProviderExecutorCommandRecord, DurableProviderExecutorCommandStatus};

/// Stable id for one durable provider executor status record.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct DurableProviderExecutorStatusId(pub String);

/// Input for building a durable executor status record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableProviderExecutorStatusInput {
    pub command: DurableProviderExecutorCommandRecord,
    pub requested_state: DurableProviderExecutorRequestedState,
    pub live_executor_outcome_id: Option<String>,
    pub runtime_receipt_id: Option<String>,
    pub evidence_refs: Vec<String>,
    pub provider_write_executed: bool,
    pub raw_provider_material_retained: bool,
    pub raw_callback_material_retained: bool,
    pub task_mutation_requested: bool,
    pub review_acceptance_requested: bool,
    pub callback_answer_requested: bool,
    pub interruption_requested: bool,
    pub recovery_requested: bool,
    pub replacement_thread_promotion_requested: bool,
    pub scm_mutation_requested: bool,
}

/// Requested lifecycle state before validation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableProviderExecutorRequestedState {
    Queued,
    Running,
    Completed,
    Failed(String),
    Blocked(String),
    TimedOut,
    CleanupRequired(String),
}

/// Durable executor command status record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DurableProviderExecutorStatusRecord {
    pub status_id: DurableProviderExecutorStatusId,
    pub command_id: String,
    pub lane_admission_id: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub write_attempt_id: String,
    pub idempotency_key: String,
    pub state: DurableProviderExecutorState,
    pub blockers: Vec<DurableProviderExecutorStatusBlocker>,
    pub live_executor_outcome_id: Option<String>,
    pub runtime_receipt_id: Option<String>,
    pub evidence_refs: Vec<String>,
    pub provider_write_recorded: bool,
    pub provider_completion_recorded: bool,
    pub raw_provider_material_retained: bool,
    pub raw_callback_material_retained: bool,
    pub task_mutation_permitted: bool,
    pub review_acceptance_permitted: bool,
    pub callback_answer_permitted: bool,
    pub interruption_permitted: bool,
    pub recovery_permitted: bool,
    pub replacement_thread_promotion_permitted: bool,
    pub scm_mutation_permitted: bool,
}

/// Validated lifecycle state.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableProviderExecutorState {
    Queued,
    Running,
    Completed,
    Failed(String),
    Blocked(String),
    TimedOut,
    CleanupRequired(String),
    Invalid,
}

/// Why a durable executor status record cannot be trusted.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableProviderExecutorStatusBlocker {
    CommandNotAccepted,
    CommandAlreadyExecutedProviderWrite,
    CommandPermitsForbiddenAuthority,
    MissingEvidenceRef,
    TerminalStateMissingOutcomeId,
    TerminalStateMissingRuntimeReceiptId,
    ProviderWriteRecordedBeforeTerminalState,
    CompletedWithoutProviderWrite,
    RawProviderMaterialRetained,
    RawCallbackMaterialRetained,
    TaskMutationRequested,
    ReviewAcceptanceRequested,
    CallbackAnswerRequested,
    InterruptionRequested,
    RecoveryRequested,
    ReplacementThreadPromotionRequested,
    ScmMutationRequested,
}

/// Build a durable executor command status record without executing provider I/O.
pub fn durable_provider_executor_status(
    input: DurableProviderExecutorStatusInput,
) -> DurableProviderExecutorStatusRecord {
    let blockers = status_blockers(&input);
    let state = if blockers.is_empty() {
        requested_state(input.requested_state.clone())
    } else {
        DurableProviderExecutorState::Invalid
    };
    let provider_completion_recorded = matches!(state, DurableProviderExecutorState::Completed);
    let mut evidence_refs = input.command.evidence_refs.clone();
    evidence_refs.extend(input.evidence_refs);
    evidence_refs.sort();
    evidence_refs.dedup();

    DurableProviderExecutorStatusRecord {
        status_id: DurableProviderExecutorStatusId(format!(
            "durable-provider-executor-status:{}:{}",
            input.command.command_id.0,
            status_label(&input.requested_state)
        )),
        command_id: input.command.command_id.0,
        lane_admission_id: input.command.lane_admission_id,
        provider_instance_id: input.command.provider_instance_id,
        runtime_session_ref: input.command.runtime_session_ref,
        write_attempt_id: input.command.write_attempt_id,
        idempotency_key: input.command.idempotency_key,
        state,
        blockers,
        live_executor_outcome_id: input.live_executor_outcome_id,
        runtime_receipt_id: input.runtime_receipt_id,
        evidence_refs,
        provider_write_recorded: input.provider_write_executed,
        provider_completion_recorded,
        raw_provider_material_retained: false,
        raw_callback_material_retained: false,
        task_mutation_permitted: false,
        review_acceptance_permitted: false,
        callback_answer_permitted: false,
        interruption_permitted: false,
        recovery_permitted: false,
        replacement_thread_promotion_permitted: false,
        scm_mutation_permitted: false,
    }
}

fn status_blockers(
    input: &DurableProviderExecutorStatusInput,
) -> Vec<DurableProviderExecutorStatusBlocker> {
    let mut blockers = Vec::new();

    if input.command.status != DurableProviderExecutorCommandStatus::AcceptedForPersistence {
        blockers.push(DurableProviderExecutorStatusBlocker::CommandNotAccepted);
    }
    if input.command.provider_write_executed {
        blockers.push(DurableProviderExecutorStatusBlocker::CommandAlreadyExecutedProviderWrite);
    }
    if input.command.client_authority_granted
        || input.command.raw_provider_material_retained
        || input.command.raw_callback_material_retained
        || input.command.task_mutation_permitted
        || input.command.review_acceptance_permitted
        || input.command.callback_answer_permitted
        || input.command.interruption_permitted
        || input.command.recovery_permitted
        || input.command.replacement_thread_promotion_permitted
        || input.command.scm_mutation_permitted
    {
        blockers.push(DurableProviderExecutorStatusBlocker::CommandPermitsForbiddenAuthority);
    }
    if input.evidence_refs.is_empty() || input.evidence_refs.iter().any(|value| value.is_empty()) {
        blockers.push(DurableProviderExecutorStatusBlocker::MissingEvidenceRef);
    }
    if terminal_state(&input.requested_state) {
        if input
            .live_executor_outcome_id
            .as_deref()
            .unwrap_or_default()
            .is_empty()
        {
            blockers.push(DurableProviderExecutorStatusBlocker::TerminalStateMissingOutcomeId);
        }
        if input
            .runtime_receipt_id
            .as_deref()
            .unwrap_or_default()
            .is_empty()
        {
            blockers
                .push(DurableProviderExecutorStatusBlocker::TerminalStateMissingRuntimeReceiptId);
        }
    }
    if !terminal_state(&input.requested_state) && input.provider_write_executed {
        blockers
            .push(DurableProviderExecutorStatusBlocker::ProviderWriteRecordedBeforeTerminalState);
    }
    if matches!(
        input.requested_state,
        DurableProviderExecutorRequestedState::Completed
    ) && !input.provider_write_executed
    {
        blockers.push(DurableProviderExecutorStatusBlocker::CompletedWithoutProviderWrite);
    }
    authority_blockers(input, &mut blockers);

    blockers
}

fn authority_blockers(
    input: &DurableProviderExecutorStatusInput,
    blockers: &mut Vec<DurableProviderExecutorStatusBlocker>,
) {
    if input.raw_provider_material_retained {
        blockers.push(DurableProviderExecutorStatusBlocker::RawProviderMaterialRetained);
    }
    if input.raw_callback_material_retained {
        blockers.push(DurableProviderExecutorStatusBlocker::RawCallbackMaterialRetained);
    }
    if input.task_mutation_requested {
        blockers.push(DurableProviderExecutorStatusBlocker::TaskMutationRequested);
    }
    if input.review_acceptance_requested {
        blockers.push(DurableProviderExecutorStatusBlocker::ReviewAcceptanceRequested);
    }
    if input.callback_answer_requested {
        blockers.push(DurableProviderExecutorStatusBlocker::CallbackAnswerRequested);
    }
    if input.interruption_requested {
        blockers.push(DurableProviderExecutorStatusBlocker::InterruptionRequested);
    }
    if input.recovery_requested {
        blockers.push(DurableProviderExecutorStatusBlocker::RecoveryRequested);
    }
    if input.replacement_thread_promotion_requested {
        blockers.push(DurableProviderExecutorStatusBlocker::ReplacementThreadPromotionRequested);
    }
    if input.scm_mutation_requested {
        blockers.push(DurableProviderExecutorStatusBlocker::ScmMutationRequested);
    }
}

fn requested_state(state: DurableProviderExecutorRequestedState) -> DurableProviderExecutorState {
    match state {
        DurableProviderExecutorRequestedState::Queued => DurableProviderExecutorState::Queued,
        DurableProviderExecutorRequestedState::Running => DurableProviderExecutorState::Running,
        DurableProviderExecutorRequestedState::Completed => DurableProviderExecutorState::Completed,
        DurableProviderExecutorRequestedState::Failed(reason) => {
            DurableProviderExecutorState::Failed(reason)
        }
        DurableProviderExecutorRequestedState::Blocked(reason) => {
            DurableProviderExecutorState::Blocked(reason)
        }
        DurableProviderExecutorRequestedState::TimedOut => DurableProviderExecutorState::TimedOut,
        DurableProviderExecutorRequestedState::CleanupRequired(reason) => {
            DurableProviderExecutorState::CleanupRequired(reason)
        }
    }
}

fn terminal_state(state: &DurableProviderExecutorRequestedState) -> bool {
    matches!(
        state,
        DurableProviderExecutorRequestedState::Completed
            | DurableProviderExecutorRequestedState::Failed(_)
            | DurableProviderExecutorRequestedState::Blocked(_)
            | DurableProviderExecutorRequestedState::TimedOut
            | DurableProviderExecutorRequestedState::CleanupRequired(_)
    )
}

fn status_label(state: &DurableProviderExecutorRequestedState) -> &'static str {
    match state {
        DurableProviderExecutorRequestedState::Queued => "queued",
        DurableProviderExecutorRequestedState::Running => "running",
        DurableProviderExecutorRequestedState::Completed => "completed",
        DurableProviderExecutorRequestedState::Failed(_) => "failed",
        DurableProviderExecutorRequestedState::Blocked(_) => "blocked",
        DurableProviderExecutorRequestedState::TimedOut => "timed-out",
        DurableProviderExecutorRequestedState::CleanupRequired(_) => "cleanup-required",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        durable_provider_executor_command, DurableProviderExecutorCommandId,
        DurableProviderExecutorCommandInput, DurableProviderExecutorLane,
        DurableProviderExecutorMethod,
    };

    fn command() -> DurableProviderExecutorCommandRecord {
        durable_provider_executor_command(DurableProviderExecutorCommandInput {
            command_id: DurableProviderExecutorCommandId(
                "durable-provider-executor-command:1".to_owned(),
            ),
            lane: DurableProviderExecutorLane::TaskBackedTurnStart,
            lane_admission_id: "task-work-live-executor-admission:1".to_owned(),
            provider_instance_id: "codex:local-default".to_owned(),
            runtime_session_ref: "runtime-session:1".to_owned(),
            write_attempt_id: "provider-transport-write:1".to_owned(),
            idempotency_key: "idempotency:1".to_owned(),
            task_id: Some("task:1".to_owned()),
            work_item_id: Some("work:1".to_owned()),
            method: DurableProviderExecutorMethod::TurnStart,
            evidence_refs: vec!["evidence:command:1".to_owned()],
            operator_confirmation_ref: Some("operator-confirmation:1".to_owned()),
            client_authority_requested: false,
            invoke_executor_requested: false,
            raw_provider_material_requested: false,
            raw_callback_material_requested: false,
            task_mutation_requested: false,
            review_acceptance_requested: false,
            callback_answer_requested: false,
            interruption_requested: false,
            recovery_requested: false,
            replacement_thread_promotion_requested: false,
            scm_mutation_requested: false,
        })
    }

    fn input(
        requested_state: DurableProviderExecutorRequestedState,
    ) -> DurableProviderExecutorStatusInput {
        DurableProviderExecutorStatusInput {
            command: command(),
            requested_state,
            live_executor_outcome_id: Some("outcome:1".to_owned()),
            runtime_receipt_id: Some("receipt:1".to_owned()),
            evidence_refs: vec!["evidence:status:1".to_owned()],
            provider_write_executed: true,
            raw_provider_material_retained: false,
            raw_callback_material_retained: false,
            task_mutation_requested: false,
            review_acceptance_requested: false,
            callback_answer_requested: false,
            interruption_requested: false,
            recovery_requested: false,
            replacement_thread_promotion_requested: false,
            scm_mutation_requested: false,
        }
    }

    #[test]
    fn durable_provider_executor_status_records_completed_without_authority() {
        let record = durable_provider_executor_status(input(
            DurableProviderExecutorRequestedState::Completed,
        ));

        assert_eq!(record.state, DurableProviderExecutorState::Completed);
        assert!(record.blockers.is_empty());
        assert!(record.provider_write_recorded);
        assert!(record.provider_completion_recorded);
        assert_eq!(
            record.live_executor_outcome_id.as_deref(),
            Some("outcome:1")
        );
        assert_eq!(record.runtime_receipt_id.as_deref(), Some("receipt:1"));
        assert!(!record.raw_provider_material_retained);
        assert!(!record.raw_callback_material_retained);
        assert!(!record.task_mutation_permitted);
        assert!(!record.review_acceptance_permitted);
        assert!(!record.callback_answer_permitted);
        assert!(!record.interruption_permitted);
        assert!(!record.recovery_permitted);
        assert!(!record.replacement_thread_promotion_permitted);
        assert!(!record.scm_mutation_permitted);
    }

    #[test]
    fn durable_provider_executor_status_records_queued_without_provider_write() {
        let mut input = input(DurableProviderExecutorRequestedState::Queued);
        input.live_executor_outcome_id = None;
        input.runtime_receipt_id = None;
        input.provider_write_executed = false;

        let record = durable_provider_executor_status(input);

        assert_eq!(record.state, DurableProviderExecutorState::Queued);
        assert!(record.blockers.is_empty());
        assert!(!record.provider_write_recorded);
        assert!(!record.provider_completion_recorded);
    }

    #[test]
    fn durable_provider_executor_status_blocks_terminal_state_without_receipt_links() {
        let mut input = input(DurableProviderExecutorRequestedState::Failed(
            "provider exited".to_owned(),
        ));
        input.live_executor_outcome_id = None;
        input.runtime_receipt_id = None;

        let record = durable_provider_executor_status(input);

        assert_eq!(record.state, DurableProviderExecutorState::Invalid);
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorStatusBlocker::TerminalStateMissingOutcomeId));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorStatusBlocker::TerminalStateMissingRuntimeReceiptId));
    }

    #[test]
    fn durable_provider_executor_status_blocks_authority_widening() {
        let mut input = input(DurableProviderExecutorRequestedState::Completed);
        input.raw_provider_material_retained = true;
        input.raw_callback_material_retained = true;
        input.task_mutation_requested = true;
        input.review_acceptance_requested = true;
        input.callback_answer_requested = true;
        input.interruption_requested = true;
        input.recovery_requested = true;
        input.replacement_thread_promotion_requested = true;
        input.scm_mutation_requested = true;

        let record = durable_provider_executor_status(input);

        assert_eq!(record.state, DurableProviderExecutorState::Invalid);
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorStatusBlocker::RawProviderMaterialRetained));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorStatusBlocker::RawCallbackMaterialRetained));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorStatusBlocker::TaskMutationRequested));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorStatusBlocker::ReviewAcceptanceRequested));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorStatusBlocker::CallbackAnswerRequested));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorStatusBlocker::InterruptionRequested));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorStatusBlocker::RecoveryRequested));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorStatusBlocker::ReplacementThreadPromotionRequested));
        assert!(record
            .blockers
            .contains(&DurableProviderExecutorStatusBlocker::ScmMutationRequested));
    }
}
