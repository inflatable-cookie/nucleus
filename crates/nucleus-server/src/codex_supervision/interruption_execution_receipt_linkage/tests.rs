use super::*;
use crate::codex_supervision::{
    admit_codex_interruption, admit_codex_interruption_executor, codex_interruption_envelope,
    codex_interruption_execution_policy, codex_interruption_request,
    codex_live_executor_outcome_record, CodexAppServerInterruptionAdmissionInput,
    CodexAppServerInterruptionExecutionPolicyInput, CodexAppServerInterruptionExecutionToolPolicy,
    CodexAppServerInterruptionExecutionToolProjectionMode,
    CodexAppServerInterruptionExecutorAdmissionInput, CodexAppServerInterruptionReasonRef,
    CodexAppServerInterruptionReasonRetentionPolicy, CodexAppServerInterruptionRequestRef,
    CodexAppServerInterruptionTarget, CodexAppServerInterruptionTargetState,
    CodexAppServerLiveExecutorCleanupStatus, CodexAppServerLiveExecutorMethod,
    CodexAppServerLiveExecutorOutcomeInput, CodexAppServerPayloadRetentionPolicy,
};
use crate::host_authority::EngineHostId;
use crate::provider_transport_write::{
    ProviderTransportWriteAttemptId, ProviderTransportWriteIdempotencyKey,
};
use nucleus_agent_protocol::AgentSessionId;
use nucleus_engine::{EngineRuntimeReceiptRecordId, EngineTaskWorkItemId};
use nucleus_tasks::TaskId;

#[test]
fn interruption_receipt_linkage_preserves_completed_outcome_without_review_acceptance() {
    let link = codex_interruption_execution_receipt_link(
        &accepted_admission(),
        &outcome(
            CodexAppServerLiveExecutorOutcomeStatus::Completed,
            "provider-transport-write:interruption:1",
        ),
        receipt_id(),
    );

    assert_eq!(
        link.status,
        CodexAppServerInterruptionExecutionReceiptLinkStatus::Linked
    );
    assert_eq!(
        link.runtime_progress,
        CodexAppServerInterruptionExecutionRuntimeProgress::Completed
    );
    assert!(link.provider_completion_recorded);
    assert!(link.provider_write_recorded);
    assert!(!link.task_completion_permitted);
    assert!(!link.review_acceptance_permitted);
    assert!(!link.resume_permitted);
    assert!(!link.callback_answer_permitted);
    assert!(!link.scm_mutation_permitted);
    assert!(!link.raw_provider_material_retained);
    assert!(!link.raw_callback_material_retained);
    assert!(link.interruption_refs.contains(
        &"receipt:receipt:codex-interruption:provider-transport-write:interruption:1".to_owned()
    ));
    assert!(link
        .interruption_refs
        .iter()
        .all(|value| !value.contains("raw_provider") && !value.contains("stdout")));
}

#[test]
fn interruption_receipt_linkage_keeps_failed_outcome_inspectable() {
    let link = codex_interruption_execution_receipt_link(
        &accepted_admission(),
        &outcome(
            CodexAppServerLiveExecutorOutcomeStatus::Failed("provider error".to_owned()),
            "provider-transport-write:interruption:1",
        ),
        receipt_id(),
    );

    assert_eq!(
        link.runtime_progress,
        CodexAppServerInterruptionExecutionRuntimeProgress::Failed("provider error".to_owned())
    );
    assert_eq!(
        link.status,
        CodexAppServerInterruptionExecutionReceiptLinkStatus::Linked
    );
    assert!(!link.provider_completion_recorded);
    assert!(!link.task_completion_permitted);
}

#[test]
fn interruption_receipt_linkage_keeps_timed_out_outcome_inspectable() {
    let link = codex_interruption_execution_receipt_link(
        &accepted_admission(),
        &outcome(
            CodexAppServerLiveExecutorOutcomeStatus::TimedOut,
            "provider-transport-write:interruption:1",
        ),
        receipt_id(),
    );

    assert_eq!(
        link.runtime_progress,
        CodexAppServerInterruptionExecutionRuntimeProgress::TimedOut
    );
    assert_eq!(
        link.status,
        CodexAppServerInterruptionExecutionReceiptLinkStatus::Linked
    );
    assert!(!link.review_acceptance_permitted);
}

#[test]
fn interruption_receipt_linkage_keeps_blocked_outcome_inspectable() {
    let link = codex_interruption_execution_receipt_link(
        &accepted_admission(),
        &outcome(
            CodexAppServerLiveExecutorOutcomeStatus::Blocked("interrupt gate blocked".to_owned()),
            "provider-transport-write:interruption:1",
        ),
        receipt_id(),
    );

    assert_eq!(
        link.runtime_progress,
        CodexAppServerInterruptionExecutionRuntimeProgress::Blocked(
            "interrupt gate blocked".to_owned()
        )
    );
    assert_eq!(
        link.status,
        CodexAppServerInterruptionExecutionReceiptLinkStatus::Linked
    );
    assert!(link
        .evidence_refs
        .contains(&"interruption-executor-evidence:1".to_owned()));
}

#[test]
fn interruption_receipt_linkage_keeps_cleanup_required_outcome_inspectable() {
    let link = codex_interruption_execution_receipt_link(
        &accepted_admission(),
        &outcome(
            CodexAppServerLiveExecutorOutcomeStatus::CleanupRequired(
                "process still running".to_owned(),
            ),
            "provider-transport-write:interruption:1",
        ),
        receipt_id(),
    );

    assert_eq!(
        link.runtime_progress,
        CodexAppServerInterruptionExecutionRuntimeProgress::CleanupRequired(
            "process still running".to_owned()
        )
    );
    assert_eq!(
        link.status,
        CodexAppServerInterruptionExecutionReceiptLinkStatus::Linked
    );
    assert!(!link.raw_provider_material_retained);
}

#[test]
fn interruption_receipt_linkage_blocks_mismatched_or_unsafe_records() {
    let mut admission = accepted_admission();
    admission.provider_instance_id = "codex:other".to_owned();
    admission.raw_provider_material_retained = true;
    admission.raw_callback_material_retained = true;
    admission.review_acceptance_permitted = true;
    admission.resume_permitted = true;
    admission.scm_mutation_permitted = true;
    let mut unsafe_outcome = outcome(
        CodexAppServerLiveExecutorOutcomeStatus::Completed,
        "provider-transport-write:interruption:other",
    );
    unsafe_outcome.raw_payload_retained = true;
    unsafe_outcome.task_mutation_permitted = true;

    let link = codex_interruption_execution_receipt_link(
        &admission,
        &unsafe_outcome,
        EngineRuntimeReceiptRecordId(String::new()),
    );

    assert_eq!(
        link.status,
        CodexAppServerInterruptionExecutionReceiptLinkStatus::Blocked(vec![
            CodexAppServerInterruptionExecutionReceiptLinkBlocker::MissingRuntimeReceiptId,
            CodexAppServerInterruptionExecutionReceiptLinkBlocker::ProviderInstanceMismatch,
            CodexAppServerInterruptionExecutionReceiptLinkBlocker::WriteAttemptMismatch,
            CodexAppServerInterruptionExecutionReceiptLinkBlocker::OutcomeRetainedRawPayload,
            CodexAppServerInterruptionExecutionReceiptLinkBlocker::OutcomePermitsTaskMutation,
            CodexAppServerInterruptionExecutionReceiptLinkBlocker::AdmissionRetainedRawProviderMaterial,
            CodexAppServerInterruptionExecutionReceiptLinkBlocker::AdmissionRetainedRawCallbackMaterial,
            CodexAppServerInterruptionExecutionReceiptLinkBlocker::AdmissionPermitsReviewAcceptance,
            CodexAppServerInterruptionExecutionReceiptLinkBlocker::AdmissionPermitsResume,
            CodexAppServerInterruptionExecutionReceiptLinkBlocker::AdmissionPermitsScmMutation,
        ])
    );
    assert!(!link.task_completion_permitted);
    assert!(!link.review_acceptance_permitted);
}

fn accepted_admission() -> CodexAppServerInterruptionExecutorAdmissionRecord {
    let policy = accepted_policy();
    admit_codex_interruption_executor(CodexAppServerInterruptionExecutorAdmissionInput {
        request_id: policy.request_id.clone(),
        envelope_id: policy.envelope_id.clone(),
        provider_turn_id: policy.provider_turn_id.clone(),
        provider_request_id: policy.provider_request_id.clone(),
        task_id: policy.task_id.clone(),
        work_item_id: policy.work_item_id.clone(),
        provider_instance_id: policy.provider_instance_id.clone(),
        runtime_session_ref: policy.runtime_session_ref.clone().expect("runtime session"),
        interruption_write_attempt_id: ProviderTransportWriteAttemptId(
            "provider-transport-write:interruption:1".to_owned(),
        ),
        idempotency_key: ProviderTransportWriteIdempotencyKey(
            "codex-interruption:turn:provider:1".to_owned(),
        ),
        evidence_refs: vec!["interruption-executor-admission-evidence:1".to_owned()],
        invoke_executor_requested: false,
        raw_provider_material_requested: false,
        raw_callback_material_requested: false,
        task_mutation_requested: false,
        review_acceptance_requested: false,
        resume_requested: false,
        callback_answer_requested: false,
        scm_mutation_requested: false,
        policy,
    })
}

fn accepted_policy() -> crate::CodexAppServerInterruptionExecutionPolicyRecord {
    let request = codex_interruption_request(
        &crate::codex_supervision::test_support::runtime(),
        CodexAppServerInterruptionRequestRef("interrupt:1".to_owned()),
        AgentSessionId("session:1".to_owned()),
        CodexAppServerInterruptionTarget::ActiveTurn {
            provider_turn_id: "turn:provider:1".to_owned(),
            provider_request_id: Some("request:provider:1".to_owned()),
        },
        TaskId("task:1".to_owned()),
        EngineTaskWorkItemId("work:1".to_owned()),
        CodexAppServerInterruptionReasonRef {
            reason_ref: "interruption-reason:1".to_owned(),
            summary: "operator stopped the active turn".to_owned(),
            retention: CodexAppServerInterruptionReasonRetentionPolicy::SummaryAndRefOnly,
        },
        CodexAppServerPayloadRetentionPolicy::MetadataOnly,
    )
    .expect("interruption request");
    let admission = admit_codex_interruption(CodexAppServerInterruptionAdmissionInput {
        request: request.clone(),
        interruption_authority_confirmed: true,
        runtime_ready_evidence_refs: vec!["runtime-ready-evidence:1".to_owned()],
        target_state: CodexAppServerInterruptionTargetState::Interruptible,
        duplicate_or_in_flight: false,
        raw_payload_policy_confirmed: true,
    });
    let envelope = codex_interruption_envelope(&request, &admission).expect("envelope");

    codex_interruption_execution_policy(CodexAppServerInterruptionExecutionPolicyInput {
        request,
        admission,
        envelope,
        provider_instance_id: "codex:local-default".to_owned(),
        runtime_session_ref: Some("runtime-session:1".to_owned()),
        adapter_id: "codex-app-server".to_owned(),
        execution_host_id: EngineHostId("host:local".to_owned()),
        operator_evidence_ref: Some("operator-evidence:interrupt:1".to_owned()),
        target_evidence_ref: Some("target-evidence:active-turn:1".to_owned()),
        interruption_capability_evidence_ref: Some(
            "interruption-capability-evidence:turn-interrupt".to_owned(),
        ),
        tool_policy: CodexAppServerInterruptionExecutionToolPolicy {
            projection_mode: CodexAppServerInterruptionExecutionToolProjectionMode::PortalTool,
            adapter_capability_evidence_ref: Some(
                "adapter-capability-evidence:interruption-tools".to_owned(),
            ),
            portal_tool_family: Some("Effigy".to_owned()),
            published_actions: vec!["run_selector_request".to_owned()],
            flat_tool_count: 1,
        },
        automatic_interruption_requested: false,
        task_completion_requested: false,
        review_acceptance_requested: false,
        resume_requested: false,
        callback_answer_requested: false,
        scm_mutation_requested: false,
        raw_provider_material_requested: false,
        raw_callback_material_requested: false,
    })
}

fn outcome(
    status: CodexAppServerLiveExecutorOutcomeStatus,
    write_attempt_id: &str,
) -> CodexAppServerLiveExecutorOutcomeRecord {
    codex_live_executor_outcome_record(CodexAppServerLiveExecutorOutcomeInput {
        provider_instance_id: "codex:local-default".to_owned(),
        write_attempt_id: write_attempt_id.to_owned(),
        receipt_refs: vec!["provider-receipt:interruption:1".to_owned()],
        thread_id: Some("thread:1".to_owned()),
        turn_id: Some("turn:1".to_owned()),
        final_turn_status: Some("interrupted".to_owned()),
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
        server_request_count: 1,
        cleanup_status: CodexAppServerLiveExecutorCleanupStatus::Completed,
        evidence_refs: vec!["interruption-executor-evidence:1".to_owned()],
        provider_write_executed: true,
    })
}

fn receipt_id() -> EngineRuntimeReceiptRecordId {
    EngineRuntimeReceiptRecordId(
        "receipt:codex-interruption:provider-transport-write:interruption:1".to_owned(),
    )
}
