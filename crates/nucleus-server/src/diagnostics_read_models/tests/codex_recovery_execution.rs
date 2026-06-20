use super::*;
use crate::provider_transport_write::{
    ProviderTransportWriteAttemptId, ProviderTransportWriteIdempotencyKey,
};
use crate::{
    codex_recovery_execution_diagnostics, CodexAppServerRecoveryExecutionReceiptLink,
    CodexAppServerRecoveryExecutionReceiptLinkId, CodexAppServerRecoveryExecutionReceiptLinkStatus,
    CodexAppServerRecoveryExecutionRuntimeProgress, CodexAppServerRecoveryExecutorAdmissionId,
    CodexAppServerRecoveryExecutorAdmissionRecord, CodexAppServerRecoveryExecutorAdmissionStatus,
};

#[test]
fn recovery_execution_diagnostics_are_read_only_and_sanitized() {
    let admitted =
        admission(CodexAppServerRecoveryExecutorAdmissionStatus::AcceptedForExecutorHandoff);
    let mut blocked = admission(CodexAppServerRecoveryExecutorAdmissionStatus::Blocked);
    blocked.need_id = "need:blocked".to_owned();
    let links = vec![receipt_link(
        CodexAppServerRecoveryExecutionRuntimeProgress::Completed,
    )];

    let diagnostics = codex_recovery_execution_diagnostics(&[admitted, blocked], &links);

    assert_eq!(diagnostics.source_status, "records");
    assert_eq!(diagnostics.attempts.len(), 3);
    assert!(!diagnostics.client_can_execute_provider_write);
    assert!(!diagnostics.client_can_resume_provider);
    assert!(!diagnostics.client_can_promote_replacement_thread);
    assert!(!diagnostics.client_can_interrupt_provider);
    assert!(!diagnostics.client_can_answer_callbacks);
    assert!(!diagnostics.client_can_mutate_tasks);
    assert!(!diagnostics.client_can_accept_review);
    assert!(!diagnostics.client_can_mutate_scm);
    assert!(!diagnostics.provider_material_exposed);

    let linked = diagnostics
        .attempts
        .iter()
        .find(|attempt| attempt.runtime_progress.as_deref() == Some("completed"))
        .expect("linked attempt");
    assert_eq!(linked.status, "completed");
    assert_eq!(
        linked.next_action,
        "inspect_receipt_without_promoting_replacement_thread"
    );
    assert!(linked.provider_completion_recorded);
    assert!(linked.provider_write_recorded);
    assert!(!linked.replacement_thread_observed);
    assert!(!linked.replacement_thread_promotion_permitted);
    assert!(!linked.raw_provider_material_retained);
    assert!(!linked.raw_callback_material_retained);
}

#[test]
fn recovery_execution_diagnostics_surface_replacement_thread_repair_action() {
    let link = receipt_link(
        CodexAppServerRecoveryExecutionRuntimeProgress::ReplacementThreadObserved(
            "replacement thread observed during recovery".to_owned(),
        ),
    );

    let diagnostics = codex_recovery_execution_diagnostics(&[], &[link]);
    let attempt = diagnostics.attempts.first().expect("attempt");

    assert_eq!(attempt.status, "replacement_thread_observed");
    assert_eq!(
        attempt.runtime_progress.as_deref(),
        Some("replacement_thread_observed")
    );
    assert_eq!(
        attempt.next_action,
        "open_explicit_replacement_thread_repair"
    );
    assert!(attempt.replacement_thread_observed);
    assert!(!attempt.replacement_thread_promotion_permitted);
}

fn admission(
    status: CodexAppServerRecoveryExecutorAdmissionStatus,
) -> CodexAppServerRecoveryExecutorAdmissionRecord {
    CodexAppServerRecoveryExecutorAdmissionRecord {
        admission_id: CodexAppServerRecoveryExecutorAdmissionId(
            "codex-recovery-executor-admission:need:1:write-attempt:recovery:1".to_owned(),
        ),
        policy_id: "policy:recovery:1".to_owned(),
        need_id: "need:1".to_owned(),
        envelope_id: "envelope:1".to_owned(),
        provider_thread_id: "thread:provider:1".to_owned(),
        provider_turn_id: Some("turn:provider:1".to_owned()),
        provider_request_id: Some("request:provider:1".to_owned()),
        task_id: "task:1".to_owned(),
        work_item_id: "work:1".to_owned(),
        provider_instance_id: "codex:local-default".to_owned(),
        runtime_session_ref: "runtime-session:1".to_owned(),
        recovery_write_attempt_id: ProviderTransportWriteAttemptId(
            "write-attempt:recovery:1".to_owned(),
        ),
        idempotency_key: ProviderTransportWriteIdempotencyKey("idempotency:recovery:1".to_owned()),
        status,
        blockers: Vec::new(),
        evidence_refs: vec!["evidence:recovery:1".to_owned()],
        executor_invoked: false,
        provider_write_executed: false,
        raw_provider_material_retained: false,
        raw_callback_material_retained: false,
        task_mutation_permitted: false,
        review_acceptance_permitted: false,
        replacement_thread_promotion_permitted: false,
        interruption_permitted: false,
        callback_answer_permitted: false,
        scm_mutation_permitted: false,
    }
}

fn receipt_link(
    progress: CodexAppServerRecoveryExecutionRuntimeProgress,
) -> CodexAppServerRecoveryExecutionReceiptLink {
    let replacement_thread_observed = matches!(
        progress,
        CodexAppServerRecoveryExecutionRuntimeProgress::ReplacementThreadObserved(_)
    );

    CodexAppServerRecoveryExecutionReceiptLink {
        link_id: CodexAppServerRecoveryExecutionReceiptLinkId(
            "codex-recovery-execution-receipt-link:need:1:outcome:1".to_owned(),
        ),
        admission_id: "admission:1".to_owned(),
        policy_id: "policy:recovery:1".to_owned(),
        need_id: "need:1".to_owned(),
        envelope_id: "envelope:1".to_owned(),
        provider_thread_id: "thread:provider:1".to_owned(),
        provider_turn_id: Some("turn:provider:1".to_owned()),
        provider_request_id: Some("request:provider:1".to_owned()),
        task_id: "task:1".to_owned(),
        work_item_id: "work:1".to_owned(),
        live_executor_outcome_id: "outcome:1".to_owned(),
        runtime_receipt_id: EngineRuntimeReceiptRecordId("receipt:recovery:1".to_owned()),
        provider_instance_id: "codex:local-default".to_owned(),
        recovery_write_attempt_id: "write-attempt:recovery:1".to_owned(),
        runtime_progress: progress,
        status: CodexAppServerRecoveryExecutionReceiptLinkStatus::Linked,
        recovery_refs: vec![
            "need:need:1".to_owned(),
            "receipt:receipt:recovery:1".to_owned(),
        ],
        evidence_refs: vec!["evidence:recovery:1".to_owned()],
        provider_completion_recorded: true,
        provider_write_recorded: true,
        replacement_thread_observed,
        task_completion_permitted: false,
        review_acceptance_permitted: false,
        replacement_thread_promotion_permitted: false,
        interruption_permitted: false,
        callback_answer_permitted: false,
        scm_mutation_permitted: false,
        raw_provider_material_retained: false,
        raw_callback_material_retained: false,
    }
}
