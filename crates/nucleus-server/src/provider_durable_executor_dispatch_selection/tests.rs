use super::*;
use crate::{
    durable_provider_executor_command, durable_provider_executor_status,
    DurableProviderExecutorCommandId, DurableProviderExecutorCommandInput,
    DurableProviderExecutorCommandRecord, DurableProviderExecutorLane,
    DurableProviderExecutorMethod, DurableProviderExecutorRequestedState,
    DurableProviderExecutorState, DurableProviderExecutorStatusInput,
    DurableProviderExecutorStatusRecord,
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

fn input() -> DurableProviderExecutorDispatchSelectionInput {
    DurableProviderExecutorDispatchSelectionInput {
        command: command(),
        latest_status: None,
        provider_ready_evidence_refs: vec!["evidence:provider-ready:1".to_owned()],
        runtime_ready_evidence_refs: vec!["evidence:runtime-ready:1".to_owned()],
        selection_evidence_refs: vec!["evidence:selection:1".to_owned()],
        in_flight_write_attempt_ids: Vec::new(),
        stale_command_evidence: false,
        background_execution_requested: false,
        provider_write_requested: false,
        raw_provider_material_requested: false,
        raw_callback_material_requested: false,
        task_mutation_requested: false,
        review_acceptance_requested: false,
        callback_answer_requested: false,
        interruption_requested: false,
        recovery_requested: false,
        replacement_thread_promotion_requested: false,
        scm_mutation_requested: false,
    }
}

fn status(state: DurableProviderExecutorRequestedState) -> DurableProviderExecutorStatusRecord {
    durable_provider_executor_status(DurableProviderExecutorStatusInput {
        command: command(),
        requested_state: state,
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
    })
}

#[test]
fn durable_executor_dispatch_selection_accepts_eligible_command_without_execution() {
    let record = durable_provider_executor_dispatch_selection(input());

    assert_eq!(
        record.status,
        DurableProviderExecutorDispatchSelectionStatus::SelectedForDispatchAdmission
    );
    assert!(record.blockers.is_empty());
    assert_eq!(record.command_id, "durable-provider-executor-command:1");
    assert_eq!(record.task_id.as_deref(), Some("task:1"));
    assert_eq!(record.work_item_id.as_deref(), Some("work:1"));
    assert!(record
        .evidence_refs
        .contains(&"evidence:provider-ready:1".to_owned()));
    assert!(!record.executor_invoked);
    assert!(!record.provider_write_selected);
    assert!(!record.client_authority_granted);
    assert!(!record.task_mutation_permitted);
}

#[test]
fn durable_executor_dispatch_selection_allows_queued_status() {
    let mut input = input();
    input.latest_status = Some(durable_provider_executor_status(
        DurableProviderExecutorStatusInput {
            command: command(),
            requested_state: DurableProviderExecutorRequestedState::Queued,
            live_executor_outcome_id: None,
            runtime_receipt_id: None,
            evidence_refs: vec!["evidence:status:queued".to_owned()],
            provider_write_executed: false,
            raw_provider_material_retained: false,
            raw_callback_material_retained: false,
            task_mutation_requested: false,
            review_acceptance_requested: false,
            callback_answer_requested: false,
            interruption_requested: false,
            recovery_requested: false,
            replacement_thread_promotion_requested: false,
            scm_mutation_requested: false,
        },
    ));

    let record = durable_provider_executor_dispatch_selection(input);

    assert_eq!(
        record.status,
        DurableProviderExecutorDispatchSelectionStatus::SelectedForDispatchAdmission
    );
    assert_eq!(
        record.latest_status_state,
        Some(DurableProviderExecutorState::Queued)
    );
}

#[test]
fn durable_executor_dispatch_selection_blocks_in_flight_and_terminal_statuses() {
    let mut running = input();
    running.latest_status = Some(durable_provider_executor_status(
        DurableProviderExecutorStatusInput {
            command: command(),
            requested_state: DurableProviderExecutorRequestedState::Running,
            live_executor_outcome_id: None,
            runtime_receipt_id: None,
            evidence_refs: vec!["evidence:status:running".to_owned()],
            provider_write_executed: false,
            raw_provider_material_retained: false,
            raw_callback_material_retained: false,
            task_mutation_requested: false,
            review_acceptance_requested: false,
            callback_answer_requested: false,
            interruption_requested: false,
            recovery_requested: false,
            replacement_thread_promotion_requested: false,
            scm_mutation_requested: false,
        },
    ));
    let running_record = durable_provider_executor_dispatch_selection(running);

    let mut completed = input();
    completed.latest_status = Some(status(DurableProviderExecutorRequestedState::Completed));
    let completed_record = durable_provider_executor_dispatch_selection(completed);

    assert!(running_record
        .blockers
        .contains(&DurableProviderExecutorDispatchSelectionBlocker::LatestStatusInFlight));
    assert!(completed_record
        .blockers
        .contains(&DurableProviderExecutorDispatchSelectionBlocker::LatestStatusTerminal));
}

#[test]
fn durable_executor_dispatch_selection_blocks_missing_readiness_and_stale_evidence() {
    let mut input = input();
    input.command.operator_confirmation_ref = None;
    input.command.runtime_session_ref.clear();
    input.provider_ready_evidence_refs.clear();
    input.runtime_ready_evidence_refs = vec![String::new()];
    input.selection_evidence_refs.clear();
    input
        .in_flight_write_attempt_ids
        .push("provider-transport-write:1".to_owned());
    input.stale_command_evidence = true;

    let record = durable_provider_executor_dispatch_selection(input);

    assert_eq!(
        record.status,
        DurableProviderExecutorDispatchSelectionStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorDispatchSelectionBlocker::MissingOperatorConfirmation));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorDispatchSelectionBlocker::MissingRuntimeSessionRef));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorDispatchSelectionBlocker::MissingProviderReadyEvidence));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorDispatchSelectionBlocker::MissingRuntimeReadyEvidence));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorDispatchSelectionBlocker::MissingSelectionEvidence));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorDispatchSelectionBlocker::DuplicateInFlightWriteAttempt));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorDispatchSelectionBlocker::StaleCommandEvidence));
}

#[test]
fn durable_executor_dispatch_selection_blocks_authority_widening() {
    let mut input = input();
    input.background_execution_requested = true;
    input.provider_write_requested = true;
    input.raw_provider_material_requested = true;
    input.raw_callback_material_requested = true;
    input.task_mutation_requested = true;
    input.review_acceptance_requested = true;
    input.callback_answer_requested = true;
    input.interruption_requested = true;
    input.recovery_requested = true;
    input.replacement_thread_promotion_requested = true;
    input.scm_mutation_requested = true;

    let record = durable_provider_executor_dispatch_selection(input);

    assert!(record
        .blockers
        .contains(&DurableProviderExecutorDispatchSelectionBlocker::BackgroundExecutionRequested));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorDispatchSelectionBlocker::ProviderWriteRequested));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorDispatchSelectionBlocker::TaskMutationRequested));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorDispatchSelectionBlocker::ScmMutationRequested));
}
