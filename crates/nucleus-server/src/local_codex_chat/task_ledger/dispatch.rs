//! Task ledger portal dispatch: action/entity routing with strict
//! field-isolation rejection before any command executes.
//!
//! Split from the task_ledger god file; behavior unchanged.

use nucleus_local_store::LocalStoreBackend;
use serde::Deserialize;
use serde_json::{json, Value};

use super::super::goal_authoring::create_goals;
use super::super::goal_inspection::inspect_goals;
use super::super::goal_update::{prepare_task_membership_append, update_goals};
use super::super::task_authoring::{execute_task_batch, safe_ref, TaskToolOutcome};
use super::super::task_inspection::inspect_tasks;
use super::super::task_update::update_tasks;
use crate::control_api::ServerControlRequest;
use crate::ServerStateService;

#[derive(Deserialize)]
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

pub(crate) fn execute<B, F>(
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
