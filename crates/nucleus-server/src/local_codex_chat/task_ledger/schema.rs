//! Task ledger portal schema: the tool spec and per-action input schemas.
//!
//! Split from the task_ledger god file; behavior unchanged.

use serde_json::{json, Value};

pub(crate) fn dynamic_tool_spec() -> Value {
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
