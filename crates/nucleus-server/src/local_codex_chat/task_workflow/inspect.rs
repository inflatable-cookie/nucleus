//! Task workflow inspection: the portal schema, action dispatch, and
//! read-only task/Goal inspection with readiness blockers.
//!
//! Split from the task_workflow god file; behavior unchanged.

use nucleus_local_store::LocalStoreBackend;
use serde_json::{json, Value};

use super::run::{run, task_blockers};
use super::super::goal_inspection::goal_record;
use super::super::rework_context::current_task_review_context;
use super::super::task_authoring::TaskToolOutcome;
use super::super::task_inspection::active_task;
use super::types::TaskWorkflowInput;
use crate::{ServerStateService, TaskReviewSnapshotStore};

pub(crate) fn dynamic_tool_spec() -> Value {
    json!({
        "type": "function",
        "name": "task_workflow",
        "description": "Inspect or run one durable Nucleus task or one Goal's ordered task snapshot. Task inspection includes the current durable review context. A fresh task run after rejected or needs-changes review carries that note and prior evidence refs into a new work item. Run requires an exact excerpt from the current operator message, the current scope revision, and an idempotency key. It performs the complete provider handoff; it does not accept review, complete tasks, achieve Goals, or publish SCM changes.",
        "inputSchema": {
            "type": "object",
            "required": ["action", "scope"],
            "additionalProperties": false,
            "properties": {
                "action": { "type": "string", "enum": ["inspect", "run"] },
                "scope": { "type": "string", "enum": ["task", "goal"] },
                "task_id": { "type": "string", "description": "Required only for task scope." },
                "goal_id": { "type": "string", "description": "Required only for Goal scope." },
                "expected_revision": { "type": "string", "description": "Run only. Current task or Goal revision." },
                "operator_message_excerpt": { "type": "string", "description": "Run only. Exact non-empty excerpt from the current operator message that grants execution authority." },
                "idempotency_key": { "type": "string", "description": "Run only. Stable key for this bounded execution intent." }
            }
        }
    })
}

pub(crate) fn execute<B>(
    state: &ServerStateService<B>,
    snapshot_store: Option<&TaskReviewSnapshotStore>,
    project_id: &str,
    conversation_id: &str,
    resource_id: Option<&str>,
    arguments: Value,
) -> Result<TaskToolOutcome, String>
where
    B: LocalStoreBackend,
{
    let input: TaskWorkflowInput = serde_json::from_value(arguments)
        .map_err(|error| format!("invalid task_workflow input: {error}"))?;
    validate_scope_fields(&input)?;
    match input.action.as_str() {
        "inspect" => inspect(state, project_id, input),
        "run" => run(
            state,
            snapshot_store,
            project_id,
            conversation_id,
            resource_id,
            input,
        ),
        action => Err(format!("unsupported task_workflow action: {action}")),
    }
}

fn inspect<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    input: TaskWorkflowInput,
) -> Result<TaskToolOutcome, String>
where
    B: LocalStoreBackend,
{
    reject_run_fields_for_inspect(&input)?;
    let value = match input.scope.as_str() {
        "task" => {
            let task_id = input.task_id.as_deref().expect("validated task scope");
            let task = active_task(state, project_id, task_id)?;
            let review = current_task_review_context(state, project_id, task_id)?;
            let mut blockers = task_blockers(state, project_id, &task)?;
            for dependency_id in task
                .required_context_refs
                .iter()
                .filter(|reference| reference.starts_with("task:"))
            {
                let dependency = active_task(state, project_id, dependency_id)?;
                if !matches!(dependency.activity.as_str(), "done" | "archived") {
                    blockers.push(format!(
                        "Task {} dependency is not terminal: {dependency_id}",
                        task.task_id
                    ));
                }
            }
            json!({
                "scope": "task",
                "task": task,
                "review": review,
                "ready_to_run": blockers.is_empty(),
                "blockers": blockers,
                "available_outcomes": if blockers.is_empty() { vec!["run"] } else { vec!["blocked"] }
            })
        }
        "goal" => {
            let goal_id = input.goal_id.as_deref().expect("validated Goal scope");
            let goal = goal_record(state, project_id, goal_id)?;
            let mut tasks = Vec::with_capacity(goal.ordered_task_refs.len());
            let mut blockers = Vec::new();
            if !matches!(goal.status.as_str(), "ready" | "active") {
                blockers.push(format!("Goal status is {}", goal.status));
            }
            for (ordinal, task_id) in goal.ordered_task_refs.iter().enumerate() {
                let task = active_task(state, project_id, task_id)?;
                blockers.extend(task_blockers(state, project_id, &task)?);
                for dependency_id in task
                    .required_context_refs
                    .iter()
                    .filter(|reference| reference.starts_with("task:"))
                {
                    if let Some(dependency_ordinal) = goal
                        .ordered_task_refs
                        .iter()
                        .position(|candidate| candidate == dependency_id)
                    {
                        if dependency_ordinal >= ordinal {
                            blockers.push(format!(
                                "Task {} dependency {dependency_id} does not precede it in Goal order",
                                task.task_id
                            ));
                        }
                    } else {
                        let dependency = active_task(state, project_id, dependency_id)?;
                        if !matches!(dependency.activity.as_str(), "done" | "archived") {
                            blockers.push(format!(
                                "Task {} external dependency is not terminal: {dependency_id}",
                                task.task_id
                            ));
                        }
                    }
                }
                tasks.push(task);
            }
            if tasks.is_empty() {
                blockers.push("Goal has no ordered tasks".to_owned());
            }
            json!({
                "scope": "goal",
                "goal": goal,
                "tasks": tasks,
                "ready_to_run": blockers.is_empty(),
                "blockers": blockers,
                "available_outcomes": if blockers.is_empty() { vec!["run"] } else { vec!["blocked"] }
            })
        }
        _ => unreachable!("validated scope"),
    };
    Ok(TaskToolOutcome::text(
        serde_json::to_string(&value)
            .map_err(|error| format!("failed to encode task_workflow inspection: {error}"))?,
    ))
}

fn validate_scope_fields(input: &TaskWorkflowInput) -> Result<(), String> {
    match input.scope.as_str() {
        "task" if input.task_id.is_some() && input.goal_id.is_none() => Ok(()),
        "goal" if input.goal_id.is_some() && input.task_id.is_none() => Ok(()),
        "task" => Err("task_workflow task scope requires only task_id".to_owned()),
        "goal" => Err("task_workflow Goal scope requires only goal_id".to_owned()),
        scope => Err(format!("unsupported task_workflow scope: {scope}")),
    }
}

fn reject_run_fields_for_inspect(input: &TaskWorkflowInput) -> Result<(), String> {
    if input.expected_revision.is_some()
        || input.operator_message_excerpt.is_some()
        || input.idempotency_key.is_some()
    {
        Err("task_workflow inspect does not accept run authority fields".to_owned())
    } else {
        Ok(())
    }
}
