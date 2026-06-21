use super::*;
use crate::{
    durable_provider_executor_command, durable_provider_executor_dispatch_admission,
    durable_provider_executor_dispatch_selection, DurableProviderExecutorCommandId,
    DurableProviderExecutorCommandInput, DurableProviderExecutorDispatchAdmissionInput,
    DurableProviderExecutorDispatchAdmissionRecord, DurableProviderExecutorDispatchAdmissionStatus,
    DurableProviderExecutorDispatchSelectionInput, DurableProviderExecutorLane,
    DurableProviderExecutorMethod,
};

fn admission() -> DurableProviderExecutorDispatchAdmissionRecord {
    durable_provider_executor_dispatch_admission(DurableProviderExecutorDispatchAdmissionInput {
        selection: durable_provider_executor_dispatch_selection(
            DurableProviderExecutorDispatchSelectionInput {
                command: durable_provider_executor_command(DurableProviderExecutorCommandInput {
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
                }),
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

fn input() -> DurableDispatchInvocationPreflightInput {
    DurableDispatchInvocationPreflightInput {
        admission: admission(),
        operator_confirmation_ref: Some("operator-confirmation:invoke:1".to_owned()),
        provider_ready_evidence_refs: vec!["evidence:provider-ready:invoke:1".to_owned()],
        runtime_session_evidence_refs: vec!["evidence:runtime-session:invoke:1".to_owned()],
        invocation_evidence_refs: vec!["evidence:invocation:1".to_owned()],
        supported_methods: vec![DurableProviderExecutorMethod::TurnStart],
        in_flight_invocation_attempt_ids: Vec::new(),
        stale_admission_evidence: false,
        write_attempt_id: "provider-transport-write:1".to_owned(),
        idempotency_key: "idempotency:1".to_owned(),
        executor_invocation_requested: false,
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

#[test]
fn durable_dispatch_invocation_preflight_accepts_admission_without_execution() {
    let record = durable_dispatch_invocation_preflight(input());

    assert_eq!(
        record.status,
        DurableDispatchInvocationPreflightStatus::AcceptedForInvocationRequest
    );
    assert!(record.blockers.is_empty());
    assert_eq!(record.command_id, "durable-provider-executor-command:1");
    assert_eq!(record.dispatch_attempt_id, "dispatch-attempt:1");
    assert_eq!(record.method, DurableProviderExecutorMethod::TurnStart);
    assert!(!record.executor_invoked);
    assert!(!record.provider_write_executed);
    assert!(!record.client_authority_granted);
    assert!(!record.task_mutation_permitted);
}

#[test]
fn durable_dispatch_invocation_preflight_blocks_missing_evidence_and_identity_mismatch() {
    let mut input = input();
    input.operator_confirmation_ref = None;
    input.provider_ready_evidence_refs.clear();
    input.runtime_session_evidence_refs = vec![String::new()];
    input.invocation_evidence_refs.clear();
    input.supported_methods.clear();
    input
        .in_flight_invocation_attempt_ids
        .push("dispatch-attempt:1".to_owned());
    input.stale_admission_evidence = true;
    input.write_attempt_id = "provider-transport-write:other".to_owned();
    input.idempotency_key = "idempotency:other".to_owned();

    let record = durable_dispatch_invocation_preflight(input);

    assert_eq!(
        record.status,
        DurableDispatchInvocationPreflightStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&DurableDispatchInvocationPreflightBlocker::MissingOperatorConfirmation));
    assert!(record
        .blockers
        .contains(&DurableDispatchInvocationPreflightBlocker::MissingProviderReadyEvidence));
    assert!(record
        .blockers
        .contains(&DurableDispatchInvocationPreflightBlocker::MissingRuntimeSessionEvidence));
    assert!(record
        .blockers
        .contains(&DurableDispatchInvocationPreflightBlocker::MissingInvocationEvidence));
    assert!(record
        .blockers
        .contains(&DurableDispatchInvocationPreflightBlocker::UnsupportedProviderMethod));
    assert!(record
        .blockers
        .contains(&DurableDispatchInvocationPreflightBlocker::DuplicateInFlightInvocationAttempt));
    assert!(record
        .blockers
        .contains(&DurableDispatchInvocationPreflightBlocker::StaleAdmissionEvidence));
    assert!(record
        .blockers
        .contains(&DurableDispatchInvocationPreflightBlocker::WriteAttemptMismatch));
    assert!(record
        .blockers
        .contains(&DurableDispatchInvocationPreflightBlocker::IdempotencyMismatch));
}

#[test]
fn durable_dispatch_invocation_preflight_blocks_authority_widening() {
    let mut input = input();
    input.executor_invocation_requested = true;
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

    let record = durable_dispatch_invocation_preflight(input);

    assert!(record
        .blockers
        .contains(&DurableDispatchInvocationPreflightBlocker::ExecutorInvocationRequested));
    assert!(record
        .blockers
        .contains(&DurableDispatchInvocationPreflightBlocker::BackgroundExecutionRequested));
    assert!(record
        .blockers
        .contains(&DurableDispatchInvocationPreflightBlocker::ProviderWriteRequested));
    assert!(record
        .blockers
        .contains(&DurableDispatchInvocationPreflightBlocker::TaskMutationRequested));
    assert!(record
        .blockers
        .contains(&DurableDispatchInvocationPreflightBlocker::ScmMutationRequested));
}

#[test]
fn durable_dispatch_invocation_preflight_blocks_non_accepted_admission() {
    let mut input = input();
    input.admission.status = DurableProviderExecutorDispatchAdmissionStatus::Blocked;

    let record = durable_dispatch_invocation_preflight(input);

    assert!(record
        .blockers
        .contains(&DurableDispatchInvocationPreflightBlocker::AdmissionNotAccepted));
}
