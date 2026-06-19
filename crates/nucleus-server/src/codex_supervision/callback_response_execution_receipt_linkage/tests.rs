use super::*;
use crate::codex_supervision::{
    admit_codex_callback_response, admit_codex_callback_response_executor, codex_callback_request,
    codex_callback_response_envelope, codex_callback_response_execution_policy,
    codex_live_executor_outcome_record, CodexAppServerCallbackPromptRef,
    CodexAppServerCallbackPromptRetentionPolicy, CodexAppServerCallbackRequestKind,
    CodexAppServerCallbackResponse, CodexAppServerCallbackResponseAdmissionInput,
    CodexAppServerCallbackResponseExecutionPolicyInput,
    CodexAppServerCallbackResponseExecutionToolPolicy,
    CodexAppServerCallbackResponseExecutionToolProjectionMode,
    CodexAppServerCallbackResponseExecutorAdmissionInput, CodexAppServerLiveExecutorCleanupStatus,
    CodexAppServerLiveExecutorMethod, CodexAppServerLiveExecutorOutcomeInput,
    CodexAppServerPayloadRetentionPolicy, CodexAppServerProviderCallbackId,
};
use crate::host_authority::EngineHostId;
use crate::provider_transport_write::{
    ProviderTransportWriteAttemptId, ProviderTransportWriteIdempotencyKey,
};
use nucleus_agent_protocol::{AgentSessionId, ApprovalScope};
use nucleus_engine::{EngineRuntimeReceiptRecordId, EngineTaskWorkItemId};
use nucleus_tasks::TaskId;

#[test]
fn callback_response_receipt_linkage_preserves_completed_outcome_without_review_acceptance() {
    let link = codex_callback_response_execution_receipt_link(
        &accepted_admission(),
        &outcome(
            CodexAppServerLiveExecutorOutcomeStatus::Completed,
            "provider-transport-write:callback-response:1",
        ),
        receipt_id(),
    );

    assert_eq!(
        link.status,
        CodexAppServerCallbackResponseExecutionReceiptLinkStatus::Linked
    );
    assert_eq!(
        link.runtime_progress,
        CodexAppServerCallbackResponseExecutionRuntimeProgress::Completed
    );
    assert!(link.provider_completion_recorded);
    assert!(link.provider_write_recorded);
    assert!(!link.task_completion_permitted);
    assert!(!link.review_acceptance_permitted);
    assert!(!link.raw_callback_material_retained);
    assert!(link.callback_refs.contains(
        &"receipt:receipt:codex-callback-response:provider-transport-write:callback-response:1"
            .to_owned()
    ));
    assert!(link
        .callback_refs
        .iter()
        .all(|value| { !value.contains("raw_provider") && !value.contains("selected_option") }));
}

#[test]
fn callback_response_receipt_linkage_keeps_failed_outcome_inspectable() {
    let link = codex_callback_response_execution_receipt_link(
        &accepted_admission(),
        &outcome(
            CodexAppServerLiveExecutorOutcomeStatus::Failed("provider error".to_owned()),
            "provider-transport-write:callback-response:1",
        ),
        receipt_id(),
    );

    assert_eq!(
        link.runtime_progress,
        CodexAppServerCallbackResponseExecutionRuntimeProgress::Failed("provider error".to_owned())
    );
    assert_eq!(
        link.status,
        CodexAppServerCallbackResponseExecutionReceiptLinkStatus::Linked
    );
    assert!(!link.provider_completion_recorded);
    assert!(!link.task_completion_permitted);
}

#[test]
fn callback_response_receipt_linkage_keeps_timed_out_outcome_inspectable() {
    let link = codex_callback_response_execution_receipt_link(
        &accepted_admission(),
        &outcome(
            CodexAppServerLiveExecutorOutcomeStatus::TimedOut,
            "provider-transport-write:callback-response:1",
        ),
        receipt_id(),
    );

    assert_eq!(
        link.runtime_progress,
        CodexAppServerCallbackResponseExecutionRuntimeProgress::TimedOut
    );
    assert_eq!(
        link.status,
        CodexAppServerCallbackResponseExecutionReceiptLinkStatus::Linked
    );
    assert!(!link.review_acceptance_permitted);
}

#[test]
fn callback_response_receipt_linkage_keeps_blocked_outcome_inspectable() {
    let link = codex_callback_response_execution_receipt_link(
        &accepted_admission(),
        &outcome(
            CodexAppServerLiveExecutorOutcomeStatus::Blocked("write gate blocked".to_owned()),
            "provider-transport-write:callback-response:1",
        ),
        receipt_id(),
    );

    assert_eq!(
        link.runtime_progress,
        CodexAppServerCallbackResponseExecutionRuntimeProgress::Blocked(
            "write gate blocked".to_owned()
        )
    );
    assert_eq!(
        link.status,
        CodexAppServerCallbackResponseExecutionReceiptLinkStatus::Linked
    );
    assert!(link
        .evidence_refs
        .contains(&"callback-executor-evidence:1".to_owned()));
}

#[test]
fn callback_response_receipt_linkage_keeps_cleanup_required_outcome_inspectable() {
    let link = codex_callback_response_execution_receipt_link(
        &accepted_admission(),
        &outcome(
            CodexAppServerLiveExecutorOutcomeStatus::CleanupRequired(
                "process still running".to_owned(),
            ),
            "provider-transport-write:callback-response:1",
        ),
        receipt_id(),
    );

    assert_eq!(
        link.runtime_progress,
        CodexAppServerCallbackResponseExecutionRuntimeProgress::CleanupRequired(
            "process still running".to_owned()
        )
    );
    assert_eq!(
        link.status,
        CodexAppServerCallbackResponseExecutionReceiptLinkStatus::Linked
    );
    assert!(!link.raw_callback_material_retained);
}

#[test]
fn callback_response_receipt_linkage_blocks_mismatched_or_unsafe_records() {
    let mut admission = accepted_admission();
    admission.provider_instance_id = "codex:other".to_owned();
    admission.raw_callback_material_retained = true;
    admission.review_acceptance_permitted = true;
    let mut unsafe_outcome = outcome(
        CodexAppServerLiveExecutorOutcomeStatus::Completed,
        "provider-transport-write:callback-response:other",
    );
    unsafe_outcome.raw_payload_retained = true;
    unsafe_outcome.task_mutation_permitted = true;

    let link = codex_callback_response_execution_receipt_link(
        &admission,
        &unsafe_outcome,
        EngineRuntimeReceiptRecordId(String::new()),
    );

    assert_eq!(
        link.status,
        CodexAppServerCallbackResponseExecutionReceiptLinkStatus::Blocked(vec![
            CodexAppServerCallbackResponseExecutionReceiptLinkBlocker::MissingRuntimeReceiptId,
            CodexAppServerCallbackResponseExecutionReceiptLinkBlocker::ProviderInstanceMismatch,
            CodexAppServerCallbackResponseExecutionReceiptLinkBlocker::WriteAttemptMismatch,
            CodexAppServerCallbackResponseExecutionReceiptLinkBlocker::OutcomeRetainedRawPayload,
            CodexAppServerCallbackResponseExecutionReceiptLinkBlocker::OutcomePermitsTaskMutation,
            CodexAppServerCallbackResponseExecutionReceiptLinkBlocker::AdmissionRetainedRawCallbackMaterial,
            CodexAppServerCallbackResponseExecutionReceiptLinkBlocker::AdmissionPermitsReviewAcceptance,
        ])
    );
    assert!(!link.task_completion_permitted);
    assert!(!link.review_acceptance_permitted);
}

fn accepted_admission() -> CodexAppServerCallbackResponseExecutorAdmissionRecord {
    let policy = accepted_policy();
    admit_codex_callback_response_executor(CodexAppServerCallbackResponseExecutorAdmissionInput {
        request_id: policy.request_id.clone(),
        callback_response_id: policy.admission_id.clone(),
        envelope_id: policy.envelope_id.clone(),
        provider_callback_id: policy.provider_callback_id.clone(),
        task_id: policy.task_id.clone(),
        work_item_id: policy.work_item_id.clone(),
        provider_instance_id: policy.provider_instance_id.clone(),
        runtime_session_ref: policy.runtime_session_ref.clone().expect("runtime session"),
        callback_response_write_attempt_id: ProviderTransportWriteAttemptId(
            "provider-transport-write:callback-response:1".to_owned(),
        ),
        idempotency_key: ProviderTransportWriteIdempotencyKey(
            "codex-callback-response:provider-callback:1".to_owned(),
        ),
        evidence_refs: vec!["executor-admission-evidence:1".to_owned()],
        invoke_executor_requested: false,
        raw_callback_material_requested: false,
        task_mutation_requested: false,
        review_acceptance_requested: false,
        policy,
    })
}

fn accepted_policy() -> crate::CodexAppServerCallbackResponseExecutionPolicyRecord {
    let request = codex_callback_request(
        &crate::codex_supervision::test_support::runtime(),
        CodexAppServerProviderCallbackId("provider-callback:1".to_owned()),
        AgentSessionId("session:1".to_owned()),
        Some("turn:provider:1".to_owned()),
        Some("item:provider:1".to_owned()),
        TaskId("task:1".to_owned()),
        EngineTaskWorkItemId("work:1".to_owned()),
        CodexAppServerCallbackRequestKind::Permission {
            scope: ApprovalScope::Command,
            options: vec!["allow".to_owned(), "deny".to_owned()],
        },
        CodexAppServerCallbackPromptRef {
            prompt_ref: "callback-prompt:1".to_owned(),
            summary: "callback summary".to_owned(),
            retention: CodexAppServerCallbackPromptRetentionPolicy::SummaryAndRefOnly,
        },
        CodexAppServerPayloadRetentionPolicy::MetadataOnly,
    )
    .expect("callback request");
    let admission = admit_codex_callback_response(CodexAppServerCallbackResponseAdmissionInput {
        request: request.clone(),
        response: CodexAppServerCallbackResponse::Permission {
            selected_option: "allow".to_owned(),
        },
        response_authority_confirmed: true,
        runtime_ready_evidence_refs: vec!["runtime-ready-evidence:1".to_owned()],
        raw_payload_policy_confirmed: true,
    });
    let envelope = codex_callback_response_envelope(&request, &admission).expect("envelope");

    codex_callback_response_execution_policy(CodexAppServerCallbackResponseExecutionPolicyInput {
        request,
        admission,
        envelope,
        provider_instance_id: "codex:local-default".to_owned(),
        runtime_session_ref: Some("runtime-session:1".to_owned()),
        adapter_id: "codex-app-server".to_owned(),
        execution_host_id: EngineHostId("host:local".to_owned()),
        operator_evidence_ref: Some("operator-evidence:callback:1".to_owned()),
        callback_kind_evidence_ref: Some("callback-kind-evidence:permission".to_owned()),
        response_shape_evidence_ref: Some("response-shape-evidence:allow".to_owned()),
        tool_policy: CodexAppServerCallbackResponseExecutionToolPolicy {
            projection_mode: CodexAppServerCallbackResponseExecutionToolProjectionMode::PortalTool,
            adapter_capability_evidence_ref: Some(
                "adapter-capability-evidence:callback-tools".to_owned(),
            ),
            portal_tool_family: Some("Effigy".to_owned()),
            published_actions: vec!["run_selector_request".to_owned()],
            flat_tool_count: 1,
        },
        automatic_callback_answer_requested: false,
        task_completion_requested: false,
        review_acceptance_requested: false,
        cancellation_requested: false,
        resume_requested: false,
        scm_mutation_requested: false,
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
        receipt_refs: vec!["provider-receipt:callback:1".to_owned()],
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
        notification_count: 1,
        server_request_count: 1,
        cleanup_status: CodexAppServerLiveExecutorCleanupStatus::Completed,
        evidence_refs: vec!["callback-executor-evidence:1".to_owned()],
        provider_write_executed: true,
    })
}

fn receipt_id() -> EngineRuntimeReceiptRecordId {
    EngineRuntimeReceiptRecordId(
        "receipt:codex-callback-response:provider-transport-write:callback-response:1".to_owned(),
    )
}
