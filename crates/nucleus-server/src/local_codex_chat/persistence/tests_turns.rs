//! Split from the local_codex_chat persistence god file; behavior unchanged.

use super::*;

use nucleus_local_store::SqliteBackend;

use super::super::{LocalCodexChatHarnessMode, TaskWorkflowReceipt};

#[test]
fn completed_chat_turn_survives_reopen_in_display_order() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let path = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(path.clone()));
    let session = StoredChatSession {
        conversation_id: "project:1:panel:chat".to_owned(),
        project_id: "project:1".to_owned(),
        resource_id: None,
        session_id: "session:1".to_owned(),
        provider_thread_id: "thread:1".to_owned(),
        model: "gpt-5.4-mini".to_owned(),
        reasoning_effort: Some("low".to_owned()),
        harness_mode: LocalCodexChatHarnessMode::Normal,
        adapter_id: "codex-app-server".to_owned(),
        provider_instance_id: "codex:local-default".to_owned(),
        provider_instance_revision: "1".to_owned(),
        protocol_facade_id: "codex-app-server-v2".to_owned(),
        provider_id: None,
        turn_count: 1,
        task_toolset_version: 1,
    };

    persist_turn_start(&state, session, "turn:1", "Hello", None).expect("start");
    persist_turn_completion(
        &state,
        "turn:1",
        "provider-turn:1",
        Some("Hi there"),
        &[],
        &[TaskWorkflowReceipt {
            status: super::super::TaskWorkflowReceiptStatus::ReviewReady,
            scope_kind: "task".to_owned(),
            project_id: "project:1".to_owned(),
            goal_id: None,
            task_id: Some("task:1".to_owned()),
            title: "Task 1".to_owned(),
            current_task_id: Some("task:1".to_owned()),
            current_position: 1,
            total_tasks: 1,
            summary: "Ready for review".to_owned(),
            mandate_id: "mandate:1".to_owned(),
            plan_id: Some("plan:1".to_owned()),
            work_item_refs: vec!["work:1".to_owned()],
            runtime_receipt_refs: vec!["receipt:1".to_owned()],
        }],
    )
    .expect("complete");
    let reopened = ServerStateService::new(SqliteBackend::new(path.clone()));
    let history =
        read_history(&reopened, "project:1", "project:1:panel:chat").expect("read history");

    assert_eq!(history.turns.len(), 1);
    assert_eq!(history.turns[0].status, "completed");
    assert_eq!(history.messages.len(), 2);
    assert_eq!(history.messages[0].role, ChatMessageRole::User);
    assert_eq!(history.messages[1].text, "Hi there");
    assert_eq!(history.messages[1].workflow_receipts.len(), 1);
    assert_eq!(
        history.messages[1].workflow_receipts[0].task_id.as_deref(),
        Some("task:1")
    );
    assert_eq!(history.thread_id.as_deref(), Some("thread:1"));

    let threads = list_threads(&reopened).expect("list threads");
    assert_eq!(threads.len(), 1);
    assert_eq!(threads[0].conversation_id, "project:1:panel:chat");
    assert_eq!(threads[0].title, "Hello");
    assert_eq!(threads[0].status, "completed");

    rename_thread(
        &reopened,
        "project:1",
        "project:1:panel:chat",
        "Named thread",
    )
    .expect("rename thread");
    let reopened_after_rename = ServerStateService::new(SqliteBackend::new(path));
    let renamed_threads = list_threads(&reopened_after_rename).expect("list renamed threads");
    assert_eq!(renamed_threads[0].title, "Named thread");
}

#[test]
fn failed_turn_retains_one_operator_message_without_assistant_copy() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    let session = StoredChatSession {
        conversation_id: "conversation:1".to_owned(),
        project_id: "project:1".to_owned(),
        resource_id: None,
        session_id: "session:1".to_owned(),
        provider_thread_id: "thread:1".to_owned(),
        model: "model".to_owned(),
        reasoning_effort: None,
        harness_mode: LocalCodexChatHarnessMode::Normal,
        adapter_id: "codex-app-server".to_owned(),
        provider_instance_id: "codex:local-default".to_owned(),
        provider_instance_revision: "1".to_owned(),
        protocol_facade_id: "codex-app-server-v2".to_owned(),
        provider_id: None,
        turn_count: 1,
        task_toolset_version: 4,
    };
    persist_turn_start(&state, session, "turn:1", "Run the goal", None).expect("start");
    persist_turn_failure(
        &state,
        "turn:1",
        ChatTurnFailureStatus::Failed,
        "provider unavailable",
    )
    .expect("fail");

    let history = read_history(&state, "project:1", "conversation:1").expect("history");
    assert_eq!(history.turns[0].status, "failed");
    assert_eq!(
        history.turns[0].failure_reason.as_deref(),
        Some("provider unavailable")
    );
    assert_eq!(history.messages.len(), 1);
    assert_eq!(history.messages[0].role, ChatMessageRole::User);
    assert_eq!(
        current_turn(&state, "conversation:1").expect("turn").status,
        "failed"
    );
}

#[test]
fn failed_turn_history_bounds_the_failure_reason() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    let session = StoredChatSession {
        conversation_id: "conversation:bounded".to_owned(),
        project_id: "project:1".to_owned(),
        resource_id: None,
        session_id: "session:bounded".to_owned(),
        provider_thread_id: "thread:bounded".to_owned(),
        model: "model".to_owned(),
        reasoning_effort: None,
        harness_mode: LocalCodexChatHarnessMode::Normal,
        adapter_id: "codex-app-server".to_owned(),
        provider_instance_id: "codex:local-default".to_owned(),
        provider_instance_revision: "1".to_owned(),
        protocol_facade_id: "codex-app-server-v2".to_owned(),
        provider_id: None,
        turn_count: 1,
        task_toolset_version: 4,
    };
    persist_turn_start(&state, session, "turn:bounded", "Run the goal", None).expect("start");
    let long_reason = format!(
        "[swallowtail.codex.app_server.malformed_notification] {}",
        "x".repeat(600)
    );
    persist_turn_failure(
        &state,
        "turn:bounded",
        ChatTurnFailureStatus::Failed,
        &long_reason,
    )
    .expect("fail");

    let history = read_history(&state, "project:1", "conversation:bounded").expect("history");
    let reason = history.turns[0]
        .failure_reason
        .as_deref()
        .expect("failure reason");
    assert_eq!(reason.chars().count(), 500);
    assert!(reason.starts_with("[swallowtail.codex.app_server.malformed_notification]"));
}

#[test]
fn active_turn_lookup_is_project_scoped_and_terminal_aware() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    let session = StoredChatSession {
        conversation_id: "conversation:active".to_owned(),
        project_id: "project:active".to_owned(),
        resource_id: None,
        session_id: "session:active".to_owned(),
        provider_thread_id: "thread:active".to_owned(),
        model: "model".to_owned(),
        reasoning_effort: None,
        harness_mode: LocalCodexChatHarnessMode::Normal,
        adapter_id: "codex-app-server".to_owned(),
        provider_instance_id: "codex:local-default".to_owned(),
        provider_instance_revision: "1".to_owned(),
        protocol_facade_id: "codex-app-server-v2".to_owned(),
        provider_id: None,
        turn_count: 1,
        task_toolset_version: 5,
    };

    persist_turn_start(&state, session, "turn:active", "Hello", None).expect("start");
    assert!(project_has_active_turn(&state, "project:active").expect("active lookup"));
    assert!(!project_has_active_turn(&state, "project:other").expect("other lookup"));

    persist_turn_failure(
        &state,
        "turn:active",
        ChatTurnFailureStatus::Cancelled,
        "stopped",
    )
    .expect("finish");
    assert!(!project_has_active_turn(&state, "project:active").expect("terminal lookup"));
}

#[test]
fn legacy_chat_session_without_toolset_version_requires_migration() {
    let session: StoredChatSession = serde_json::from_value(serde_json::json!({
        "conversation_id": "conversation:legacy",
        "project_id": "project:1",
        "session_id": "session:1",
        "provider_thread_id": "thread:legacy",
        "model": "gpt-5.4-mini",
        "reasoning_effort": "low",
        "turn_count": 2
    }))
    .expect("legacy session");

    assert_eq!(session.task_toolset_version, 0);
    assert_eq!(session.harness_mode, LocalCodexChatHarnessMode::Normal);
}

#[test]
fn native_proof_evidence_counts_terminal_truth_without_sensitive_material() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    for (ordinal, status) in ["started", "completed", "cancelled", "timed_out", "failed"]
        .into_iter()
        .enumerate()
    {
        let conversation_id = format!("conversation:{ordinal}");
        let turn_id = format!("turn:{ordinal}");
        persist_turn_start(
            &state,
            StoredChatSession {
                conversation_id,
                project_id: "project:sensitive".to_owned(),
                resource_id: None,
                session_id: format!("session:{ordinal}"),
                provider_thread_id: format!("provider-secret-{ordinal}"),
                model: "model".to_owned(),
                reasoning_effort: None,
                harness_mode: LocalCodexChatHarnessMode::Normal,
                adapter_id: "codex-app-server".to_owned(),
                provider_instance_id: "codex:local-default".to_owned(),
                provider_instance_revision: "1".to_owned(),
                protocol_facade_id: "codex-app-server-v2".to_owned(),
                provider_id: None,
                turn_count: 1,
                task_toolset_version: 5,
            },
            &turn_id,
            "prompt-secret-material",
            None,
        )
        .expect("start turn");
        match status {
            "started" => {}
            "completed" => persist_turn_completion(
                &state,
                &turn_id,
                "provider-turn-secret",
                Some("assistant-secret-material"),
                &[],
                &[],
            )
            .expect("complete turn"),
            "cancelled" => persist_turn_failure(
                &state,
                &turn_id,
                ChatTurnFailureStatus::Cancelled,
                "cancel-secret-material",
            )
            .expect("cancel turn"),
            "timed_out" => persist_turn_failure(
                &state,
                &turn_id,
                ChatTurnFailureStatus::TimedOut,
                "timeout-secret-material",
            )
            .expect("time out turn"),
            "failed" => persist_turn_failure(
                &state,
                &turn_id,
                ChatTurnFailureStatus::Failed,
                "failure-secret-material",
            )
            .expect("fail turn"),
            _ => unreachable!(),
        }
    }

    let evidence = read_native_proof_evidence(&state).expect("proof evidence");
    assert_eq!(evidence.total_turns, 5);
    assert_eq!(evidence.active_turns, 1);
    assert_eq!(evidence.completed_turns, 1);
    assert_eq!(evidence.cancelled_turns, 1);
    assert_eq!(evidence.timed_out_turns, 1);
    assert_eq!(evidence.failed_turns, 1);
    assert_eq!(evidence.unexpected_turns, 0);
    let json = serde_json::to_string(&evidence).expect("evidence JSON");
    for forbidden in [
        "prompt-secret",
        "assistant-secret",
        "provider-secret",
        "cancel-secret",
        "timeout-secret",
        "failure-secret",
        "project:sensitive",
    ] {
        assert!(!json.contains(forbidden));
    }
}
