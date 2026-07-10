use nucleus_local_store::LocalStoreBackend;
use serde::Deserialize;
use serde_json::{json, Value};

use super::goal_authoring::create_goals;
use super::goal_inspection::inspect_goals;
use super::goal_update::{prepare_task_membership_append, update_goals};
use super::task_authoring::{execute_task_batch, safe_ref, TaskToolOutcome};
use super::task_inspection::inspect_tasks;
use super::task_update::update_tasks;
use crate::control_api::ServerControlRequest;
use crate::ServerStateService;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TaskLedgerInput {
    action: String,
    entity: String,
    #[serde(default)]
    task_ids: Option<Vec<String>>,
    #[serde(default)]
    include_archived: Option<bool>,
    #[serde(default)]
    tasks: Option<Vec<Value>>,
    #[serde(default)]
    updates: Option<Vec<Value>>,
    #[serde(default)]
    goal_ids: Option<Vec<String>>,
    #[serde(default)]
    include_closed: Option<bool>,
    #[serde(default)]
    goals: Option<Vec<Value>>,
    #[serde(default)]
    goal_updates: Option<Vec<Value>>,
    #[serde(default)]
    goal_id: Option<String>,
    #[serde(default)]
    expected_goal_revision: Option<String>,
}

pub(super) fn dynamic_tool_spec() -> Value {
    let task_create = batch_schema(
        50,
        "Create only. Rich tasks to create.",
        task_create_schema(),
    );
    let goal_create = batch_schema(
        10,
        "Goal create only. Create the goal first, then use its returned id and revision when creating its task runway.",
        goal_create_schema(),
    );
    let task_update = batch_schema(
        50,
        "Update only. Revision-safe task intent and readiness patches.",
        task_update_schema(),
    );
    let goal_update = batch_schema(
        10,
        "Goal update only. Revision-safe intent and ordered-membership patches; lifecycle execution is not available here.",
        goal_update_schema(),
    );
    json!({
        "type": "function",
        "name": "task_ledger",
        "description": "Inspect, create, or refine durable Nucleus tasks and goals through one project-ledger portal. Use inspect before updates. Multi-task runways belong to goals. This portal never starts, assigns, mandates, or dispatches work.",
        "inputSchema": {
            "type": "object",
            "required": ["action", "entity"],
            "additionalProperties": false,
            "properties": {
                "action": { "type": "string", "enum": ["inspect", "create", "update"] },
                "entity": { "type": "string", "enum": ["tasks", "goals"] },
                "task_ids": { "type": "array", "maxItems": 50, "items": { "type": "string" }, "description": "Inspect only. Optional task ids; omit to inspect the project task list." },
                "include_archived": { "type": "boolean", "description": "Inspect only. Include archived tasks; defaults to false." },
                "goal_ids": { "type": "array", "maxItems": 50, "items": { "type": "string" }, "description": "Goal inspect only. Optional goal ids; omit to inspect the project goal list." },
                "include_closed": { "type": "boolean", "description": "Goal inspect only. Include achieved and abandoned goals; defaults to false." },
                "goal_id": { "type": "string", "description": "Task create only. Existing goal to append the created tasks to." },
                "expected_goal_revision": { "type": "string", "description": "Task create only. Required with goal_id for revision-safe ordered membership." },
                "tasks": task_create,
                "goals": goal_create,
                "updates": task_update,
                "goal_updates": goal_update
            }
        }
    })
}

fn batch_schema(max_items: usize, description: &str, items: Value) -> Value {
    json!({
        "type": "array",
        "minItems": 1,
        "maxItems": max_items,
        "description": description,
        "items": items
    })
}

fn task_create_schema() -> Value {
    json!({
        "type": "object",
        "required": ["title", "description", "acceptance_criteria", "importance", "action_type", "ready_for_agent", "required_context_refs", "stop_conditions", "validation_commands"],
        "additionalProperties": false,
        "properties": {
            "title": { "type": "string", "description": "Concise task title, at most 160 characters." },
            "description": { "type": "string", "description": "The work, intended outcome, constraints, and useful implementation context." },
            "acceptance_criteria": { "type": "array", "items": { "type": "string" } },
            "importance": { "type": "string", "enum": ["low", "normal", "high", "critical"] },
            "action_type": { "type": "string", "enum": ["research", "plan", "execute", "test", "check", "review"] },
            "ready_for_agent": { "type": "boolean", "description": "True only when the task is safe to dispatch later." },
            "dependency_task_refs": { "type": "array", "items": { "type": "string" } },
            "required_context_refs": { "type": "array", "items": { "type": "string" } },
            "allowed_actions": { "type": "array", "items": { "type": "string", "enum": ["research", "plan", "execute", "test", "check", "review"] } },
            "stop_conditions": { "type": "array", "items": { "type": "string" } },
            "validation_commands": { "type": "array", "items": { "type": "string" } }
        }
    })
}

fn goal_create_schema() -> Value {
    json!({
        "type": "object",
        "required": ["title", "desired_outcome", "scope", "status", "stop_conditions"],
        "additionalProperties": false,
        "properties": {
            "title": { "type": "string" }, "desired_outcome": { "type": "string" },
            "scope": { "type": "string" }, "status": { "type": "string", "enum": ["proposed", "ready"] },
            "owner_refs": { "type": "array", "items": { "type": "string" } },
            "ordered_task_refs": { "type": "array", "maxItems": 50, "items": { "type": "string" } },
            "planning_artifact_refs": { "type": "array", "items": { "type": "string" } },
            "stop_conditions": { "type": "array", "items": { "type": "string" } },
            "evidence_refs": { "type": "array", "items": { "type": "string" } },
            "current_next_task_ref": { "type": "string" }, "next_action": { "type": "string" }
        }
    })
}

fn task_update_schema() -> Value {
    let mut schema = task_create_schema();
    let properties = schema["properties"].as_object_mut().expect("object schema");
    properties.insert("task_id".to_owned(), json!({ "type": "string" }));
    properties.insert("expected_revision".to_owned(), json!({ "type": "string" }));
    schema["required"] = json!(["task_id", "expected_revision"]);
    schema
}

fn goal_update_schema() -> Value {
    let mut schema = goal_create_schema();
    let properties = schema["properties"].as_object_mut().expect("object schema");
    properties.remove("status");
    properties.insert("goal_id".to_owned(), json!({ "type": "string" }));
    properties.insert("expected_revision".to_owned(), json!({ "type": "string" }));
    schema["required"] = json!(["goal_id", "expected_revision"]);
    schema
}

pub(super) fn execute<B, F>(
    state: &ServerStateService<B>,
    project_id: &str,
    conversation_id: &str,
    turn_id: &str,
    call_id: &str,
    arguments: Value,
    command: &mut F,
) -> Result<TaskToolOutcome, String>
where
    B: LocalStoreBackend,
    F: FnMut(ServerControlRequest) -> Result<(), String> + ?Sized,
{
    let input: TaskLedgerInput = serde_json::from_value(arguments)
        .map_err(|error| format!("invalid task_ledger arguments: {error}"))?;
    match (input.action.as_str(), input.entity.as_str()) {
        ("inspect", "tasks") => {
            if input.tasks.is_some()
                || input.updates.is_some()
                || input.goals.is_some()
                || input.goal_updates.is_some()
                || input.goal_ids.is_some()
                || input.include_closed.is_some()
                || input.goal_id.is_some()
                || input.expected_goal_revision.is_some()
            {
                return Err(
                    "task_ledger inspect does not accept create or update records".to_owned(),
                );
            }
            inspect_tasks(
                state,
                project_id,
                json!({
                    "task_ids": input.task_ids.unwrap_or_default(),
                    "include_archived": input.include_archived.unwrap_or(false)
                }),
            )
        }
        ("inspect", "goals") => {
            if input.tasks.is_some()
                || input.updates.is_some()
                || input.goals.is_some()
                || input.goal_updates.is_some()
                || input.task_ids.is_some()
                || input.include_archived.is_some()
                || input.goal_id.is_some()
                || input.expected_goal_revision.is_some()
            {
                return Err(
                    "task_ledger inspect does not accept create or update records".to_owned(),
                );
            }
            inspect_goals(
                state,
                project_id,
                json!({
                    "goal_ids": input.goal_ids.unwrap_or_default(),
                    "include_closed": input.include_closed.unwrap_or(false)
                }),
            )
        }
        ("create", "tasks") => {
            if input.task_ids.is_some()
                || input.include_archived.is_some()
                || input.updates.is_some()
                || input.goal_ids.is_some()
                || input.include_closed.is_some()
                || input.goals.is_some()
                || input.goal_updates.is_some()
            {
                return Err(
                    "task_ledger task create received fields for another operation".to_owned(),
                );
            }
            let tasks = input
                .tasks
                .ok_or_else(|| "task_ledger create requires tasks".to_owned())?;
            let membership = match (
                input.goal_id.as_deref(),
                input.expected_goal_revision.as_deref(),
            ) {
                (Some(goal_id), Some(revision)) => {
                    let call_ref = safe_ref(call_id);
                    let task_ids = (0..tasks.len())
                        .map(|index| format!("task:command:agent-chat:{call_ref}:{}", index + 1))
                        .collect::<Vec<_>>();
                    Some(prepare_task_membership_append(
                        state,
                        project_id,
                        conversation_id,
                        turn_id,
                        call_id,
                        goal_id,
                        revision,
                        &task_ids,
                    )?)
                }
                (None, None) => None,
                _ => {
                    return Err(
                        "task create requires goal_id and expected_goal_revision together"
                            .to_owned(),
                    )
                }
            };
            let mut receipt = execute_task_batch(
                project_id,
                conversation_id,
                turn_id,
                call_id,
                json!({ "tasks": tasks }),
                command,
            )?;
            if let Some((request, goal_receipt)) = membership {
                command(request)?;
                receipt.goals_updated.push(goal_receipt);
            }
            TaskToolOutcome::from_receipt(receipt)
        }
        ("create", "goals") => {
            if input.tasks.is_some()
                || input.updates.is_some()
                || input.goal_updates.is_some()
                || input.task_ids.is_some()
                || input.include_archived.is_some()
                || input.goal_ids.is_some()
                || input.include_closed.is_some()
                || input.goal_id.is_some()
                || input.expected_goal_revision.is_some()
            {
                return Err(
                    "task_ledger goal create received fields for another operation".to_owned(),
                );
            }
            let goals = input
                .goals
                .ok_or_else(|| "task_ledger goal create requires goals".to_owned())?;
            TaskToolOutcome::from_receipt(create_goals(
                project_id,
                conversation_id,
                turn_id,
                call_id,
                json!({ "goals": goals }),
                command,
            )?)
        }
        ("update", "tasks") => {
            if input.task_ids.is_some()
                || input.include_archived.is_some()
                || input.tasks.is_some()
                || input.goals.is_some()
                || input.goal_updates.is_some()
                || input.goal_ids.is_some()
                || input.include_closed.is_some()
                || input.goal_id.is_some()
                || input.expected_goal_revision.is_some()
            {
                return Err(
                    "task_ledger update accepts only the action and updates fields".to_owned(),
                );
            }
            let updates = input
                .updates
                .ok_or_else(|| "task_ledger update requires updates".to_owned())?;
            TaskToolOutcome::from_receipt(update_tasks(
                state,
                project_id,
                conversation_id,
                turn_id,
                call_id,
                json!({ "updates": updates }),
                command,
            )?)
        }
        ("update", "goals") => {
            if input.task_ids.is_some()
                || input.include_archived.is_some()
                || input.tasks.is_some()
                || input.updates.is_some()
                || input.goals.is_some()
                || input.goal_ids.is_some()
                || input.include_closed.is_some()
                || input.goal_id.is_some()
                || input.expected_goal_revision.is_some()
            {
                return Err(
                    "task_ledger goal update received fields for another operation".to_owned(),
                );
            }
            let updates = input
                .goal_updates
                .ok_or_else(|| "task_ledger goal update requires goal_updates".to_owned())?;
            TaskToolOutcome::from_receipt(update_goals(
                state,
                project_id,
                conversation_id,
                turn_id,
                call_id,
                json!({ "updates": updates }),
                command,
            )?)
        }
        (action, entity) => Err(format!(
            "unsupported task_ledger operation: {action} {entity}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control_api::ServerControlResponseStatus;
    use crate::{
        seed_local_project, seed_local_task, LocalControlRequestHandler, LocalProjectSeed,
        LocalTaskSeed,
    };
    use nucleus_local_store::SqliteBackend;

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
            json!({ "action": "inspect", "entity": "tasks" }),
            &mut command,
        )
        .expect("inspect");

        assert_eq!(dynamic_tool_spec()["name"], "task_ledger");
        assert!(outcome.text.contains("task:nucleus-local:bootstrap"));
        assert!(outcome.receipt.is_none());
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
}
