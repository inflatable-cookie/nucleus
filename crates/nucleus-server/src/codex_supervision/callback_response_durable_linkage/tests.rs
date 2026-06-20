use super::*;
use crate::codex_supervision::{
    admit_codex_callback_response, admit_codex_callback_response_executor, codex_callback_request,
    codex_callback_response_envelope, codex_callback_response_execution_policy,
    codex_callback_response_execution_receipt_link, codex_live_executor_outcome_record,
    CodexAppServerCallbackRequestKind, CodexAppServerCallbackResponse,
    CodexAppServerCallbackResponseAdmissionInput,
    CodexAppServerCallbackResponseExecutionPolicyInput,
    CodexAppServerCallbackResponseExecutionToolPolicy,
    CodexAppServerCallbackResponseExecutionToolProjectionMode,
    CodexAppServerCallbackResponseExecutorAdmissionInput,
    CodexAppServerCallbackResponseExecutorAdmissionRecord, CodexAppServerLiveExecutorCleanupStatus,
    CodexAppServerLiveExecutorMethod, CodexAppServerLiveExecutorOutcomeInput,
    CodexAppServerLiveExecutorOutcomeRecord, CodexAppServerLiveExecutorOutcomeStatus,
    CodexAppServerProviderCallbackId,
};
use crate::host_authority::EngineHostId;
use crate::provider_transport_write::{
    ProviderTransportWriteAttemptId, ProviderTransportWriteIdempotencyKey,
};
use crate::ServerStateService;
use nucleus_agent_protocol::{AgentSessionId, ApprovalScope};
use nucleus_engine::{EngineRuntimeReceiptRecordId, EngineTaskWorkItemId};
use nucleus_local_store::SqliteBackend;
use nucleus_tasks::TaskId;

#[test]
fn callback_response_durable_linkage_survives_reopen_by_reference_only() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let db = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(db.clone()));
    let link = linked_callback_response(CodexAppServerLiveExecutorOutcomeStatus::Completed);

    let persisted = persist_codex_callback_response_durable_linkage(
        &state,
        CodexAppServerCallbackResponseDurableLinkageInput {
            link,
            durable_dispatch_ref: "durable-dispatch:callback-response:1".to_owned(),
            durable_status_ref: "durable-status:callback-response:1".to_owned(),
        },
    )
    .expect("persist callback response durable linkage");

    let reopened = ServerStateService::new(SqliteBackend::new(db));
    let records = read_codex_callback_response_durable_linkage_records(&reopened)
        .expect("read durable linkages");

    assert_eq!(records, vec![persisted.clone()]);
    assert_eq!(records[0].status, "linked");
    assert_eq!(records[0].runtime_progress, "completed");
    assert!(records[0].provider_completion_recorded);
    assert!(records[0].provider_write_recorded);
    assert!(!records[0].task_completion_permitted);
    assert!(!records[0].review_acceptance_permitted);
    assert!(!records[0].raw_callback_material_retained);
    assert!(!records[0].raw_provider_material_retained);
    assert!(!records[0].provider_io_replayed);
}

#[test]
fn callback_response_durable_linkage_records_runtime_progress_only_for_completed_outcome() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let record = persist_codex_callback_response_durable_linkage(
        &state,
        CodexAppServerCallbackResponseDurableLinkageInput {
            link: linked_callback_response(CodexAppServerLiveExecutorOutcomeStatus::Completed),
            durable_dispatch_ref: "durable-dispatch:callback-response:1".to_owned(),
            durable_status_ref: "durable-status:callback-response:1".to_owned(),
        },
    )
    .expect("persist callback response durable linkage");

    assert_eq!(record.runtime_progress, "completed");
    assert!(record.provider_completion_recorded);
    assert!(!record.task_completion_permitted);
    assert!(!record.review_acceptance_permitted);
}

#[test]
fn callback_response_durable_linkage_keeps_failed_outcome_inspectable() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let record = persist_codex_callback_response_durable_linkage(
        &state,
        CodexAppServerCallbackResponseDurableLinkageInput {
            link: linked_callback_response(CodexAppServerLiveExecutorOutcomeStatus::Failed(
                "provider error".to_owned(),
            )),
            durable_dispatch_ref: "durable-dispatch:callback-response:1".to_owned(),
            durable_status_ref: "durable-status:callback-response:1".to_owned(),
        },
    )
    .expect("persist callback response durable linkage");

    assert_eq!(record.runtime_progress, "failed:provider error");
    assert!(!record.provider_completion_recorded);
    assert!(!record.task_completion_permitted);
}

#[test]
fn callback_response_durable_linkage_blocks_review_task_and_raw_authority() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let mut link = linked_callback_response(CodexAppServerLiveExecutorOutcomeStatus::Completed);
    link.review_acceptance_permitted = true;
    link.task_completion_permitted = true;
    link.raw_callback_material_retained = true;

    let error = persist_codex_callback_response_durable_linkage(
        &state,
        CodexAppServerCallbackResponseDurableLinkageInput {
            link,
            durable_dispatch_ref: "durable-dispatch:callback-response:1".to_owned(),
            durable_status_ref: "durable-status:callback-response:1".to_owned(),
        },
    )
    .expect_err("forbidden authority blocked");

    assert!(matches!(error, LocalStoreError::InvalidRecord { .. }));
    assert!(read_codex_callback_response_durable_linkage_records(&state)
        .expect("read durable linkages")
        .is_empty());
}

#[test]
fn callback_response_durable_linkage_payload_excludes_raw_callback_material() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    persist_codex_callback_response_durable_linkage(
        &state,
        CodexAppServerCallbackResponseDurableLinkageInput {
            link: linked_callback_response(CodexAppServerLiveExecutorOutcomeStatus::Completed),
            durable_dispatch_ref: "durable-dispatch:callback-response:1".to_owned(),
            durable_status_ref: "durable-status:callback-response:1".to_owned(),
        },
    )
    .expect("persist callback response durable linkage");

    let json = String::from_utf8(
        state.artifact_metadata().list().expect("metadata")[0]
            .payload
            .bytes
            .clone(),
    )
    .expect("json");

    for forbidden in [
        "selected_option",
        "allow",
        "secret-value",
        "raw_callback_material\":true",
    ] {
        assert!(
            !json.contains(forbidden),
            "callback response linkage leaked {forbidden}"
        );
    }
}

fn linked_callback_response(
    status: CodexAppServerLiveExecutorOutcomeStatus,
) -> crate::CodexAppServerCallbackResponseExecutionReceiptLink {
    codex_callback_response_execution_receipt_link(
        &accepted_admission(),
        &outcome(status),
        EngineRuntimeReceiptRecordId(
            "receipt:codex-callback-response:provider-transport-write:callback-response:1"
                .to_owned(),
        ),
    )
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
        crate::codex_supervision::test_support::callback_prompt_ref(),
        crate::codex_supervision::test_support::metadata_only(),
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
        response_shape_evidence_ref: Some(
            "response-shape-evidence:permission-selection".to_owned(),
        ),
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
) -> CodexAppServerLiveExecutorOutcomeRecord {
    codex_live_executor_outcome_record(CodexAppServerLiveExecutorOutcomeInput {
        provider_instance_id: "codex:local-default".to_owned(),
        write_attempt_id: "provider-transport-write:callback-response:1".to_owned(),
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
