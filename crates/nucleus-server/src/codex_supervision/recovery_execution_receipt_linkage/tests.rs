use super::*;
use crate::codex_supervision::{
    admit_codex_recovery, admit_codex_recovery_executor, codex_live_executor_outcome_record,
    codex_recovery_envelope, codex_recovery_execution_policy, codex_recovery_need_record,
    test_support::{metadata_only, runtime, session_binding, task_id, work_item_id},
    CodexAppServerLiveExecutorCleanupStatus, CodexAppServerLiveExecutorMethod,
    CodexAppServerLiveExecutorOutcomeInput, CodexAppServerRecoveryAdmissionInput,
    CodexAppServerRecoveryCapability, CodexAppServerRecoveryExecutionPolicyInput,
    CodexAppServerRecoveryExecutionToolPolicy, CodexAppServerRecoveryExecutionToolProjectionMode,
    CodexAppServerRecoveryExecutorAdmissionInput, CodexAppServerRecoverySummaryRef,
    CodexAppServerRecoveryTrigger,
};
use crate::provider_transport_write::{
    ProviderTransportWriteAttemptId, ProviderTransportWriteIdempotencyKey,
};
use crate::EngineHostId;

fn summary_ref() -> CodexAppServerRecoverySummaryRef {
    CodexAppServerRecoverySummaryRef {
        summary_ref: "recovery-summary:1".to_owned(),
        summary: "Codex process exited while a task-backed turn was active".to_owned(),
    }
}

fn admission() -> CodexAppServerRecoveryExecutorAdmissionRecord {
    let need = codex_recovery_need_record(
        &runtime(),
        &session_binding(),
        Some("turn:provider:1".to_owned()),
        Some("request:provider:1".to_owned()),
        task_id(),
        work_item_id(),
        CodexAppServerRecoveryTrigger::ProcessExit {
            exit_summary: "process exited before terminal turn event".to_owned(),
        },
        summary_ref(),
        metadata_only(),
    )
    .expect("recovery need");
    let recovery_admission = admit_codex_recovery(CodexAppServerRecoveryAdmissionInput {
        need: need.clone(),
        recovery_authority_confirmed: true,
        runtime_ready_evidence_refs: vec!["evidence:runtime-ready".to_owned()],
        provider_identity_evidence_refs: vec!["evidence:provider-thread".to_owned()],
        resume_capability: CodexAppServerRecoveryCapability::ThreadResumeSupported,
        replacement_thread_observed: false,
        raw_payload_policy_confirmed: true,
    });
    let envelope = codex_recovery_envelope(&need, &recovery_admission).expect("envelope");
    let policy = codex_recovery_execution_policy(CodexAppServerRecoveryExecutionPolicyInput {
        need,
        admission: recovery_admission,
        envelope,
        provider_instance_id: "codex:local-default".to_owned(),
        runtime_session_ref: Some("runtime-session:1".to_owned()),
        adapter_id: "codex-app-server".to_owned(),
        execution_host_id: EngineHostId("host:local".to_owned()),
        operator_evidence_ref: Some("operator-evidence:recovery:1".to_owned()),
        recovery_target_evidence_ref: Some("recovery-target-evidence:thread:1".to_owned()),
        provider_identity_evidence_ref: Some("provider-identity-evidence:thread:1".to_owned()),
        resume_capability_evidence_ref: Some("resume-capability-evidence:thread-resume".to_owned()),
        tool_policy: CodexAppServerRecoveryExecutionToolPolicy {
            projection_mode: CodexAppServerRecoveryExecutionToolProjectionMode::PortalTool,
            adapter_capability_evidence_ref: Some(
                "adapter-capability-evidence:recovery-tools".to_owned(),
            ),
            portal_tool_family: Some("Effigy".to_owned()),
            published_actions: vec!["run_selector_request".to_owned()],
            flat_tool_count: 1,
        },
        automatic_resume_requested: false,
        replacement_thread_promotion_requested: false,
        task_completion_requested: false,
        review_acceptance_requested: false,
        interruption_requested: false,
        callback_answer_requested: false,
        scm_mutation_requested: false,
        raw_provider_material_requested: false,
        raw_callback_material_requested: false,
    });

    admit_codex_recovery_executor(CodexAppServerRecoveryExecutorAdmissionInput {
        need_id: policy.need_id.clone(),
        envelope_id: policy.envelope_id.clone(),
        provider_thread_id: policy.provider_thread_id.clone(),
        provider_turn_id: policy.provider_turn_id.clone(),
        provider_request_id: policy.provider_request_id.clone(),
        task_id: policy.task_id.clone(),
        work_item_id: policy.work_item_id.clone(),
        provider_instance_id: policy.provider_instance_id.clone(),
        runtime_session_ref: policy
            .runtime_session_ref
            .clone()
            .expect("runtime session ref"),
        recovery_write_attempt_id: ProviderTransportWriteAttemptId(
            "write-attempt:recovery:1".to_owned(),
        ),
        idempotency_key: ProviderTransportWriteIdempotencyKey("idempotency:recovery:1".to_owned()),
        evidence_refs: vec!["evidence:recovery-write:1".to_owned()],
        invoke_executor_requested: false,
        raw_provider_material_requested: false,
        raw_callback_material_requested: false,
        task_mutation_requested: false,
        review_acceptance_requested: false,
        replacement_thread_promotion_requested: false,
        interruption_requested: false,
        callback_answer_requested: false,
        scm_mutation_requested: false,
        policy,
    })
}

fn outcome(
    status: CodexAppServerLiveExecutorOutcomeStatus,
) -> CodexAppServerLiveExecutorOutcomeRecord {
    codex_live_executor_outcome_record(CodexAppServerLiveExecutorOutcomeInput {
        provider_instance_id: "codex:local-default".to_owned(),
        write_attempt_id: "write-attempt:recovery:1".to_owned(),
        receipt_refs: vec!["receipt:recovery:1".to_owned()],
        thread_id: Some("thread:provider:1".to_owned()),
        turn_id: Some("turn:provider:1".to_owned()),
        final_turn_status: Some("completed".to_owned()),
        status,
        method_sequence: vec![
            CodexAppServerLiveExecutorMethod::Initialize,
            CodexAppServerLiveExecutorMethod::ThreadStart,
            CodexAppServerLiveExecutorMethod::TurnCompleted,
        ],
        notification_count: 1,
        server_request_count: 0,
        cleanup_status: CodexAppServerLiveExecutorCleanupStatus::Completed,
        evidence_refs: vec!["evidence:live-executor:1".to_owned()],
        provider_write_executed: true,
    })
}

#[test]
fn recovery_execution_receipt_link_records_completed_progress_without_task_authority() {
    let admission = admission();
    let outcome = outcome(CodexAppServerLiveExecutorOutcomeStatus::Completed);
    let link = codex_recovery_execution_receipt_link(
        &admission,
        &outcome,
        EngineRuntimeReceiptRecordId("receipt:recovery:1".to_owned()),
    );

    assert_eq!(
        link.status,
        CodexAppServerRecoveryExecutionReceiptLinkStatus::Linked
    );
    assert_eq!(
        link.runtime_progress,
        CodexAppServerRecoveryExecutionRuntimeProgress::Completed
    );
    assert!(link.provider_completion_recorded);
    assert!(link.provider_write_recorded);
    assert!(!link.replacement_thread_observed);
    assert!(!link.task_completion_permitted);
    assert!(!link.review_acceptance_permitted);
    assert!(!link.replacement_thread_promotion_permitted);
    assert!(!link.interruption_permitted);
    assert!(!link.callback_answer_permitted);
    assert!(!link.scm_mutation_permitted);
    assert!(!link.raw_provider_material_retained);
    assert!(!link.raw_callback_material_retained);
}

#[test]
fn recovery_execution_receipt_link_blocks_replacement_thread_observation() {
    let admission = admission();
    let mut outcome = outcome(CodexAppServerLiveExecutorOutcomeStatus::Completed);
    outcome.thread_id = Some("thread:replacement:1".to_owned());

    let link = codex_recovery_execution_receipt_link(
        &admission,
        &outcome,
        EngineRuntimeReceiptRecordId("receipt:recovery:1".to_owned()),
    );

    assert_eq!(
        link.runtime_progress,
        CodexAppServerRecoveryExecutionRuntimeProgress::ReplacementThreadObserved(
            "replacement thread observed during recovery".to_owned()
        )
    );
    assert!(matches!(
        link.status,
        CodexAppServerRecoveryExecutionReceiptLinkStatus::Blocked(blockers)
            if blockers.contains(
                &CodexAppServerRecoveryExecutionReceiptLinkBlocker::ReplacementThreadMismatch
            )
    ));
    assert!(link.replacement_thread_observed);
    assert!(!link.replacement_thread_promotion_permitted);
}

#[test]
fn recovery_execution_receipt_link_blocks_unaccepted_admission() {
    let mut admission = admission();
    admission.status = CodexAppServerRecoveryExecutorAdmissionStatus::Blocked;
    let outcome = outcome(CodexAppServerLiveExecutorOutcomeStatus::Completed);

    let link = codex_recovery_execution_receipt_link(
        &admission,
        &outcome,
        EngineRuntimeReceiptRecordId("receipt:recovery:1".to_owned()),
    );

    assert!(matches!(
        link.status,
        CodexAppServerRecoveryExecutionReceiptLinkStatus::Blocked(blockers)
            if blockers.contains(
                &CodexAppServerRecoveryExecutionReceiptLinkBlocker::AdmissionNotAccepted
            )
    ));
}

#[test]
fn recovery_execution_receipt_link_blocks_write_identity_mismatch() {
    let admission = admission();
    let mut outcome = outcome(CodexAppServerLiveExecutorOutcomeStatus::Completed);
    outcome.provider_instance_id = "codex:other".to_owned();
    outcome.write_attempt_id = "write-attempt:other".to_owned();

    let link = codex_recovery_execution_receipt_link(
        &admission,
        &outcome,
        EngineRuntimeReceiptRecordId("receipt:recovery:1".to_owned()),
    );

    assert!(matches!(
        link.status,
        CodexAppServerRecoveryExecutionReceiptLinkStatus::Blocked(blockers)
            if blockers.contains(
                &CodexAppServerRecoveryExecutionReceiptLinkBlocker::ProviderInstanceMismatch
            ) && blockers.contains(
                &CodexAppServerRecoveryExecutionReceiptLinkBlocker::WriteAttemptMismatch
            )
    ));
}
