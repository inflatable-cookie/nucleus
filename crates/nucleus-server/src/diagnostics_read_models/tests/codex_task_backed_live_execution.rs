use crate::host_authority::EngineHostId;
use crate::provider_transport_write::{
    ProviderTransportWriteAttemptId, ProviderTransportWriteIdempotencyKey,
};
use crate::{
    admit_codex_task_work_live_executor, codex_live_executor_outcome_record,
    codex_task_backed_live_execution_diagnostics, codex_task_backed_live_execution_policy,
    codex_task_work_live_executor_receipt_link, CodexAppServerLiveExecutorCleanupStatus,
    CodexAppServerLiveExecutorMethod, CodexAppServerLiveExecutorOutcomeInput,
    CodexAppServerLiveExecutorOutcomeStatus, CodexAppServerTaskBackedLiveExecutionPathwayEvidence,
    CodexAppServerTaskBackedLiveExecutionPolicyInput,
    CodexAppServerTaskBackedLiveExecutionToolPolicy,
    CodexAppServerTaskBackedLiveExecutionToolProjectionMode,
    CodexAppServerTaskWorkLiveExecutorAdmissionInput,
};
use nucleus_engine::{EngineRuntimeReceiptRecordId, EngineTaskWorkItemId};
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

#[test]
fn task_backed_live_execution_diagnostics_are_read_only_and_sanitized() {
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

    let diagnostics = codex_task_backed_live_execution_diagnostics(&[admitted, blocked], &links);
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
    assert!(diagnostics
        .attempts
        .iter()
        .any(|attempt| attempt.status == "completed"
            && attempt.provider_completion_recorded
            && !attempt.review_acceptance_permitted));
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
    assert!(!diagnostics.client_can_mutate_tasks);
    assert!(!diagnostics.client_can_accept_review);
    assert!(!diagnostics.client_can_answer_callbacks);
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
    ] {
        assert!(
            !json.contains(forbidden),
            "task-backed live execution diagnostics leaked {forbidden}"
        );
    }
}

fn admission(
    suffix: &str,
    blocked: bool,
) -> crate::CodexAppServerTaskWorkLiveExecutorAdmissionRecord {
    let mut input = CodexAppServerTaskWorkLiveExecutorAdmissionInput {
        policy: codex_task_backed_live_execution_policy(policy_input(suffix)),
        work_item_id: EngineTaskWorkItemId(format!("work:{suffix}")),
        task_id: TaskId(format!("task:{suffix}")),
        project_id: ProjectId("project:1".to_owned()),
        provider_instance_id: "codex:local-default".to_owned(),
        runtime_session_ref: format!("runtime-session:{suffix}"),
        live_executor_write_attempt_id: ProviderTransportWriteAttemptId(format!("write:{suffix}")),
        idempotency_key: ProviderTransportWriteIdempotencyKey(format!(
            "codex-live-executor:{suffix}"
        )),
        evidence_refs: vec![format!("admission-evidence:{suffix}")],
        invoke_executor_requested: false,
        raw_provider_material_requested: false,
        task_mutation_requested: false,
    };
    if blocked {
        input.task_mutation_requested = true;
    }
    admit_codex_task_work_live_executor(input)
}

fn link(
    suffix: &str,
    status: CodexAppServerLiveExecutorOutcomeStatus,
) -> crate::CodexAppServerTaskWorkLiveExecutorReceiptLink {
    let admission = admission(suffix, false);
    codex_task_work_live_executor_receipt_link(
        &admission,
        &outcome(suffix, status),
        EngineRuntimeReceiptRecordId(format!("receipt:codex-live-executor:write:{suffix}")),
    )
}

fn policy_input(suffix: &str) -> CodexAppServerTaskBackedLiveExecutionPolicyInput {
    CodexAppServerTaskBackedLiveExecutionPolicyInput {
        work_item_id: EngineTaskWorkItemId(format!("work:{suffix}")),
        task_id: TaskId(format!("task:{suffix}")),
        project_id: ProjectId("project:1".to_owned()),
        provider_instance_id: "codex:local-default".to_owned(),
        runtime_session_ref: Some(format!("runtime-session:{suffix}")),
        adapter_id: "codex-app-server".to_owned(),
        execution_host_id: EngineHostId("host:local".to_owned()),
        operator_evidence_ref: Some(format!("operator-evidence:{suffix}")),
        pathway_evidence: CodexAppServerTaskBackedLiveExecutionPathwayEvidence::RoadmapReadyCard {
            roadmap_ref: "roadmap:069".to_owned(),
            card_ref: "card:312".to_owned(),
            evidence_ref: format!("pathway-evidence:{suffix}"),
        },
        tool_policy: CodexAppServerTaskBackedLiveExecutionToolPolicy {
            projection_mode: CodexAppServerTaskBackedLiveExecutionToolProjectionMode::PortalTool,
            adapter_capability_evidence_ref: Some(format!("adapter-capability-evidence:{suffix}")),
            portal_tool_family: Some("Effigy".to_owned()),
            published_actions: vec!["run_selector_request".to_owned()],
            flat_tool_count: 1,
        },
        callback_response_requested: false,
        cancellation_requested: false,
        resume_requested: false,
        task_completion_requested: false,
        review_acceptance_requested: false,
        scm_mutation_requested: false,
        raw_provider_material_requested: false,
    }
}

fn outcome(
    suffix: &str,
    status: CodexAppServerLiveExecutorOutcomeStatus,
) -> crate::CodexAppServerLiveExecutorOutcomeRecord {
    codex_live_executor_outcome_record(CodexAppServerLiveExecutorOutcomeInput {
        provider_instance_id: "codex:local-default".to_owned(),
        write_attempt_id: format!("write:{suffix}"),
        receipt_refs: vec![format!("provider-receipt:{suffix}")],
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
        server_request_count: 0,
        cleanup_status: CodexAppServerLiveExecutorCleanupStatus::Completed,
        evidence_refs: vec![format!("live-executor-evidence:{suffix}")],
        provider_write_executed: true,
    })
}
