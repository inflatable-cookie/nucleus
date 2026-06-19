use super::*;

fn completed_input() -> CodexAppServerLiveExecutorOutcomeInput {
    CodexAppServerLiveExecutorOutcomeInput {
        provider_instance_id: "codex:local-default".to_owned(),
        write_attempt_id: "provider-transport-write:codex-live-smoke".to_owned(),
        receipt_refs: vec![
            "receipt:codex-live-smoke:turn-start".to_owned(),
            "receipt:codex-live-smoke:turn-completed".to_owned(),
        ],
        thread_id: Some("thread:codex-smoke".to_owned()),
        turn_id: Some("turn:codex-smoke".to_owned()),
        final_turn_status: Some("completed".to_owned()),
        status: CodexAppServerLiveExecutorOutcomeStatus::Completed,
        method_sequence: vec![
            CodexAppServerLiveExecutorMethod::Initialize,
            CodexAppServerLiveExecutorMethod::InitializedNotification,
            CodexAppServerLiveExecutorMethod::ThreadStart,
            CodexAppServerLiveExecutorMethod::TurnStart,
            CodexAppServerLiveExecutorMethod::TurnCompleted,
            CodexAppServerLiveExecutorMethod::Cleanup,
        ],
        notification_count: 1,
        server_request_count: 0,
        cleanup_status: CodexAppServerLiveExecutorCleanupStatus::Completed,
        evidence_refs: vec!["docs/logs/2026-06-19-codex-live-smoke-evidence.md".to_owned()],
        provider_write_executed: true,
    }
}

#[test]
fn completed_live_executor_outcome_preserves_smoke_identity() {
    let record = codex_live_executor_outcome_record(completed_input());

    validate_codex_live_executor_outcome_record(&record).expect("valid outcome");

    assert_eq!(
        record.transport_kind,
        CodexAppServerLiveExecutorTransportKind::Stdio
    );
    assert_eq!(record.thread_id.as_deref(), Some("thread:codex-smoke"));
    assert_eq!(record.turn_id.as_deref(), Some("turn:codex-smoke"));
    assert_eq!(record.final_turn_status.as_deref(), Some("completed"));
    assert_eq!(record.notification_count, 1);
    assert_eq!(record.server_request_count, 0);
    assert!(record.provider_write_executed);
    assert!(!record.raw_payload_retained);
    assert!(!record.raw_stream_retained);
    assert!(!record.task_mutation_permitted);
    assert!(!record.callback_response_permitted);
    assert!(!record.cancellation_permitted);
    assert!(!record.resume_permitted);
}

#[test]
fn blocked_live_executor_outcome_can_exist_without_thread_or_turn() {
    let record = codex_live_executor_outcome_record(CodexAppServerLiveExecutorOutcomeInput {
        provider_instance_id: "codex:local-default".to_owned(),
        write_attempt_id: "provider-transport-write:codex-live-smoke".to_owned(),
        receipt_refs: vec!["receipt:codex-live-smoke:blocked".to_owned()],
        thread_id: None,
        turn_id: None,
        final_turn_status: None,
        status: CodexAppServerLiveExecutorOutcomeStatus::Blocked(
            "operator confirmation missing".to_owned(),
        ),
        method_sequence: vec![CodexAppServerLiveExecutorMethod::Initialize],
        notification_count: 0,
        server_request_count: 0,
        cleanup_status: CodexAppServerLiveExecutorCleanupStatus::NotRequired,
        evidence_refs: vec!["evidence:operator-policy".to_owned()],
        provider_write_executed: false,
    });

    validate_codex_live_executor_outcome_record(&record).expect("blocked outcome is valid");
    assert!(!record.provider_write_executed);
}

#[test]
fn completed_live_executor_outcome_requires_terminal_identity() {
    let mut record = codex_live_executor_outcome_record(completed_input());
    record.thread_id = None;
    record.turn_id = None;
    record.final_turn_status = None;
    record.provider_write_executed = false;
    record
        .method_sequence
        .retain(|method| method != &CodexAppServerLiveExecutorMethod::TurnCompleted);

    let errors = validate_codex_live_executor_outcome_record(&record).expect_err("invalid");

    assert!(errors.contains(&CodexAppServerLiveExecutorOutcomeValidationError::MissingThreadId));
    assert!(errors.contains(&CodexAppServerLiveExecutorOutcomeValidationError::MissingTurnId));
    assert!(
        errors.contains(&CodexAppServerLiveExecutorOutcomeValidationError::MissingFinalTurnStatus)
    );
    assert!(errors.contains(
        &CodexAppServerLiveExecutorOutcomeValidationError::CompletedWithoutProviderWrite
    ));
    assert!(errors.contains(
        &CodexAppServerLiveExecutorOutcomeValidationError::CompletedWithoutRequiredMethod(
            CodexAppServerLiveExecutorMethod::TurnCompleted,
        )
    ));
}

#[test]
fn live_executor_outcome_rejects_raw_material_and_extra_authority() {
    let mut record = codex_live_executor_outcome_record(completed_input());
    record.raw_payload_retained = true;
    record.raw_stream_retained = true;
    record.task_mutation_permitted = true;
    record.callback_response_permitted = true;
    record.cancellation_permitted = true;
    record.resume_permitted = true;

    let errors = validate_codex_live_executor_outcome_record(&record).expect_err("invalid");

    assert!(errors.contains(&CodexAppServerLiveExecutorOutcomeValidationError::RawPayloadRetained));
    assert!(errors.contains(&CodexAppServerLiveExecutorOutcomeValidationError::RawStreamRetained));
    assert!(
        errors.contains(&CodexAppServerLiveExecutorOutcomeValidationError::TaskMutationPermitted)
    );
    assert!(errors
        .contains(&CodexAppServerLiveExecutorOutcomeValidationError::CallbackResponsePermitted));
    assert!(
        errors.contains(&CodexAppServerLiveExecutorOutcomeValidationError::CancellationPermitted)
    );
    assert!(errors.contains(&CodexAppServerLiveExecutorOutcomeValidationError::ResumePermitted));
}

#[test]
fn live_executor_outcome_requires_refs_and_method_sequence() {
    let mut record = codex_live_executor_outcome_record(completed_input());
    record.provider_instance_id.clear();
    record.write_attempt_id.clear();
    record.receipt_refs.clear();
    record.evidence_refs.clear();
    record.method_sequence.clear();

    let errors = validate_codex_live_executor_outcome_record(&record).expect_err("invalid");

    assert!(errors
        .contains(&CodexAppServerLiveExecutorOutcomeValidationError::MissingProviderInstanceId));
    assert!(
        errors.contains(&CodexAppServerLiveExecutorOutcomeValidationError::MissingWriteAttemptId)
    );
    assert!(errors.contains(&CodexAppServerLiveExecutorOutcomeValidationError::MissingReceiptRef));
    assert!(errors.contains(&CodexAppServerLiveExecutorOutcomeValidationError::MissingEvidenceRef));
    assert!(
        errors.contains(&CodexAppServerLiveExecutorOutcomeValidationError::MissingMethodSequence)
    );
}
