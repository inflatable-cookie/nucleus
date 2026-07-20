use super::*;
use crate::commands::{
    GoalCommand, GoalCreateCommand, ProjectCommand, ProjectCreateCommand, ProjectLifecycleAction,
    ProjectLifecycleCommand, ProjectResourceAction, ProjectResourceCommand, TaskCreateCommand,
};
use crate::local_codex_chat::{
    persist_test_turn_completion, persist_test_turn_failure, persist_test_turn_start,
    LocalCodexChatService, TestStoredChatSession,
};
use crate::project_lifecycle::read_project_lifecycle_receipts;
use nucleus_core::PersistenceRecordId;
use nucleus_planning::GoalStatus;
use nucleus_projects::{decode_project_storage_record, ProjectResourceStorageKind};

#[test]
fn transient_creation_survives_restart_until_explicit_expiry() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let path = temp_dir.path().join("nucleus.sqlite");
    let mut handler = LocalControlRequestHandler::new(SqliteBackend::new(path.clone()), None);
    let record = create_transient(&mut handler, "restart");
    drop(handler);

    let mut reopened = LocalControlRequestHandler::new(SqliteBackend::new(path), None);
    let stored = reopened
        .state()
        .projects()
        .get(&record.id)
        .expect("read project")
        .expect("transient survives restart");
    assert_eq!(
        project(&stored).retention,
        nucleus_projects::ProjectRetentionStorage::Transient
    );

    assert_accepted(reopened.handle(lifecycle_request(
        "expire-restarted",
        &stored,
        ProjectLifecycleAction::ExpireTransient,
    )));
    assert!(reopened
        .state()
        .projects()
        .get(&record.id)
        .expect("read expired project")
        .is_none());
}

#[test]
fn active_chat_turn_blocks_transient_expiry_until_terminal() {
    let (_temp_dir, mut handler) = handler(None);
    let record = create_transient(&mut handler, "active-turn");
    let project_id = record.id.0.clone();
    let conversation_id = format!("{project_id}:panel:agent-chat");
    persist_test_turn_start(
        handler.state(),
        TestStoredChatSession {
            conversation_id: conversation_id.clone(),
            project_id: project_id.clone(),
            resource_id: None,
            session_id: "session:active-turn".to_owned(),
            provider_thread_id: "thread:active-turn".to_owned(),
            model: "gpt-5.4-mini".to_owned(),
            reasoning_effort: Some("low".to_owned()),
            adapter_id: "codex-app-server".to_owned(),
            provider_instance_id: "codex:local-default".to_owned(),
            turn_count: 1,
            task_toolset_version: 5,
        },
        "turn:active-turn",
        "Hello",
        None,
    )
    .expect("persist active turn");

    let blocked = handler.handle(lifecycle_request(
        "expire-active",
        &record,
        ProjectLifecycleAction::ExpireTransient,
    ));
    assert_rejected(blocked, "active");

    persist_test_turn_failure(handler.state(), "turn:active-turn", "stopped").expect("finish turn");
    assert_accepted(handler.handle(lifecycle_request(
        "expire-terminal",
        &record,
        ProjectLifecycleAction::ExpireTransient,
    )));
}

#[test]
fn promoted_chat_retains_conversation_identity_and_history() {
    let (_temp_dir, mut handler) = handler(None);
    let record = create_transient(&mut handler, "history");
    let project_id = record.id.0.clone();
    let conversation_id = format!("{project_id}:panel:agent-chat");
    persist_test_turn_start(
        handler.state(),
        TestStoredChatSession {
            conversation_id: conversation_id.clone(),
            project_id: project_id.clone(),
            resource_id: None,
            session_id: "session:history".to_owned(),
            provider_thread_id: "thread:history".to_owned(),
            model: "gpt-5.4-mini".to_owned(),
            reasoning_effort: Some("low".to_owned()),
            adapter_id: "codex-app-server".to_owned(),
            provider_instance_id: "codex:local-default".to_owned(),
            turn_count: 1,
            task_toolset_version: 5,
        },
        "turn:history",
        "Keep this context",
        None,
    )
    .expect("persist turn");
    persist_test_turn_completion(
        handler.state(),
        "turn:history",
        "provider-turn:history",
        "Context retained",
        &[],
        &[],
    )
    .expect("complete turn");

    assert_accepted(handler.handle(lifecycle_request(
        "promote-history",
        &record,
        ProjectLifecycleAction::Promote {
            display_name: Some("Kept chat".to_owned()),
        },
    )));

    let history = LocalCodexChatService::default()
        .history(handler.state(), &project_id, &conversation_id)
        .expect("promoted history");
    assert_eq!(history.project_id, project_id);
    assert_eq!(history.conversation_id, conversation_id);
    assert_eq!(history.messages.len(), 2);
    assert_eq!(history.messages[0].text, "Keep this context");
    assert_eq!(history.messages[1].text, "Context retained");
}

#[test]
fn task_and_goal_creation_promote_transient_projects_in_place() {
    let (_temp_dir, mut handler) = handler(None);
    let task_project = create_transient(&mut handler, "task-child");
    let task_project_id = ProjectId(task_project.id.0.clone());
    assert_accepted(handler.handle(command_request(
        "task-child",
        ServerCommandKind::Task(TaskCommand::Create(TaskCreateCommand {
            project_id: task_project_id.clone(),
            title: "Durable task".to_owned(),
            description: None,
            acceptance_criteria: vec![nucleus_tasks::AcceptanceCriterion {
                text: "Task is retained".to_owned(),
                required: true,
            }],
            importance: nucleus_tasks::TaskImportance::Normal,
            action_type: nucleus_tasks::TaskActionType::Plan,
            activity: nucleus_tasks::TaskActivityState::Proposed,
            agent_readiness: nucleus_tasks::AgentReadiness {
                ready_for_agent: false,
                required_context_refs: Vec::new(),
                allowed_actions: vec![nucleus_tasks::TaskActionType::Plan],
                stop_conditions: Vec::new(),
                validation_commands: Vec::new(),
            },
        })),
    )));
    assert_durable_with_same_id(&handler, &task_project);

    let goal_project = create_transient(&mut handler, "goal-child");
    let goal_project_id = ProjectId(goal_project.id.0.clone());
    assert_accepted(handler.handle(command_request(
        "goal-child",
        ServerCommandKind::Goal(GoalCommand::Create(GoalCreateCommand {
            project_id: goal_project_id,
            title: "Durable goal".to_owned(),
            desired_outcome: "Retain the goal".to_owned(),
            scope: "Validation".to_owned(),
            status: GoalStatus::Proposed,
            owner_refs: vec!["operator:test".to_owned()],
            ordered_task_refs: Vec::new(),
            planning_artifact_refs: Vec::new(),
            provenance_refs: Vec::new(),
            stop_conditions: Vec::new(),
            evidence_refs: Vec::new(),
            current_next_task_ref: None,
            next_action: None,
        })),
    )));
    assert_durable_with_same_id(&handler, &goal_project);

    let receipts = read_project_lifecycle_receipts(handler.state()).expect("receipts");
    assert_eq!(
        receipts
            .iter()
            .filter(|receipt| receipt.actor_ref == "system:durable-child-admission")
            .count(),
        2
    );
}

#[test]
fn attaching_resource_promotes_transient_project_in_same_mutation() {
    let (temp_dir, mut handler) = handler(None);
    let record = create_transient(&mut handler, "resource-child");
    let folder = temp_dir.path().join("resource");
    std::fs::create_dir(&folder).expect("resource folder");

    assert_accepted(handler.handle(command_request(
        "resource-child",
        ServerCommandKind::Project(ProjectCommand::Resource(ProjectResourceCommand {
            project_id: ProjectId(record.id.0.clone()),
            expected_revision: record.revision_id.clone(),
            actor_ref: "operator:test".to_owned(),
            authority_host_ref: "host:embedded-desktop".to_owned(),
            idempotency_key: "resource-child".to_owned(),
            action: ProjectResourceAction::Attach { locator: folder },
        })),
    )));

    let stored = stored_project(&handler, &record.id);
    let project = project(&stored);
    assert_eq!(project.project_id, record.id.0);
    assert_eq!(
        project.retention,
        nucleus_projects::ProjectRetentionStorage::Durable
    );
    assert_eq!(
        project.resources[0].kind,
        ProjectResourceStorageKind::FilesystemFolder
    );
}

fn create_transient(
    handler: &mut LocalControlRequestHandler<SqliteBackend>,
    suffix: &str,
) -> nucleus_local_store::LocalStoreRecord {
    let previous_ids = handler
        .state()
        .projects()
        .list()
        .expect("projects before create")
        .into_iter()
        .map(|record| record.id)
        .collect::<std::collections::HashSet<_>>();
    assert_accepted(handler.handle(command_request(
        &format!("create-{suffix}"),
        ServerCommandKind::Project(ProjectCommand::Create(ProjectCreateCommand {
            display_name: String::new(),
            transient: true,
            actor_ref: "operator:test".to_owned(),
            authority_host_ref: "host:embedded-desktop".to_owned(),
            idempotency_key: format!("create-{suffix}"),
        })),
    )));
    handler
        .state()
        .projects()
        .list()
        .expect("projects")
        .into_iter()
        .filter(|record| record.kind == PersistenceRecordKind::Project)
        .find(|record| !previous_ids.contains(&record.id))
        .expect("created transient project")
}

fn lifecycle_request(
    command_id: &str,
    project: &nucleus_local_store::LocalStoreRecord,
    action: ProjectLifecycleAction,
) -> ServerControlRequest {
    command_request(
        command_id,
        ServerCommandKind::Project(ProjectCommand::Lifecycle(ProjectLifecycleCommand {
            project_id: ProjectId(project.id.0.clone()),
            expected_revision: project.revision_id.clone(),
            actor_ref: "operator:test".to_owned(),
            authority_host_ref: "host:embedded-desktop".to_owned(),
            idempotency_key: command_id.to_owned(),
            action,
        })),
    )
}

fn command_request(command_id: &str, kind: ServerCommandKind) -> ServerControlRequest {
    ServerControlRequest {
        id: ServerControlRequestId(format!("request:{command_id}")),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId(format!("command:{command_id}")),
            client_id: ClientId("client:desktop".to_owned()),
            kind,
        }),
    }
}

fn stored_project(
    handler: &LocalControlRequestHandler<SqliteBackend>,
    id: &PersistenceRecordId,
) -> nucleus_local_store::LocalStoreRecord {
    handler
        .state()
        .projects()
        .get(id)
        .expect("read project")
        .expect("project")
}

fn project(
    record: &nucleus_local_store::LocalStoreRecord,
) -> nucleus_projects::ProjectStorageRecord {
    decode_project_storage_record(&record.payload.bytes).expect("decode project")
}

fn assert_durable_with_same_id(
    handler: &LocalControlRequestHandler<SqliteBackend>,
    original: &nucleus_local_store::LocalStoreRecord,
) {
    let stored = stored_project(handler, &original.id);
    let project = project(&stored);
    assert_eq!(project.project_id, original.id.0);
    assert_eq!(
        project.retention,
        nucleus_projects::ProjectRetentionStorage::Durable
    );
}

fn assert_accepted(response: crate::control_api::ServerControlResponse) {
    assert_eq!(
        response.status,
        ServerControlResponseStatus::Accepted,
        "{response:#?}"
    );
}

fn assert_rejected(response: crate::control_api::ServerControlResponse, expected: &str) {
    assert_eq!(response.status, ServerControlResponseStatus::Rejected);
    assert!(format!("{response:?}").contains(expected));
}
