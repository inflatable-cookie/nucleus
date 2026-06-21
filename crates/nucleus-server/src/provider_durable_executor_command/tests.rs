use super::*;

fn input() -> DurableProviderExecutorCommandInput {
    DurableProviderExecutorCommandInput {
        command_id: DurableProviderExecutorCommandId(
            "durable-provider-executor-command:1".to_owned(),
        ),
        lane: DurableProviderExecutorLane::TaskBackedTurnStart,
        lane_admission_id: "task-work-live-executor-admission:1".to_owned(),
        provider_instance_id: "codex:local-default".to_owned(),
        runtime_session_ref: "runtime-session:1".to_owned(),
        write_attempt_id: "provider-transport-write:task-work:1".to_owned(),
        idempotency_key: "idempotency:task-work:1".to_owned(),
        task_id: Some("task:1".to_owned()),
        work_item_id: Some("work:1".to_owned()),
        method: DurableProviderExecutorMethod::TurnStart,
        evidence_refs: vec![
            "evidence:policy:1".to_owned(),
            "evidence:operator-confirmation:1".to_owned(),
        ],
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
    }
}

#[test]
fn durable_provider_executor_command_accepts_intent_without_execution() {
    let record = durable_provider_executor_command(input());

    assert_eq!(
        record.status,
        DurableProviderExecutorCommandStatus::AcceptedForPersistence
    );
    assert!(record.blockers.is_empty());
    assert_eq!(record.method, DurableProviderExecutorMethod::TurnStart);
    assert_eq!(record.task_id.as_deref(), Some("task:1"));
    assert_eq!(record.work_item_id.as_deref(), Some("work:1"));
    assert!(!record.executor_invoked);
    assert!(!record.provider_write_executed);
    assert!(!record.client_authority_granted);
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
fn durable_provider_executor_command_blocks_missing_identity() {
    let mut input = input();
    input.command_id = DurableProviderExecutorCommandId(String::new());
    input.lane_admission_id.clear();
    input.provider_instance_id.clear();
    input.runtime_session_ref.clear();
    input.write_attempt_id.clear();
    input.idempotency_key.clear();
    input.task_id = None;
    input.work_item_id = Some(String::new());
    input.evidence_refs = vec![String::new()];
    input.operator_confirmation_ref = None;

    let record = durable_provider_executor_command(input);

    assert_eq!(record.status, DurableProviderExecutorCommandStatus::Blocked);
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorCommandBlocker::MissingCommandId));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorCommandBlocker::MissingLaneAdmissionId));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorCommandBlocker::MissingProviderInstanceId));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorCommandBlocker::MissingRuntimeSessionRef));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorCommandBlocker::MissingWriteAttemptId));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorCommandBlocker::MissingIdempotencyKey));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorCommandBlocker::MissingTaskId));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorCommandBlocker::MissingWorkItemId));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorCommandBlocker::MissingEvidenceRef));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorCommandBlocker::MissingOperatorConfirmation));
}

#[test]
fn durable_provider_executor_command_blocks_lane_method_mismatch() {
    let mut input = input();
    input.method = DurableProviderExecutorMethod::ThreadResume;

    let record = durable_provider_executor_command(input);

    assert_eq!(
        record.blockers,
        vec![DurableProviderExecutorCommandBlocker::LaneMethodMismatch]
    );
}

#[test]
fn durable_provider_executor_command_blocks_authority_widening() {
    let mut input = input();
    input.client_authority_requested = true;
    input.invoke_executor_requested = true;
    input.raw_provider_material_requested = true;
    input.raw_callback_material_requested = true;
    input.task_mutation_requested = true;
    input.review_acceptance_requested = true;
    input.callback_answer_requested = true;
    input.interruption_requested = true;
    input.recovery_requested = true;
    input.replacement_thread_promotion_requested = true;
    input.scm_mutation_requested = true;

    let record = durable_provider_executor_command(input);

    assert_eq!(record.status, DurableProviderExecutorCommandStatus::Blocked);
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorCommandBlocker::ClientAuthorityRequested));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorCommandBlocker::ExecutorInvocationRequested));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorCommandBlocker::RawProviderMaterialRequested));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorCommandBlocker::RawCallbackMaterialRequested));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorCommandBlocker::TaskMutationRequested));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorCommandBlocker::ReviewAcceptanceRequested));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorCommandBlocker::CallbackAnswerRequested));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorCommandBlocker::InterruptionRequested));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorCommandBlocker::RecoveryRequested));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorCommandBlocker::ReplacementThreadPromotionRequested));
    assert!(record
        .blockers
        .contains(&DurableProviderExecutorCommandBlocker::ScmMutationRequested));
}
