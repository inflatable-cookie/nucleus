use super::*;
use crate::codex_supervision::{
    codex_callback_request, test_support, CodexAppServerCallbackPromptRetentionPolicy,
    CodexAppServerCallbackRequest, CodexAppServerCallbackRequestKind,
    CodexAppServerProviderCallbackId,
};
use crate::ServerStateService;
use nucleus_agent_protocol::{AgentSessionId, ApprovalScope, UserInputPromptKind};
use nucleus_engine::EngineTaskWorkItemId;
use nucleus_local_store::SqliteBackend;
use nucleus_tasks::TaskId;

#[test]
fn callback_request_persistence_survives_reopen_with_wait_state() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let db = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(db.clone()));
    let request = permission_request();
    let persisted = persist_codex_callback_request(
        &state,
        CodexAppServerCallbackRequestPersistenceInput {
            request,
            runtime_receipt_refs: vec!["receipt:runtime:1".to_owned()],
        },
    )
    .expect("persist callback request");

    let reopened = ServerStateService::new(SqliteBackend::new(db));
    let records = read_codex_callback_request_records(&reopened).expect("read callback requests");

    assert_eq!(records, vec![persisted.clone()]);
    assert_eq!(
        records[0].wait_state,
        CodexAppServerCallbackRequestPersistenceWaitState::WaitingForApproval
    );
    assert_eq!(records[0].provider_callback_id, "provider-callback:1");
    assert_eq!(records[0].task_id, "task:1");
    assert_eq!(records[0].work_item_id, "work:1");
    assert!(!records[0].callback_answering_authority);
    assert!(!records[0].response_sent);
    assert!(!records[0].raw_callback_material_retained);
    assert!(!records[0].raw_provider_payload_retained);
    assert!(!records[0].provider_io_executed);
    assert!(!records[0].task_mutation_permitted);
}

#[test]
fn callback_request_persistence_preserves_user_input_wait_state() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let request = codex_callback_request(
        &test_support::runtime(),
        CodexAppServerProviderCallbackId("provider-callback:input".to_owned()),
        test_support::session_id(),
        None,
        Some("item:provider:input".to_owned()),
        test_support::task_id(),
        test_support::work_item_id(),
        CodexAppServerCallbackRequestKind::UserInput {
            kind: UserInputPromptKind::SelectOne,
            options: vec!["first".to_owned(), "second".to_owned()],
        },
        test_support::callback_prompt_ref(),
        test_support::metadata_only(),
    )
    .expect("user input request");

    let persisted = persist_codex_callback_request(
        &state,
        CodexAppServerCallbackRequestPersistenceInput {
            request,
            runtime_receipt_refs: Vec::new(),
        },
    )
    .expect("persist callback request");

    assert_eq!(
        persisted.wait_state,
        CodexAppServerCallbackRequestPersistenceWaitState::WaitingForUserInput
    );
    assert_eq!(persisted.options, vec!["first", "second"]);
}

#[test]
fn callback_request_persistence_blocks_missing_provider_or_task_identity() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));

    let missing_provider = codex_callback_request(
        &test_support::runtime(),
        CodexAppServerProviderCallbackId(String::new()),
        test_support::session_id(),
        None,
        None,
        test_support::task_id(),
        test_support::work_item_id(),
        CodexAppServerCallbackRequestKind::Permission {
            scope: ApprovalScope::Command,
            options: vec!["allow".to_owned()],
        },
        test_support::callback_prompt_ref(),
        test_support::metadata_only(),
    )
    .expect_err("missing provider identity blocked before persistence");
    assert!(matches!(
        missing_provider,
        super::super::callback_request::CodexAppServerCallbackRequestRejection::EmptyProviderCallbackId
    ));

    let missing_task = codex_callback_request(
        &test_support::runtime(),
        CodexAppServerProviderCallbackId("provider-callback:missing-task".to_owned()),
        AgentSessionId("session:1".to_owned()),
        None,
        None,
        TaskId(String::new()),
        EngineTaskWorkItemId("work:1".to_owned()),
        CodexAppServerCallbackRequestKind::Permission {
            scope: ApprovalScope::Command,
            options: vec!["allow".to_owned()],
        },
        test_support::callback_prompt_ref(),
        test_support::metadata_only(),
    )
    .expect_err("missing task identity blocked before persistence");
    assert!(matches!(
        missing_task,
        super::super::callback_request::CodexAppServerCallbackRequestRejection::EmptyTaskId
    ));

    assert!(read_codex_callback_request_records(&state)
        .expect("read callback records")
        .is_empty());
}

#[test]
fn callback_request_persistence_rejects_raw_callback_material() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let mut prompt_ref = test_support::callback_prompt_ref();
    prompt_ref.retention = CodexAppServerCallbackPromptRetentionPolicy::RawPromptAllowed;
    let rejected = codex_callback_request(
        &test_support::runtime(),
        CodexAppServerProviderCallbackId("provider-callback:raw".to_owned()),
        test_support::session_id(),
        None,
        None,
        test_support::task_id(),
        test_support::work_item_id(),
        CodexAppServerCallbackRequestKind::Permission {
            scope: ApprovalScope::Command,
            options: vec!["allow".to_owned()],
        },
        prompt_ref,
        test_support::metadata_only(),
    )
    .expect_err("raw prompt blocked before persistence");

    assert!(matches!(
        rejected,
        super::super::callback_request::CodexAppServerCallbackRequestRejection::RawPromptRetentionNotAllowed
    ));
    assert!(read_codex_callback_request_records(&state)
        .expect("read callback records")
        .is_empty());
}

#[test]
fn callback_request_persistence_payload_excludes_raw_material_terms() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    persist_codex_callback_request(
        &state,
        CodexAppServerCallbackRequestPersistenceInput {
            request: permission_request(),
            runtime_receipt_refs: vec!["receipt:runtime:1".to_owned()],
        },
    )
    .expect("persist callback request");

    let json = String::from_utf8(
        state.artifact_metadata().list().expect("metadata")[0]
            .payload
            .bytes
            .clone(),
    )
    .expect("json");

    for forbidden in ["raw_prompt", "secret-value", "raw_provider_payload\":true"] {
        assert!(
            !json.contains(forbidden),
            "callback persistence leaked {forbidden}"
        );
    }
}

fn permission_request() -> CodexAppServerCallbackRequest {
    codex_callback_request(
        &test_support::runtime(),
        CodexAppServerProviderCallbackId("provider-callback:1".to_owned()),
        test_support::session_id(),
        Some("turn:provider:1".to_owned()),
        Some("item:provider:1".to_owned()),
        test_support::task_id(),
        test_support::work_item_id(),
        CodexAppServerCallbackRequestKind::Permission {
            scope: ApprovalScope::Command,
            options: vec!["allow".to_owned(), "deny".to_owned()],
        },
        test_support::callback_prompt_ref(),
        test_support::metadata_only(),
    )
    .expect("permission request")
}
