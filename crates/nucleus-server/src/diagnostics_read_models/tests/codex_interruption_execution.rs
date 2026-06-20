use crate::host_authority::EngineHostId;
use crate::provider_transport_write::{
    ProviderTransportWriteAttemptId, ProviderTransportWriteIdempotencyKey,
};
use crate::{
    admit_codex_interruption, admit_codex_interruption_executor, codex_interruption_envelope,
    codex_interruption_execution_diagnostics, codex_interruption_execution_policy,
    codex_interruption_execution_receipt_link, codex_interruption_request,
    codex_live_executor_outcome_record, CodexAppServerInterruptionAdmissionInput,
    CodexAppServerInterruptionExecutionPolicyInput, CodexAppServerInterruptionExecutionToolPolicy,
    CodexAppServerInterruptionExecutionToolProjectionMode,
    CodexAppServerInterruptionExecutorAdmissionInput, CodexAppServerInterruptionReasonRef,
    CodexAppServerInterruptionReasonRetentionPolicy, CodexAppServerInterruptionRequestRef,
    CodexAppServerInterruptionTarget, CodexAppServerInterruptionTargetState,
    CodexAppServerLiveExecutorCleanupStatus, CodexAppServerLiveExecutorMethod,
    CodexAppServerLiveExecutorOutcomeInput, CodexAppServerLiveExecutorOutcomeStatus,
    CodexAppServerPayloadRetentionPolicy,
};
use nucleus_agent_protocol::AgentSessionId;
use nucleus_engine::{EngineRuntimeReceiptRecordId, EngineTaskWorkItemId};
use nucleus_tasks::TaskId;

#[test]
fn interruption_execution_diagnostics_are_read_only_and_sanitized() {
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

    let diagnostics = codex_interruption_execution_diagnostics(&[admitted, blocked], &links);
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
    assert!(!diagnostics.client_can_interrupt_provider);
    assert!(!diagnostics.client_can_mutate_tasks);
    assert!(!diagnostics.client_can_accept_review);
    assert!(!diagnostics.client_can_answer_callbacks);
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
    ] {
        assert!(
            !json.contains(forbidden),
            "interruption execution diagnostics leaked {forbidden}"
        );
    }
}

fn admission(
    suffix: &str,
    blocked: bool,
) -> crate::CodexAppServerInterruptionExecutorAdmissionRecord {
    let policy = policy(suffix);
    let mut input = CodexAppServerInterruptionExecutorAdmissionInput {
        request_id: policy.request_id.clone(),
        envelope_id: policy.envelope_id.clone(),
        provider_turn_id: policy.provider_turn_id.clone(),
        provider_request_id: policy.provider_request_id.clone(),
        task_id: policy.task_id.clone(),
        work_item_id: policy.work_item_id.clone(),
        provider_instance_id: policy.provider_instance_id.clone(),
        runtime_session_ref: policy.runtime_session_ref.clone().expect("runtime session"),
        interruption_write_attempt_id: ProviderTransportWriteAttemptId(format!(
            "provider-transport-write:interruption:{suffix}"
        )),
        idempotency_key: ProviderTransportWriteIdempotencyKey(format!(
            "codex-interruption:turn:provider:{suffix}"
        )),
        evidence_refs: vec![format!("interruption-executor-admission-evidence:{suffix}")],
        invoke_executor_requested: false,
        raw_provider_material_requested: false,
        raw_callback_material_requested: false,
        task_mutation_requested: false,
        review_acceptance_requested: false,
        resume_requested: false,
        callback_answer_requested: false,
        scm_mutation_requested: false,
        policy,
    };
    if blocked {
        input.resume_requested = true;
    }
    admit_codex_interruption_executor(input)
}

fn link(
    suffix: &str,
    status: CodexAppServerLiveExecutorOutcomeStatus,
) -> crate::CodexAppServerInterruptionExecutionReceiptLink {
    let admission = admission(suffix, false);
    codex_interruption_execution_receipt_link(
        &admission,
        &outcome(suffix, status),
        EngineRuntimeReceiptRecordId(format!(
            "receipt:codex-interruption:provider-transport-write:interruption:{suffix}"
        )),
    )
}

fn policy(suffix: &str) -> crate::CodexAppServerInterruptionExecutionPolicyRecord {
    let request = codex_interruption_request(
        &crate::codex_supervision::test_support::runtime(),
        CodexAppServerInterruptionRequestRef(format!("interrupt:{suffix}")),
        AgentSessionId(format!("session:{suffix}")),
        CodexAppServerInterruptionTarget::ActiveTurn {
            provider_turn_id: format!("turn:provider:{suffix}"),
            provider_request_id: Some(format!("request:provider:{suffix}")),
        },
        TaskId(format!("task:{suffix}")),
        EngineTaskWorkItemId(format!("work:{suffix}")),
        CodexAppServerInterruptionReasonRef {
            reason_ref: format!("interruption-reason:{suffix}"),
            summary: "operator stopped the active turn".to_owned(),
            retention: CodexAppServerInterruptionReasonRetentionPolicy::SummaryAndRefOnly,
        },
        CodexAppServerPayloadRetentionPolicy::MetadataOnly,
    )
    .expect("interruption request");
    let admission = admit_codex_interruption(CodexAppServerInterruptionAdmissionInput {
        request: request.clone(),
        interruption_authority_confirmed: true,
        runtime_ready_evidence_refs: vec![format!("runtime-ready-evidence:{suffix}")],
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
        runtime_session_ref: Some(format!("runtime-session:{suffix}")),
        adapter_id: "codex-app-server".to_owned(),
        execution_host_id: EngineHostId("host:local".to_owned()),
        operator_evidence_ref: Some(format!("operator-evidence:interrupt:{suffix}")),
        target_evidence_ref: Some(format!("target-evidence:{suffix}")),
        interruption_capability_evidence_ref: Some(format!(
            "interruption-capability-evidence:{suffix}"
        )),
        tool_policy: CodexAppServerInterruptionExecutionToolPolicy {
            projection_mode: CodexAppServerInterruptionExecutionToolProjectionMode::PortalTool,
            adapter_capability_evidence_ref: Some(format!(
                "adapter-capability-evidence:interruption-tools:{suffix}"
            )),
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
    suffix: &str,
    status: CodexAppServerLiveExecutorOutcomeStatus,
) -> crate::CodexAppServerLiveExecutorOutcomeRecord {
    codex_live_executor_outcome_record(CodexAppServerLiveExecutorOutcomeInput {
        provider_instance_id: "codex:local-default".to_owned(),
        write_attempt_id: format!("provider-transport-write:interruption:{suffix}"),
        receipt_refs: vec![format!("provider-receipt:interruption:{suffix}")],
        thread_id: Some(format!("thread:{suffix}")),
        turn_id: Some(format!("turn:{suffix}")),
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
        evidence_refs: vec![format!("interruption-execution-evidence:{suffix}")],
        provider_write_executed: true,
    })
}
