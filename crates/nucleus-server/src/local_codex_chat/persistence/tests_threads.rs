//! Split from the local_codex_chat persistence god file; behavior unchanged.

use super::*;

use nucleus_local_store::SqliteBackend;

use super::super::LocalCodexChatHarnessMode;

#[test]
fn thread_rename_rejects_empty_titles_and_cross_project_access() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    let session = StoredChatSession {
        conversation_id: "conversation:rename".to_owned(),
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
        task_toolset_version: 5,
    };
    persist_turn_start(&state, session, "turn:rename", "Original title", None).expect("start");

    assert_eq!(
        rename_thread(&state, "project:1", "conversation:rename", "   "),
        Err("chat thread title must not be empty".to_owned()),
    );
    assert_eq!(
        rename_thread(&state, "project:2", "conversation:rename", "Wrong project"),
        Err("chat thread not found: conversation:rename".to_owned()),
    );
}

#[test]
fn thread_delete_removes_every_conversation_record() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let path = temp_dir.path().join("db.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(path.clone()));
    let session = |conversation_id: &str| StoredChatSession {
        conversation_id: conversation_id.to_owned(),
        project_id: "project:1".to_owned(),
        resource_id: None,
        session_id: format!("session:{conversation_id}"),
        provider_thread_id: format!("thread:{conversation_id}"),
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
    persist_turn_start(
        &state,
        session("conversation:delete"),
        "turn:delete",
        "Delete me",
        None,
    )
    .expect("start deleted thread");
    persist_turn_completion(
        &state,
        "turn:delete",
        "provider-turn:delete",
        Some("Gone"),
        &[],
        &[],
    )
    .expect("complete deleted thread");
    persist_turn_start(
        &state,
        session("conversation:keep"),
        "turn:keep",
        "Keep me",
        None,
    )
    .expect("start kept thread");

    let deleted =
        delete_thread(&state, "project:1", "conversation:delete").expect("delete thread");
    assert!(deleted >= 4, "session, turn, and both messages: {deleted}");
    assert_eq!(
        delete_thread(&state, "project:1", "conversation:delete"),
        Err("chat thread not found: conversation:delete".to_owned()),
        "second delete finds nothing",
    );
    assert_eq!(
        delete_thread(&state, "project:2", "conversation:keep"),
        Err("chat thread not found: conversation:keep".to_owned()),
        "cross-project delete is rejected",
    );

    let reopened = ServerStateService::new(SqliteBackend::new(path));
    let threads = list_threads(&reopened).expect("list threads");
    assert_eq!(threads.len(), 1);
    assert_eq!(threads[0].conversation_id, "conversation:keep");
    let gone = read_history(&reopened, "project:1", "conversation:delete")
        .expect("deleted history reads empty");
    assert!(gone.turns.is_empty());
    assert!(gone.messages.is_empty());
    let kept = read_history(&reopened, "project:1", "conversation:keep")
        .expect("kept history survives");
    assert_eq!(kept.messages.len(), 1);
}
