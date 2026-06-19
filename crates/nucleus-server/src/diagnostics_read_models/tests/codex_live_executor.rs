use crate::{
    codex_live_executor_diagnostics, codex_live_executor_outcome_record,
    CodexAppServerLiveExecutorCleanupStatus, CodexAppServerLiveExecutorMethod,
    CodexAppServerLiveExecutorOutcomeInput, CodexAppServerLiveExecutorOutcomeStatus,
};

#[test]
fn codex_live_executor_diagnostics_are_read_only_and_sanitized() {
    let diagnostics = codex_live_executor_diagnostics(&[
        outcome(
            "completed",
            CodexAppServerLiveExecutorOutcomeStatus::Completed,
            true,
        ),
        outcome(
            "failed",
            CodexAppServerLiveExecutorOutcomeStatus::Failed("provider exited".to_owned()),
            true,
        ),
        outcome(
            "timeout",
            CodexAppServerLiveExecutorOutcomeStatus::TimedOut,
            true,
        ),
    ]);
    let json = serde_json::to_string(&diagnostics).expect("serialize diagnostics");

    assert_eq!(diagnostics.source_status, "records");
    assert_eq!(diagnostics.attempts.len(), 3);
    assert_eq!(diagnostics.attempts[0].status, "completed");
    assert_eq!(
        diagnostics.attempts[0].next_action,
        "inspect_receipt_and_evidence"
    );
    assert_eq!(diagnostics.attempts[1].status, "failed");
    assert_eq!(
        diagnostics.attempts[1].next_action,
        "inspect_failure_evidence"
    );
    assert_eq!(diagnostics.attempts[2].status, "timed_out");
    assert_eq!(
        diagnostics.attempts[2].next_action,
        "review_timeout_and_cleanup"
    );
    assert!(!diagnostics.client_can_execute_provider_write);
    assert!(!diagnostics.client_can_answer_callbacks);
    assert!(!diagnostics.client_can_cancel_provider);
    assert!(!diagnostics.client_can_resume_provider);
    assert!(!diagnostics.client_can_mutate_tasks);
    assert!(!diagnostics.provider_material_exposed);
    assert!(!diagnostics.stream_material_exposed);

    for forbidden in [
        "raw_prompt",
        "raw_response",
        "raw_frame",
        "stdout",
        "stderr",
        "stream_delta",
        "credential",
        "secret",
        "provider_payload",
    ] {
        assert!(
            !json.contains(forbidden),
            "live executor diagnostics leaked {forbidden}"
        );
    }
}

fn outcome(
    suffix: &str,
    status: CodexAppServerLiveExecutorOutcomeStatus,
    provider_write_executed: bool,
) -> crate::CodexAppServerLiveExecutorOutcomeRecord {
    codex_live_executor_outcome_record(CodexAppServerLiveExecutorOutcomeInput {
        provider_instance_id: "codex:local-default".to_owned(),
        write_attempt_id: format!("provider-transport-write:codex-live-{suffix}"),
        receipt_refs: vec![format!("receipt:codex-live-{suffix}")],
        thread_id: Some(format!("thread:codex-live-{suffix}")),
        turn_id: Some(format!("turn:codex-live-{suffix}")),
        final_turn_status: Some(status_label(&status)),
        status,
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
        evidence_refs: vec![format!("evidence:codex-live-{suffix}")],
        provider_write_executed,
    })
}

fn status_label(status: &CodexAppServerLiveExecutorOutcomeStatus) -> String {
    match status {
        CodexAppServerLiveExecutorOutcomeStatus::Completed => "completed",
        CodexAppServerLiveExecutorOutcomeStatus::Failed(_) => "failed",
        CodexAppServerLiveExecutorOutcomeStatus::TimedOut => "timed_out",
        CodexAppServerLiveExecutorOutcomeStatus::Accepted => "accepted",
        CodexAppServerLiveExecutorOutcomeStatus::Blocked(_) => "blocked",
        CodexAppServerLiveExecutorOutcomeStatus::CleanupRequired(_) => "cleanup_required",
    }
    .to_owned()
}
