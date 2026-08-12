//! Workflow mandate tests, split from the mandates god file; behavior
//! unchanged.

use super::types::{
    WorkflowMandateAdmission, WorkflowMandateScope, WorkflowMandateStatus,
    WorkflowMandateTaskSnapshot,
};
use super::store::{now_epoch_seconds, read_workflow_mandate};
use super::create::create_workflow_mandate;
use super::close::cancel_workflow_mandate;
use crate::local_codex_chat::goal_inspection::goal_record;
use crate::local_codex_chat::persistence::{
    operator_message_id, persist_turn_start, StoredChatSession,
};
use crate::local_codex_chat::task_inspection::active_task;
use crate::{
    seed_local_project, seed_local_task, ClientId, LocalControlRequestHandler,
    LocalProjectSeed, LocalTaskSeed, ServerCommand, ServerCommandId, ServerCommandKind,
    ServerControlRequestId, ServerStateService,
};
use nucleus_core::RevisionId;
use nucleus_local_store::SqliteBackend;
use nucleus_planning::{GoalStatus, PlanningGoalId};
use nucleus_projects::ProjectId;
use nucleus_tasks::{TaskActionType, TaskId, TaskImportance};

#[test]
fn mandate_cites_current_operator_turn_and_freezes_goal_membership() {
    let (state, backend, goal_id, goal_revision) = setup_goal();
    let conversation = "conversation:mandate";
    let turn_id = "turn:mandate:1";
    persist_turn_start(
        &state,
        chat_session(conversation),
        turn_id,
        "Please execute this goal now.",
        Some(goal_id.clone()),
    )
    .expect("turn start");

    let mandate = create_workflow_mandate(
        &state,
        WorkflowMandateAdmission {
            mandate_id: "mandate:1".to_owned(),
            conversation_id: conversation.to_owned(),
            operator_message_id: operator_message_id(turn_id),
            operator_message_excerpt: "execute this goal".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            scope: WorkflowMandateScope::Goal {
                goal_id,
                goal_revision,
            },
            idempotency_key: "run:1".to_owned(),
            expires_at_epoch_seconds: now_epoch_seconds().expect("clock") + 300,
        },
    )
    .expect("mandate");

    assert_eq!(mandate.ordered_task_snapshot.len(), 1);
    assert_eq!(
        mandate.ordered_task_snapshot[0].task_id,
        "task:nucleus-local:bootstrap"
    );
    let mut handler = LocalControlRequestHandler::new(backend.clone(), None);
    let response = handler.handle(crate::control_api::ServerControlRequest {
        id: ServerControlRequestId("request:widen-goal".to_owned()),
        client_id: ClientId("client:test".to_owned()),
        kind: crate::control_api::ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId("command:widen-goal".to_owned()),
            client_id: ClientId("client:test".to_owned()),
            kind: ServerCommandKind::Goal(crate::commands::GoalCommand::Update(
                crate::commands::GoalUpdateCommand {
                    goal_id: PlanningGoalId(match &mandate.scope {
                        WorkflowMandateScope::Goal { goal_id, .. } => goal_id.clone(),
                        WorkflowMandateScope::Task { .. } => panic!("expected Goal scope"),
                    }),
                    expected_revision: RevisionId(match &mandate.scope {
                        WorkflowMandateScope::Goal { goal_revision, .. } => goal_revision.clone(),
                        WorkflowMandateScope::Task { .. } => panic!("expected Goal scope"),
                    }),
                    changes: crate::commands::GoalUpdateChanges {
                        ordered_task_refs: Some(vec![
                            TaskId("task:nucleus-local:bootstrap".to_owned()),
                            TaskId("task:nucleus-local:later".to_owned()),
                        ]),
                        ..Default::default()
                    },
                },
            )),
        }),
    });
    assert_eq!(
        response.status,
        crate::control_api::ServerControlResponseStatus::Accepted
    );
    assert_eq!(
        read_workflow_mandate(&state, &mandate.mandate_id)
            .expect("frozen mandate")
            .ordered_task_snapshot,
        mandate.ordered_task_snapshot
    );
    assert!(state.runtime_effects().list().expect("effects").is_empty());
    let cancelled = cancel_workflow_mandate(
        &state,
        &mandate.mandate_id,
        &mandate.revision_id,
        "operator stopped the run",
    )
    .expect("cancel");
    assert_eq!(cancelled.status, WorkflowMandateStatus::Cancelled);
    assert!(state.runtime_effects().list().expect("effects").is_empty());
}

#[test]
fn mandate_rejects_excerpt_missing_from_current_operator_message() {
    let (state, _backend, goal_id, goal_revision) = setup_goal();
    let conversation = "conversation:reject";
    persist_turn_start(
        &state,
        chat_session(conversation),
        "turn:reject:1",
        "Plan this goal.",
        None,
    )
    .expect("turn start");
    let error = create_workflow_mandate(
        &state,
        WorkflowMandateAdmission {
            mandate_id: "mandate:reject".to_owned(),
            conversation_id: conversation.to_owned(),
            operator_message_id: operator_message_id("turn:reject:1"),
            operator_message_excerpt: "execute".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            scope: WorkflowMandateScope::Goal {
                goal_id,
                goal_revision,
            },
            idempotency_key: "run:reject".to_owned(),
            expires_at_epoch_seconds: now_epoch_seconds().expect("clock") + 300,
        },
    )
    .expect_err("missing excerpt must fail");
    assert!(error.contains("does not occur exactly"));
}

#[test]
fn single_task_mandate_freezes_only_the_explicit_task_revision() {
    let (state, _backend, _goal_id, _goal_revision) = setup_goal();
    let conversation = "conversation:single-task";
    let turn_id = "turn:single-task:1";
    persist_turn_start(
        &state,
        chat_session(conversation),
        turn_id,
        "Run the bootstrap task now.",
        None,
    )
    .expect("turn start");
    let task = active_task(
        &state,
        "project:nucleus-local",
        "task:nucleus-local:bootstrap",
    )
    .expect("task");

    let mandate = create_workflow_mandate(
        &state,
        WorkflowMandateAdmission {
            mandate_id: "mandate:single-task".to_owned(),
            conversation_id: conversation.to_owned(),
            operator_message_id: operator_message_id(turn_id),
            operator_message_excerpt: "Run the bootstrap task".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            scope: WorkflowMandateScope::Task {
                task_id: task.task_id.clone(),
                task_revision: task.revision_id.clone(),
            },
            idempotency_key: "run:single-task".to_owned(),
            expires_at_epoch_seconds: now_epoch_seconds().expect("clock") + 300,
        },
    )
    .expect("single-task mandate");

    assert_eq!(
        mandate.ordered_task_snapshot,
        vec![WorkflowMandateTaskSnapshot {
            task_id: task.task_id,
            revision_id: task.revision_id,
        }]
    );
    assert!(matches!(mandate.scope, WorkflowMandateScope::Task { .. }));
}

fn setup_goal() -> (
    ServerStateService<SqliteBackend>,
    SqliteBackend,
    String,
    String,
) {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let path = temp_dir.keep().join("nucleus.sqlite");
    let backend = SqliteBackend::new(path);
    let state = ServerStateService::new(backend.clone());
    seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("project");
    seed_local_task(&state, LocalTaskSeed::nucleus_local_bootstrap()).expect("task");
    seed_local_task(
        &state,
        LocalTaskSeed {
            task_id: "task:nucleus-local:later".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            title: "Later task".to_owned(),
            action_type: TaskActionType::Plan,
            importance: TaskImportance::Normal,
        },
    )
    .expect("later task");
    let command_id = "command:mandate-goal";
    let mut handler = LocalControlRequestHandler::new(backend.clone(), None);
    let response = handler.handle(crate::control_api::ServerControlRequest {
        id: ServerControlRequestId(format!("request:{command_id}")),
        client_id: ClientId("client:test".to_owned()),
        kind: crate::control_api::ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId(command_id.to_owned()),
            client_id: ClientId("client:test".to_owned()),
            kind: ServerCommandKind::Goal(crate::commands::GoalCommand::Create(
                crate::commands::GoalCreateCommand {
                    project_id: ProjectId("project:nucleus-local".to_owned()),
                    title: "Mandated goal".to_owned(),
                    desired_outcome: "Prove bounded execution authority".to_owned(),
                    scope: "One seeded task".to_owned(),
                    status: GoalStatus::Ready,
                    owner_refs: vec!["operator:test".to_owned()],
                    ordered_task_refs: vec![TaskId("task:nucleus-local:bootstrap".to_owned())],
                    planning_artifact_refs: Vec::new(),
                    provenance_refs: vec!["conversation:mandate".to_owned()],
                    stop_conditions: vec!["Stop on failure".to_owned()],
                    evidence_refs: Vec::new(),
                    current_next_task_ref: Some(TaskId(
                        "task:nucleus-local:bootstrap".to_owned(),
                    )),
                    next_action: Some("Execute first task".to_owned()),
                },
            )),
        }),
    });
    assert_eq!(
        response.status,
        crate::control_api::ServerControlResponseStatus::Accepted
    );
    let goal_id = format!("goal:{command_id}");
    let goal = goal_record(&state, "project:nucleus-local", &goal_id).expect("goal");
    (state, backend, goal_id, goal.revision_id)
}

fn chat_session(conversation_id: &str) -> StoredChatSession {
    StoredChatSession {
        conversation_id: conversation_id.to_owned(),
        project_id: "project:nucleus-local".to_owned(),
        resource_id: None,
        session_id: "session:test".to_owned(),
        provider_thread_id: "thread:test".to_owned(),
        model: "gpt-5.4-mini".to_owned(),
        reasoning_effort: Some("low".to_owned()),
        harness_mode: crate::local_codex_chat::LocalCodexChatHarnessMode::Normal,
        adapter_id: "codex-app-server".to_owned(),
        provider_instance_id: "codex:local-default".to_owned(),
        provider_instance_revision: "1".to_owned(),
        protocol_facade_id: "codex-app-server-v2".to_owned(),
        provider_id: None,
        turn_count: 1,
        task_toolset_version: 4,
    }
}
