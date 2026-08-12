//! Task ledger portal tests, split from the task_ledger god file; behavior
//! unchanged.

use super::*;

use crate::control_api::ServerControlResponseStatus;
use crate::{
    seed_local_project, seed_local_task, LocalControlRequestHandler, LocalProjectSeed,
    LocalTaskSeed, ServerStateService,
};
use nucleus_local_store::SqliteBackend;
use serde_json::json;

#[test]
fn portal_exposes_one_tool_and_routes_inspection() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state =
        ServerStateService::new(SqliteBackend::new(temp_dir.path().join("state.sqlite")));
    seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("project");
    seed_local_task(&state, LocalTaskSeed::nucleus_local_bootstrap()).expect("task");
    let mut command = |_| Err("inspection must not execute a command".to_owned());

    let outcome = execute(
        &state,
        "project:nucleus-local",
        "conversation:test",
        "turn:test",
        "call:test",
        json!({
            "action": "inspect",
            "entity": "tasks",
            "include_archived": false,
            "include_closed": false
        }),
        &mut command,
    )
    .expect("inspect");

    let goals = execute(
        &state,
        "project:nucleus-local",
        "conversation:test",
        "turn:test",
        "call:goals",
        json!({
            "action": "inspect",
            "entity": "goals",
            "include_archived": false,
            "include_closed": false
        }),
        &mut command,
    )
    .expect("inspect goals");

    assert_eq!(dynamic_tool_spec()["name"], "task_ledger");
    assert!(outcome.text.contains("task:nucleus-local:bootstrap"));
    assert!(outcome.receipt.is_none());
    assert_eq!(goals.text, "[]");
}

#[test]
fn portal_rejects_fields_from_another_action_before_commands() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state =
        ServerStateService::new(SqliteBackend::new(temp_dir.path().join("state.sqlite")));
    let mut command_called = false;
    let mut command = |_| {
        command_called = true;
        Ok(())
    };

    let result = execute(
        &state,
        "project:nucleus-local",
        "conversation:test",
        "turn:test",
        "call:test",
        json!({ "action": "create", "entity": "tasks", "tasks": [], "updates": [] }),
        &mut command,
    );
    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("mixed actions must fail"),
    };

    assert!(error.contains("another operation"));
    assert!(!command_called);
}

#[test]
fn portal_creates_goal_then_revision_safe_task_runway_without_runtime_authority() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let backend = SqliteBackend::new(temp_dir.path().join("state.sqlite"));
    let state = ServerStateService::new(backend.clone());
    seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("project");
    let mut handler = LocalControlRequestHandler::new(backend, None);
    let mut command = |request| {
        let envelope = crate::ControlRequestEnvelopeDto::try_from(&request)
            .expect("command must cross the desktop control envelope");
        let request = crate::ServerControlRequest::try_from(envelope)
            .expect("command must decode after desktop transport");
        let response = handler.handle(request);
        if response.status == ServerControlResponseStatus::Accepted {
            Ok(())
        } else {
            Err(format!("command rejected: {:?}", response.body))
        }
    };

    let goal_outcome = execute(
        &state,
        "project:nucleus-local",
        "conversation:test",
        "turn:goal",
        "call:goal",
        json!({
            "action": "create",
            "entity": "goals",
            "goals": [{
                "title": "Ship the task workflow",
                "desired_outcome": "The task workflow is usable.",
                "scope": "Goal-backed task authoring.",
                "status": "ready",
                "stop_conditions": ["Stop when validation fails"]
            }]
        }),
        &mut command,
    )
    .expect("create goal");
    let goal_receipt = goal_outcome
        .receipt
        .expect("goal receipt")
        .goals_created
        .into_iter()
        .next()
        .expect("created goal");

    let task_outcome = execute(
        &state,
        "project:nucleus-local",
        "conversation:test",
        "turn:tasks",
        "call:tasks",
        json!({
            "action": "create",
            "entity": "tasks",
            "goal_id": goal_receipt.goal_id,
            "expected_goal_revision": goal_receipt.revision_id,
            "tasks": [{
                "title": "Build the workflow",
                "description": "Implement the first usable slice.",
                "acceptance_criteria": ["The slice works"],
                "importance": "high",
                "action_type": "execute",
                "ready_for_agent": true,
                "required_context_refs": [],
                "stop_conditions": ["Stop on failing tests"],
                "validation_commands": ["effigy test"]
            }]
        }),
        &mut command,
    )
    .expect("create runway");
    let receipt = task_outcome.receipt.expect("runway receipt");
    assert_eq!(receipt.created.len(), 1);
    assert_eq!(receipt.goals_updated.len(), 1);

    let inspection = execute(
        &state,
        "project:nucleus-local",
        "conversation:test",
        "turn:inspect",
        "call:inspect",
        json!({
            "action": "inspect",
            "entity": "goals",
            "goal_ids": [receipt.goals_updated[0].goal_id]
        }),
        &mut command,
    )
    .expect("inspect goal");
    let goals: Vec<crate::ControlGoalRecordDto> =
        serde_json::from_str(&inspection.text).expect("goal DTOs");
    assert_eq!(
        goals[0].ordered_task_refs,
        vec![receipt.created[0].task_id.clone()]
    );
    assert_eq!(
        goals[0].current_next_task_ref,
        Some(receipt.created[0].task_id.clone())
    );
}
