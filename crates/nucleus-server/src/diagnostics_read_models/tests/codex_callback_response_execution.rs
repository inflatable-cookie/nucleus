use crate::host_authority::EngineHostId;
use crate::provider_transport_write::{
    ProviderTransportWriteAttemptId, ProviderTransportWriteIdempotencyKey,
};
use crate::{
    admit_codex_callback_response, admit_codex_callback_response_executor, codex_callback_request,
    codex_callback_response_envelope, codex_callback_response_execution_diagnostics,
    codex_callback_response_execution_policy, codex_callback_response_execution_receipt_link,
    codex_live_executor_outcome_record, CodexAppServerCallbackPromptRef,
    CodexAppServerCallbackPromptRetentionPolicy, CodexAppServerCallbackRequestKind,
    CodexAppServerCallbackResponse, CodexAppServerCallbackResponseAdmissionInput,
    CodexAppServerCallbackResponseExecutionPolicyInput,
    CodexAppServerCallbackResponseExecutionToolPolicy,
    CodexAppServerCallbackResponseExecutionToolProjectionMode,
    CodexAppServerCallbackResponseExecutorAdmissionInput, CodexAppServerLiveExecutorCleanupStatus,
    CodexAppServerLiveExecutorMethod, CodexAppServerLiveExecutorOutcomeInput,
    CodexAppServerLiveExecutorOutcomeStatus, CodexAppServerPayloadRetentionPolicy,
    CodexAppServerProviderCallbackId,
};
use nucleus_agent_protocol::{AgentSessionId, ApprovalScope};
use nucleus_engine::{EngineRuntimeReceiptRecordId, EngineTaskWorkItemId};
use nucleus_tasks::TaskId;

#[test]
fn callback_response_execution_diagnostics_are_read_only_and_sanitized() {
    let admitted = admission("admitted", false);
    let blocked = admission("blocked", true);
    let links = vec![
        link(
            "completed",
            CodexAppServerLiveExecutorOutcomeStatus::Completed,
        ),
        link(
            "failed",
            CodexAppServerLiveExecutorOutcomeStatus::Failed("provider exited".to_owned()),
        ),
        link("timeout", CodexAppServerLiveExecutorOutcomeStatus::TimedOut),
        link(
            "cleanup",
            CodexAppServerLiveExecutorOutcomeStatus::CleanupRequired("cleanup required".to_owned()),
        ),
    ];

    let diagnostics = codex_callback_response_execution_diagnostics(&[admitted, blocked], &links);
    let json = serde_json::to_string(&diagnostics).expect("json");

    assert_eq!(diagnostics.source_status, "records");
    assert_eq!(diagnostics.attempts.len(), 6);
    assert!(diagnostics
        .attempts
        .iter()
        .any(|attempt| attempt.status == "admitted"));
    assert!(diagnostics
        .attempts
        .iter()
        .any(|attempt| attempt.status == "blocked"));
    assert!(diagnostics.attempts.iter().any(|attempt| {
        attempt.status == "completed"
            && attempt.provider_completion_recorded
            && !attempt.review_acceptance_permitted
    }));
    assert!(diagnostics
        .attempts
        .iter()
        .any(|attempt| attempt.status == "failed"));
    assert!(diagnostics
        .attempts
        .iter()
        .any(|attempt| attempt.status == "timed_out"));
    assert!(diagnostics
        .attempts
        .iter()
        .any(|attempt| attempt.status == "cleanup_required"));
    assert!(!diagnostics.client_can_execute_provider_write);
    assert!(!diagnostics.client_can_answer_callbacks);
    assert!(!diagnostics.client_can_mutate_tasks);
    assert!(!diagnostics.client_can_accept_review);
    assert!(!diagnostics.client_can_cancel_provider);
    assert!(!diagnostics.client_can_resume_provider);
    assert!(!diagnostics.client_can_mutate_scm);
    assert!(!diagnostics.provider_material_exposed);

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
        "selected_option",
    ] {
        assert!(
            !json.contains(forbidden),
            "callback response execution diagnostics leaked {forbidden}"
        );
    }
}

fn admission(
    suffix: &str,
    blocked: bool,
) -> crate::CodexAppServerCallbackResponseExecutorAdmissionRecord {
    let policy = policy(suffix);
    let mut input = CodexAppServerCallbackResponseExecutorAdmissionInput {
        request_id: policy.request_id.clone(),
        callback_response_id: policy.admission_id.clone(),
        envelope_id: policy.envelope_id.clone(),
        provider_callback_id: policy.provider_callback_id.clone(),
        task_id: policy.task_id.clone(),
        work_item_id: policy.work_item_id.clone(),
        provider_instance_id: policy.provider_instance_id.clone(),
        runtime_session_ref: policy.runtime_session_ref.clone().expect("runtime session"),
        callback_response_write_attempt_id: ProviderTransportWriteAttemptId(format!(
            "provider-transport-write:callback-response:{suffix}"
        )),
        idempotency_key: ProviderTransportWriteIdempotencyKey(format!(
            "codex-callback-response:provider-callback:{suffix}"
        )),
        evidence_refs: vec![format!("callback-executor-admission-evidence:{suffix}")],
        invoke_executor_requested: false,
        raw_callback_material_requested: false,
        task_mutation_requested: false,
        review_acceptance_requested: false,
        policy,
    };
    if blocked {
        input.review_acceptance_requested = true;
    }
    admit_codex_callback_response_executor(input)
}

fn link(
    suffix: &str,
    status: CodexAppServerLiveExecutorOutcomeStatus,
) -> crate::CodexAppServerCallbackResponseExecutionReceiptLink {
    let admission = admission(suffix, false);
    codex_callback_response_execution_receipt_link(
        &admission,
        &outcome(suffix, status),
        EngineRuntimeReceiptRecordId(format!(
            "receipt:codex-callback-response:provider-transport-write:callback-response:{suffix}"
        )),
    )
}

fn policy(suffix: &str) -> crate::CodexAppServerCallbackResponseExecutionPolicyRecord {
    let request = codex_callback_request(
        &crate::codex_supervision::test_support::runtime(),
        CodexAppServerProviderCallbackId(format!("provider-callback:{suffix}")),
        AgentSessionId(format!("session:{suffix}")),
        Some(format!("turn:provider:{suffix}")),
        Some(format!("item:provider:{suffix}")),
        TaskId(format!("task:{suffix}")),
        EngineTaskWorkItemId(format!("work:{suffix}")),
        CodexAppServerCallbackRequestKind::Permission {
            scope: ApprovalScope::Command,
            options: vec!["allow".to_owned(), "deny".to_owned()],
        },
        CodexAppServerCallbackPromptRef {
            prompt_ref: format!("callback-prompt:{suffix}"),
            summary: "callback summary".to_owned(),
            retention: CodexAppServerCallbackPromptRetentionPolicy::SummaryAndRefOnly,
        },
        CodexAppServerPayloadRetentionPolicy::MetadataOnly,
    )
    .expect("callback request");
    let response_admission =
        admit_codex_callback_response(CodexAppServerCallbackResponseAdmissionInput {
            request: request.clone(),
            response: CodexAppServerCallbackResponse::Permission {
                selected_option: "allow".to_owned(),
            },
            response_authority_confirmed: true,
            runtime_ready_evidence_refs: vec![format!("runtime-ready-evidence:{suffix}")],
            raw_payload_policy_confirmed: true,
        });
    let envelope =
        codex_callback_response_envelope(&request, &response_admission).expect("envelope");

    codex_callback_response_execution_policy(CodexAppServerCallbackResponseExecutionPolicyInput {
        request,
        admission: response_admission,
        envelope,
        provider_instance_id: "codex:local-default".to_owned(),
        runtime_session_ref: Some(format!("runtime-session:{suffix}")),
        adapter_id: "codex-app-server".to_owned(),
        execution_host_id: EngineHostId("host:local".to_owned()),
        operator_evidence_ref: Some(format!("operator-evidence:callback:{suffix}")),
        callback_kind_evidence_ref: Some(format!("callback-kind-evidence:{suffix}")),
        response_shape_evidence_ref: Some(format!("response-shape-evidence:{suffix}")),
        tool_policy: CodexAppServerCallbackResponseExecutionToolPolicy {
            projection_mode: CodexAppServerCallbackResponseExecutionToolProjectionMode::PortalTool,
            adapter_capability_evidence_ref: Some(format!(
                "adapter-capability-evidence:callback-tools:{suffix}"
            )),
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
    suffix: &str,
    status: CodexAppServerLiveExecutorOutcomeStatus,
) -> crate::CodexAppServerLiveExecutorOutcomeRecord {
    codex_live_executor_outcome_record(CodexAppServerLiveExecutorOutcomeInput {
        provider_instance_id: "codex:local-default".to_owned(),
        write_attempt_id: format!("provider-transport-write:callback-response:{suffix}"),
        receipt_refs: vec![format!("provider-receipt:callback-response:{suffix}")],
        thread_id: Some(format!("thread:{suffix}")),
        turn_id: Some(format!("turn:{suffix}")),
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
        evidence_refs: vec![format!("callback-response-execution-evidence:{suffix}")],
        provider_write_executed: true,
    })
}
