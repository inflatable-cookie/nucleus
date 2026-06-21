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
    let record =
        durable_provider_executor_status(input(DurableProviderExecutorRequestedState::Completed));

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
