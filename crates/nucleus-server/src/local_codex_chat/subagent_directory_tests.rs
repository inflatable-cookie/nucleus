use nucleus_agent_protocol::AgentActivityEvent;
use nucleus_core::{PersistenceRecordId, RevisionId};
use nucleus_local_store::{RevisionExpectation, SqliteBackend};
use swallowtail_runtime::{
    ActivityActor, ActivityDisclosure, ActivityId, ActivityKind, ActivityLifecyclePhase,
    ActivityObservation, ActivityOperationId, ActivityStatus, RuntimeRunId, SubagentId,
    SubagentParent, SubagentSnapshot, SubagentStatus,
};

use super::*;
use crate::local_codex_chat::persistence::{put_json, StoredChatSession};
use crate::local_codex_chat::subagent_selection::{
    read_chat_actor_selection, select_chat_actor, LocalCodexChatActorSelectionKind,
    LocalCodexChatActorSelectionRequest,
};

fn activity(
    operation_id: ActivityOperationId,
    actor: ActivityActor,
    snapshots: impl IntoIterator<Item = SubagentSnapshot>,
) -> ActivityObservation {
    ActivityObservation::new(
        ActivityId::new("collaboration").expect("activity id"),
        operation_id,
        ActivityKind::SubagentOrCollaboration,
        ActivityLifecyclePhase::Updated,
        ActivityStatus::InProgress,
        None,
        ActivityDisclosure::AdapterNormalizedSummary,
    )
    .expect("observation")
    .with_actor(actor)
    .with_subagents(snapshots)
    .expect("snapshots")
}

#[test]
fn durable_directory_preserves_order_unknown_placeholders_and_last_status() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let path = temp_dir.path().join("db.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(path.clone()));
    let operation_id = ActivityOperationId::Run(RuntimeRunId::new("run-1").expect("run id"));
    let parent = SubagentId::new("parent").expect("parent id");
    let actor = SubagentId::new("actor").expect("actor id");
    let child = SubagentId::new("child").expect("child id");
    let mut directories = ChatSubagentDirectories::default();

    let first = directories
        .observe(
            "project:1",
            "conversation:1",
            "turn:1",
            1,
            &AgentActivityEvent::new(
                7,
                activity(
                    operation_id.clone(),
                    ActivityActor::Subagent(actor.clone()),
                    [SubagentSnapshot::new(
                        child,
                        SubagentParent::Subagent(parent.clone()),
                        SubagentStatus::Running,
                    )],
                ),
            ),
        )
        .expect("first observation")
        .expect("directory changed");
    persist_subagent_directory(&state, &first).expect("persist first directory");

    let replaced = directories
        .observe(
            "project:1",
            "conversation:1",
            "turn:1",
            1,
            &AgentActivityEvent::new(
                8,
                activity(
                    operation_id,
                    ActivityActor::Primary,
                    [SubagentSnapshot::new(
                        parent,
                        SubagentParent::Operation,
                        SubagentStatus::Completed,
                    )],
                ),
            ),
        )
        .expect("replacement observation")
        .expect("directory changed");
    persist_subagent_directory(&state, &replaced).expect("persist replacement directory");
    drop(state);

    let reopened = ServerStateService::new(SqliteBackend::new(path));
    let durable = read_subagent_directories(&reopened, "project:1", "conversation:1")
        .expect("read directory");
    assert_eq!(durable.len(), 1);
    assert_eq!(
        durable[0]
            .subagents
            .iter()
            .map(|subagent| subagent.subagent_id.as_str())
            .collect::<Vec<_>>(),
        ["parent", "actor", "child"]
    );
    assert_eq!(durable[0].subagents[0].status, "completed");
    assert_eq!(durable[0].subagents[1].status, "unknown");
    assert_eq!(durable[0].subagents[1].parent_kind, "unknown");
    assert_eq!(durable[0].subagents[2].status, "running");
}

#[test]
fn actor_selection_accepts_only_a_durable_directory_child_and_survives_restart() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let path = temp_dir.path().join("db.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(path.clone()));
    put_json(
        &state,
        PersistenceRecordId("product-chat-session:conversation:1".to_owned()),
        &StoredChatSession {
            conversation_id: "conversation:1".to_owned(),
            project_id: "project:1".to_owned(),
            resource_id: None,
            session_id: "session:1".to_owned(),
            provider_thread_id: "provider-thread:1".to_owned(),
            model: "model:1".to_owned(),
            reasoning_effort: None,
            harness_mode: crate::local_codex_chat::LocalCodexChatHarnessMode::Normal,
            adapter_id: "adapter:1".to_owned(),
            provider_instance_id: "provider:1".to_owned(),
            provider_instance_revision: "1".to_owned(),
            protocol_facade_id: "provider-facade".to_owned(),
            provider_id: None,
            turn_count: 1,
            task_toolset_version: 5,
        },
        RevisionId("rev:session:1".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect("persist session");
    persist_subagent_directory(
        &state,
        &StoredChatSubagentDirectory {
            project_id: "project:1".to_owned(),
            conversation_id: "conversation:1".to_owned(),
            turn_id: "turn:1".to_owned(),
            turn_ordinal: 1,
            runtime_operation_id: "run:run-1".to_owned(),
            first_sequence: 1,
            last_sequence: 2,
            subagents: vec![StoredChatSubagent {
                subagent_id: "child".to_owned(),
                parent_kind: "unknown".to_owned(),
                parent_id: None,
                status: "unknown".to_owned(),
                label: None,
                description: None,
                model: None,
                reasoning: None,
                background: None,
                originating_activity_ref: None,
            }],
        },
    )
    .expect("persist directory");

    let selected = select_chat_actor(
        &state,
        LocalCodexChatActorSelectionRequest {
            project_id: "project:1".to_owned(),
            conversation_id: "conversation:1".to_owned(),
            kind: LocalCodexChatActorSelectionKind::Subagent,
            runtime_operation_id: Some("run:run-1".to_owned()),
            actor_id: Some("child".to_owned()),
        },
    )
    .expect("select child");
    assert_eq!(selected.actor_id.as_deref(), Some("child"));
    assert!(select_chat_actor(
        &state,
        LocalCodexChatActorSelectionRequest {
            project_id: "project:1".to_owned(),
            conversation_id: "conversation:1".to_owned(),
            kind: LocalCodexChatActorSelectionKind::Subagent,
            runtime_operation_id: Some("run:run-1".to_owned()),
            actor_id: Some("invented".to_owned()),
        },
    )
    .is_err());
    drop(state);

    let reopened = ServerStateService::new(SqliteBackend::new(path));
    let replayed = read_chat_actor_selection(&reopened, "project:1", "conversation:1")
        .expect("read selection");
    assert_eq!(replayed, selected);
}
