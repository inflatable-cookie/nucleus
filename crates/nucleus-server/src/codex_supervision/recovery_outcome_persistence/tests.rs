use super::*;
use crate::codex_supervision::{
    admit_codex_recovery, admit_codex_recovery_executor, codex_live_executor_outcome_record,
    codex_recovery_envelope, codex_recovery_execution_policy,
    codex_recovery_execution_receipt_link, codex_recovery_need_record,
    test_support::{metadata_only, runtime, session_binding, task_id, work_item_id},
    CodexAppServerLiveExecutorCleanupStatus, CodexAppServerLiveExecutorMethod,
    CodexAppServerLiveExecutorOutcomeInput, CodexAppServerLiveExecutorOutcomeStatus,
    CodexAppServerRecoveryAdmissionInput, CodexAppServerRecoveryCapability,
    CodexAppServerRecoveryExecutionPolicyInput, CodexAppServerRecoveryExecutionToolPolicy,
    CodexAppServerRecoveryExecutionToolProjectionMode,
    CodexAppServerRecoveryExecutorAdmissionInput, CodexAppServerRecoveryExecutorAdmissionRecord,
    CodexAppServerRecoverySummaryRef, CodexAppServerRecoveryTrigger,
};
use crate::provider_transport_write::{
    ProviderTransportWriteAttemptId, ProviderTransportWriteIdempotencyKey,
};
use crate::{EngineHostId, ServerStateService};
use nucleus_engine::EngineRuntimeReceiptRecordId;
use nucleus_local_store::SqliteBackend;

#[test]
fn recovery_outcome_persistence_survives_reopen() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let db = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(db.clone()));
    let persisted = persist_codex_recovery_outcome_linkage(
        &state,
        CodexAppServerRecoveryOutcomeLinkageInput {
            link: recovery_link(CodexAppServerLiveExecutorOutcomeStatus::Completed),
            durable_dispatch_ref: "durable-dispatch:recovery:1".to_owned(),
            durable_status_ref: "durable-status:recovery:1".to_owned(),
        },
    )
    .expect("persist recovery outcome");

    let reopened = ServerStateService::new(SqliteBackend::new(db));
    let records =
        read_codex_recovery_outcome_linkage_records(&reopened).expect("read recovery outcomes");

    assert_eq!(records, vec![persisted]);
    assert_eq!(records[0].status, "linked");
    assert_eq!(records[0].runtime_progress, "completed");
    assert!(!records[0].repair_required);
    assert!(!records[0].resume_authority_permitted);
    assert!(!records[0].replacement_thread_promotion_permitted);
    assert!(!records[0].provider_io_replayed);
}

#[test]
fn recovery_outcome_persistence_keeps_replacement_thread_visible_without_promotion() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let mut outcome = executor_outcome(
        CodexAppServerLiveExecutorOutcomeStatus::Completed,
        "write-attempt:recovery:replacement",
    );
    outcome.thread_id = Some("thread:replacement:1".to_owned());
    let link = codex_recovery_execution_receipt_link(
        &accepted_admission("write-attempt:recovery:replacement"),
        &outcome,
        EngineRuntimeReceiptRecordId("receipt:recovery:replacement".to_owned()),
    );

    let record = persist_codex_recovery_outcome_linkage(
        &state,
        CodexAppServerRecoveryOutcomeLinkageInput {
            link,
            durable_dispatch_ref: "durable-dispatch:recovery:replacement".to_owned(),
            durable_status_ref: "durable-status:recovery:replacement".to_owned(),
        },
    )
    .expect("persist replacement-thread observation");

    assert_eq!(record.status, "blocked");
    assert!(record.repair_required);
    assert!(record.replacement_thread_observed);
    assert!(record
        .blocker_refs
        .contains(&"ReplacementThreadMismatch".to_owned()));
    assert!(!record.replacement_thread_promotion_permitted);
    assert!(!record.task_completion_permitted);
}

#[test]
fn recovery_outcome_persistence_turns_uncertain_states_into_repair_evidence() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let timed_out = persist_codex_recovery_outcome_linkage(
        &state,
        CodexAppServerRecoveryOutcomeLinkageInput {
            link: recovery_link_with_write(
                CodexAppServerLiveExecutorOutcomeStatus::TimedOut,
                "write-attempt:recovery:timeout",
            ),
            durable_dispatch_ref: "durable-dispatch:recovery:timeout".to_owned(),
            durable_status_ref: "durable-status:recovery:timeout".to_owned(),
        },
    )
    .expect("persist timeout");
    let cleanup = persist_codex_recovery_outcome_linkage(
        &state,
        CodexAppServerRecoveryOutcomeLinkageInput {
            link: recovery_link_with_write(
                CodexAppServerLiveExecutorOutcomeStatus::CleanupRequired(
                    "provider process still running".to_owned(),
                ),
                "write-attempt:recovery:cleanup",
            ),
            durable_dispatch_ref: "durable-dispatch:recovery:cleanup".to_owned(),
            durable_status_ref: "durable-status:recovery:cleanup".to_owned(),
        },
    )
    .expect("persist cleanup-required");

    assert_eq!(timed_out.runtime_progress, "timed_out");
    assert!(timed_out.repair_required);
    assert_eq!(
        cleanup.runtime_progress,
        "cleanup_required:provider process still running"
    );
    assert!(cleanup.repair_required);
}

#[test]
fn recovery_outcome_persistence_blocks_resume_replacement_and_raw_authority() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let mut link = recovery_link(CodexAppServerLiveExecutorOutcomeStatus::Completed);
    link.replacement_thread_promotion_permitted = true;
    link.review_acceptance_permitted = true;
    link.interruption_permitted = true;
    link.callback_answer_permitted = true;
    link.raw_provider_material_retained = true;

    let error = persist_codex_recovery_outcome_linkage(
        &state,
        CodexAppServerRecoveryOutcomeLinkageInput {
            link,
            durable_dispatch_ref: "durable-dispatch:recovery:1".to_owned(),
            durable_status_ref: "durable-status:recovery:1".to_owned(),
        },
    )
    .expect_err("forbidden authority blocked");

    assert!(matches!(error, LocalStoreError::InvalidRecord { .. }));
    assert!(read_codex_recovery_outcome_linkage_records(&state)
        .expect("read outcomes")
        .is_empty());
}

#[test]
fn recovery_outcome_persistence_payload_excludes_raw_provider_material() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    persist_codex_recovery_outcome_linkage(
        &state,
        CodexAppServerRecoveryOutcomeLinkageInput {
            link: recovery_link(CodexAppServerLiveExecutorOutcomeStatus::Completed),
            durable_dispatch_ref: "durable-dispatch:recovery:1".to_owned(),
            durable_status_ref: "durable-status:recovery:1".to_owned(),
        },
    )
    .expect("persist recovery outcome");

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
            "recovery outcome leaked {forbidden}"
        );
    }
}

fn recovery_link(
    status: CodexAppServerLiveExecutorOutcomeStatus,
) -> crate::CodexAppServerRecoveryExecutionReceiptLink {
    recovery_link_with_write(status, "write-attempt:recovery:1")
}

fn recovery_link_with_write(
    status: CodexAppServerLiveExecutorOutcomeStatus,
    write_attempt_id: &str,
) -> crate::CodexAppServerRecoveryExecutionReceiptLink {
    codex_recovery_execution_receipt_link(
        &accepted_admission(write_attempt_id),
        &executor_outcome(status, write_attempt_id),
        EngineRuntimeReceiptRecordId(format!("receipt:recovery:{write_attempt_id}")),
    )
}

fn accepted_admission(write_attempt_id: &str) -> CodexAppServerRecoveryExecutorAdmissionRecord {
    let policy = accepted_policy();
    admit_codex_recovery_executor(CodexAppServerRecoveryExecutorAdmissionInput {
        need_id: policy.need_id.clone(),
        envelope_id: policy.envelope_id.clone(),
        provider_thread_id: policy.provider_thread_id.clone(),
        provider_turn_id: policy.provider_turn_id.clone(),
        provider_request_id: policy.provider_request_id.clone(),
        task_id: policy.task_id.clone(),
        work_item_id: policy.work_item_id.clone(),
        provider_instance_id: policy.provider_instance_id.clone(),
        runtime_session_ref: policy.runtime_session_ref.clone().expect("runtime session"),
        recovery_write_attempt_id: ProviderTransportWriteAttemptId(write_attempt_id.to_owned()),
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

fn accepted_policy() -> crate::CodexAppServerRecoveryExecutionPolicyRecord {
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
        CodexAppServerRecoverySummaryRef {
            summary_ref: "recovery-summary:1".to_owned(),
            summary: "Codex process exited while a task-backed turn was active".to_owned(),
        },
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

    codex_recovery_execution_policy(CodexAppServerRecoveryExecutionPolicyInput {
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
    })
}

fn executor_outcome(
    status: CodexAppServerLiveExecutorOutcomeStatus,
    write_attempt_id: &str,
) -> crate::CodexAppServerLiveExecutorOutcomeRecord {
    codex_live_executor_outcome_record(CodexAppServerLiveExecutorOutcomeInput {
        provider_instance_id: "codex:local-default".to_owned(),
        write_attempt_id: write_attempt_id.to_owned(),
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
