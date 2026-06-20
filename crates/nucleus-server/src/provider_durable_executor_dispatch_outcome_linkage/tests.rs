use super::*;
use crate::{
    codex_live_executor_outcome_record, durable_provider_executor_command,
    durable_provider_executor_dispatch_admission, durable_provider_executor_dispatch_selection,
    CodexAppServerLiveExecutorCleanupStatus, CodexAppServerLiveExecutorMethod,
    CodexAppServerLiveExecutorOutcomeInput, DurableProviderExecutorCommandId,
    DurableProviderExecutorCommandInput, DurableProviderExecutorDispatchAdmissionInput,
    DurableProviderExecutorDispatchSelectionInput, DurableProviderExecutorLane,
    DurableProviderExecutorMethod, DurableProviderExecutorState,
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

fn admission() -> DurableProviderExecutorDispatchAdmissionRecord {
    durable_provider_executor_dispatch_admission(DurableProviderExecutorDispatchAdmissionInput {
        selection: durable_provider_executor_dispatch_selection(
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
            },
        ),
        dispatch_attempt_id: "dispatch-attempt:1".to_owned(),
        operator_confirmation_ref: Some("operator-confirmation:dispatch:1".to_owned()),
        runtime_session_evidence_refs: vec!["evidence:runtime-session:1".to_owned()],
        provider_ready_evidence_refs: vec!["evidence:provider-ready:admission:1".to_owned()],
        admission_evidence_refs: vec!["evidence:admission:1".to_owned()],
        write_attempt_id: "provider-transport-write:1".to_owned(),
        idempotency_key: "idempotency:1".to_owned(),
        invoke_executor_requested: false,
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
    })
}

fn outcome(
    status: CodexAppServerLiveExecutorOutcomeStatus,
) -> CodexAppServerLiveExecutorOutcomeRecord {
    let provider_write_executed =
        !matches!(status, CodexAppServerLiveExecutorOutcomeStatus::Accepted);
    codex_live_executor_outcome_record(CodexAppServerLiveExecutorOutcomeInput {
        provider_instance_id: "codex:local-default".to_owned(),
        write_attempt_id: "provider-transport-write:1".to_owned(),
        receipt_refs: vec!["receipt:provider:1".to_owned()],
        thread_id: Some("thread:1".to_owned()),
        turn_id: Some("turn:1".to_owned()),
        final_turn_status: Some("completed".to_owned()),
        status,
        method_sequence: vec![
            CodexAppServerLiveExecutorMethod::Initialize,
            CodexAppServerLiveExecutorMethod::InitializedNotification,
            CodexAppServerLiveExecutorMethod::ThreadStart,
            CodexAppServerLiveExecutorMethod::TurnStart,
            CodexAppServerLiveExecutorMethod::TurnCompleted,
            CodexAppServerLiveExecutorMethod::Cleanup,
        ],
        notification_count: 2,
        server_request_count: 0,
        cleanup_status: CodexAppServerLiveExecutorCleanupStatus::Completed,
        evidence_refs: vec!["evidence:outcome:1".to_owned()],
        provider_write_executed,
    })
}

fn input(
    status: CodexAppServerLiveExecutorOutcomeStatus,
) -> DurableProviderExecutorDispatchOutcomeLinkageInput {
    DurableProviderExecutorDispatchOutcomeLinkageInput {
        admission: admission(),
        command: command(),
        outcome: outcome(status),
        runtime_receipt_id: "runtime-receipt:1".to_owned(),
        linkage_evidence_refs: vec!["evidence:linkage:1".to_owned()],
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
fn durable_executor_dispatch_outcome_linkage_records_completed_status() {
    let record = durable_provider_executor_dispatch_outcome_linkage(input(
        CodexAppServerLiveExecutorOutcomeStatus::Completed,
    ));

    assert_eq!(
        record.status,
        DurableProviderExecutorDispatchOutcomeLinkageStatus::Linked
    );
    assert!(record.blockers.is_empty());
    assert_eq!(
        record.live_executor_outcome_id,
        "codex-live-executor-outcome:provider-transport-write:1:completed"
    );
    assert_eq!(
        record.durable_status.state,
        DurableProviderExecutorState::Completed
    );
    assert!(record.provider_completion_recorded);
    assert!(!record.task_mutation_permitted);
    assert!(!record.review_acceptance_permitted);
}

#[test]
fn durable_executor_dispatch_outcome_linkage_keeps_failure_inspectable() {
    let record = durable_provider_executor_dispatch_outcome_linkage(input(
        CodexAppServerLiveExecutorOutcomeStatus::Failed("provider exited".to_owned()),
    ));

    assert_eq!(
        record.durable_status.state,
        DurableProviderExecutorState::Failed("provider exited".to_owned())
    );
    assert_eq!(
        record.status,
        DurableProviderExecutorDispatchOutcomeLinkageStatus::Linked
    );
}

#[test]
fn durable_executor_dispatch_outcome_linkage_keeps_accepted_outcome_running() {
    let record = durable_provider_executor_dispatch_outcome_linkage(input(
        CodexAppServerLiveExecutorOutcomeStatus::Accepted,
    ));

    assert_eq!(
        record.durable_status.state,
        DurableProviderExecutorState::Running
    );
    assert!(!record.provider_completion_recorded);
}

#[test]
fn durable_executor_dispatch_outcome_linkage_blocks_mismatched_records() {
    let mut input = input(CodexAppServerLiveExecutorOutcomeStatus::Blocked(
        "provider blocked".to_owned(),
    ));
    input.admission.status = DurableProviderExecutorDispatchAdmissionStatus::Blocked;
    input.command.command_id.0 = "durable-provider-executor-command:other".to_owned();
    input.outcome.provider_instance_id = "codex:other".to_owned();
    input.outcome.write_attempt_id = "provider-transport-write:other".to_owned();
    input.runtime_receipt_id.clear();
    input.linkage_evidence_refs.clear();

    let record = durable_provider_executor_dispatch_outcome_linkage(input);

    assert_eq!(
        record.status,
        DurableProviderExecutorDispatchOutcomeLinkageStatus::Blocked
    );
    assert_eq!(
        record.durable_status.state,
        DurableProviderExecutorState::Invalid
    );
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorDispatchOutcomeLinkageBlocker::AdmissionNotAccepted));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorDispatchOutcomeLinkageBlocker::CommandIdMismatch));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorDispatchOutcomeLinkageBlocker::ProviderInstanceMismatch));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorDispatchOutcomeLinkageBlocker::WriteAttemptMismatch));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorDispatchOutcomeLinkageBlocker::MissingRuntimeReceiptId));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorDispatchOutcomeLinkageBlocker::MissingLinkageEvidence));
}

#[test]
fn durable_executor_dispatch_outcome_linkage_blocks_authority_widening() {
    let mut input = input(CodexAppServerLiveExecutorOutcomeStatus::CleanupRequired(
        "cleanup".to_owned(),
    ));
    input.raw_provider_material_retained = true;
    input.raw_callback_material_retained = true;
    input.task_mutation_requested = true;
    input.review_acceptance_requested = true;
    input.callback_answer_requested = true;
    input.interruption_requested = true;
    input.recovery_requested = true;
    input.replacement_thread_promotion_requested = true;
    input.scm_mutation_requested = true;

    let record = durable_provider_executor_dispatch_outcome_linkage(input);

    assert!(record.blockers.contains(
        &DurableProviderExecutorDispatchOutcomeLinkageBlocker::RawProviderMaterialRetained
    ));
    assert!(record.blockers.contains(
        &DurableProviderExecutorDispatchOutcomeLinkageBlocker::RawCallbackMaterialRetained
    ));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorDispatchOutcomeLinkageBlocker::TaskMutationRequested));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorDispatchOutcomeLinkageBlocker::ScmMutationRequested));
}
