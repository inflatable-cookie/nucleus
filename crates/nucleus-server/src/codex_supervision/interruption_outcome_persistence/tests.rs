use super::*;
use crate::codex_supervision::{
    admit_codex_interruption, admit_codex_interruption_executor, codex_interruption_envelope,
    codex_interruption_execution_policy, codex_interruption_execution_receipt_link,
    codex_interruption_request, codex_live_executor_outcome_record,
    CodexAppServerInterruptionAdmissionInput, CodexAppServerInterruptionExecutionPolicyInput,
    CodexAppServerInterruptionExecutionToolPolicy,
    CodexAppServerInterruptionExecutionToolProjectionMode,
    CodexAppServerInterruptionExecutorAdmissionInput,
    CodexAppServerInterruptionExecutorAdmissionRecord, CodexAppServerInterruptionReasonRef,
    CodexAppServerInterruptionReasonRetentionPolicy, CodexAppServerInterruptionRequestRef,
    CodexAppServerInterruptionTarget, CodexAppServerInterruptionTargetState,
    CodexAppServerLiveExecutorCleanupStatus, CodexAppServerLiveExecutorMethod,
    CodexAppServerLiveExecutorOutcomeInput, CodexAppServerLiveExecutorOutcomeStatus,
    CodexAppServerPayloadRetentionPolicy,
};
use crate::host_authority::EngineHostId;
use crate::provider_transport_write::{
    ProviderTransportWriteAttemptId, ProviderTransportWriteIdempotencyKey,
};
use crate::ServerStateService;
use nucleus_agent_protocol::AgentSessionId;
use nucleus_engine::{EngineRuntimeReceiptRecordId, EngineTaskWorkItemId};
use nucleus_local_store::SqliteBackend;
use nucleus_tasks::TaskId;

#[test]
fn interruption_outcome_persistence_survives_reopen() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let db = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(db.clone()));
    let persisted = persist_codex_interruption_outcome_linkage(
        &state,
        CodexAppServerInterruptionOutcomeLinkageInput {
            link: interruption_link(CodexAppServerLiveExecutorOutcomeStatus::Completed),
            durable_dispatch_ref: "durable-dispatch:interruption:1".to_owned(),
            durable_status_ref: "durable-status:interruption:1".to_owned(),
        },
    )
    .expect("persist interruption outcome");

    let reopened = ServerStateService::new(SqliteBackend::new(db));
    let records =
        read_codex_interruption_outcome_linkage_records(&reopened).expect("read outcomes");

    assert_eq!(records, vec![persisted]);
    assert_eq!(records[0].status, "linked");
    assert_eq!(records[0].runtime_progress, "completed");
    assert!(records[0].provider_completion_recorded);
    assert!(!records[0].task_completion_permitted);
    assert!(!records[0].task_rollback_permitted);
    assert!(!records[0].raw_provider_material_retained);
    assert!(!records[0].provider_io_replayed);
}

#[test]
fn interruption_outcome_persistence_keeps_failed_and_timeout_states_inspectable() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let failed = persist_codex_interruption_outcome_linkage(
        &state,
        CodexAppServerInterruptionOutcomeLinkageInput {
            link: interruption_link(CodexAppServerLiveExecutorOutcomeStatus::Failed(
                "provider error".to_owned(),
            )),
            durable_dispatch_ref: "durable-dispatch:interruption:failed".to_owned(),
            durable_status_ref: "durable-status:interruption:failed".to_owned(),
        },
    )
    .expect("persist failed outcome");
    let timed_out = persist_codex_interruption_outcome_linkage(
        &state,
        CodexAppServerInterruptionOutcomeLinkageInput {
            link: interruption_link_with_write(
                CodexAppServerLiveExecutorOutcomeStatus::TimedOut,
                "provider-transport-write:interruption:timeout",
            ),
            durable_dispatch_ref: "durable-dispatch:interruption:timeout".to_owned(),
            durable_status_ref: "durable-status:interruption:timeout".to_owned(),
        },
    )
    .expect("persist timeout outcome");

    assert_eq!(failed.runtime_progress, "failed:provider error");
    assert_eq!(timed_out.runtime_progress, "timed_out");
    assert!(!failed.task_completion_permitted);
    assert!(!timed_out.review_acceptance_permitted);
}

#[test]
fn interruption_outcome_persistence_blocks_task_rollback_and_recovery_authority() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let mut link = interruption_link(CodexAppServerLiveExecutorOutcomeStatus::Completed);
    link.task_completion_permitted = true;
    link.review_acceptance_permitted = true;
    link.resume_permitted = true;
    link.callback_answer_permitted = true;
    link.raw_provider_material_retained = true;

    let error = persist_codex_interruption_outcome_linkage(
        &state,
        CodexAppServerInterruptionOutcomeLinkageInput {
            link,
            durable_dispatch_ref: "durable-dispatch:interruption:1".to_owned(),
            durable_status_ref: "durable-status:interruption:1".to_owned(),
        },
    )
    .expect_err("forbidden authority blocked");

    assert!(matches!(error, LocalStoreError::InvalidRecord { .. }));
    assert!(read_codex_interruption_outcome_linkage_records(&state)
        .expect("read outcomes")
        .is_empty());
}

#[test]
fn interruption_outcome_persistence_payload_excludes_raw_provider_material() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    persist_codex_interruption_outcome_linkage(
        &state,
        CodexAppServerInterruptionOutcomeLinkageInput {
            link: interruption_link(CodexAppServerLiveExecutorOutcomeStatus::Completed),
            durable_dispatch_ref: "durable-dispatch:interruption:1".to_owned(),
            durable_status_ref: "durable-status:interruption:1".to_owned(),
        },
    )
    .expect("persist interruption outcome");

    let json = String::from_utf8(
        state.artifact_metadata().list().expect("metadata")[0]
            .payload
            .bytes
            .clone(),
    )
    .expect("json");

    for forbidden in ["stdout", "secret-value", "raw_provider_material\":true"] {
        assert!(
            !json.contains(forbidden),
            "interruption outcome leaked {forbidden}"
        );
    }
}

fn interruption_link(
    status: CodexAppServerLiveExecutorOutcomeStatus,
) -> crate::CodexAppServerInterruptionExecutionReceiptLink {
    interruption_link_with_write(status, "provider-transport-write:interruption:1")
}

fn interruption_link_with_write(
    status: CodexAppServerLiveExecutorOutcomeStatus,
    write_attempt_id: &str,
) -> crate::CodexAppServerInterruptionExecutionReceiptLink {
    codex_interruption_execution_receipt_link(
        &accepted_admission(write_attempt_id),
        &outcome(status, write_attempt_id),
        EngineRuntimeReceiptRecordId(format!("receipt:codex-interruption:{write_attempt_id}")),
    )
}

fn accepted_admission(write_attempt_id: &str) -> CodexAppServerInterruptionExecutorAdmissionRecord {
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
        interruption_write_attempt_id: ProviderTransportWriteAttemptId(write_attempt_id.to_owned()),
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
) -> crate::CodexAppServerLiveExecutorOutcomeRecord {
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
