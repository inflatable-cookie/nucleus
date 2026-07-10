use std::collections::HashSet;

use nucleus_core::{PersistenceRecordId, RevisionId};
use nucleus_local_store::LocalStoreBackend;
use nucleus_tasks::{
    decode_task_storage_record, AcceptanceCriterion, AgentReadiness, TaskActionType,
};
use serde::Deserialize;
use serde_json::Value;

use super::task_authoring::{
    parse_action_type, parse_importance, safe_ref, TaskAuthoringReceipt, TaskCreationReceipt,
};
use crate::commands::{
    ServerCommand, ServerCommandKind, TaskCommand, TaskUpdateChanges, TaskUpdateCommand,
};
use crate::control_api::{ServerControlRequest, ServerControlRequestKind};
use crate::ids::{ClientId, ServerCommandId, ServerControlRequestId};
use crate::ServerStateService;

#[derive(Debug, Deserialize)]
struct TaskUpdateBatchInput {
    updates: Vec<TaskUpdateInput>,
}

#[derive(Debug, Deserialize)]
struct TaskUpdateInput {
    task_id: String,
    expected_revision: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    acceptance_criteria: Option<Vec<String>>,
    #[serde(default)]
    importance: Option<String>,
    #[serde(default)]
    action_type: Option<String>,
    #[serde(default)]
    ready_for_agent: Option<bool>,
    #[serde(default)]
    required_context_refs: Option<Vec<String>>,
    #[serde(default)]
    allowed_actions: Option<Vec<String>>,
    #[serde(default)]
    stop_conditions: Option<Vec<String>>,
    #[serde(default)]
    validation_commands: Option<Vec<String>>,
}

pub(super) fn update_tasks<B, F>(
    state: &ServerStateService<B>,
    project_id: &str,
    conversation_id: &str,
    turn_id: &str,
    call_id: &str,
    arguments: Value,
    execute: &mut F,
) -> Result<TaskAuthoringReceipt, String>
where
    B: LocalStoreBackend,
    F: FnMut(ServerControlRequest) -> Result<(), String> + ?Sized,
{
    let batch: TaskUpdateBatchInput = serde_json::from_value(arguments)
        .map_err(|error| format!("invalid task update arguments: {error}"))?;
    if batch.updates.is_empty() || batch.updates.len() > 50 {
        return Err("task update requires between 1 and 50 updates".to_owned());
    }
    let mut ids = HashSet::new();
    if batch
        .updates
        .iter()
        .any(|update| !ids.insert(&update.task_id))
    {
        return Err("task update cannot update the same task twice in one call".to_owned());
    }

    let call_ref = safe_ref(call_id);
    let mut commands = Vec::with_capacity(batch.updates.len());
    let mut receipts = Vec::with_capacity(batch.updates.len());
    for (index, update) in batch.updates.into_iter().enumerate() {
        let record = state
            .tasks()
            .get(&PersistenceRecordId(update.task_id.clone()))
            .map_err(|error| format!("task lookup failed: {error:?}"))?
            .ok_or_else(|| format!("task not found: {}", update.task_id))?;
        if record.revision_id.0 != update.expected_revision {
            return Err(format!("task revision conflict for {}", update.task_id));
        }
        let current = decode_task_storage_record(&record.payload.bytes)
            .map_err(|error| format!("task decode failed: {}", error.reason))?;
        if current.project_id != project_id {
            return Err(format!(
                "task belongs to another project: {}",
                update.task_id
            ));
        }

        let mut context_refs = update
            .required_context_refs
            .unwrap_or(current.required_context_refs);
        context_refs.push(format!("conversation:{conversation_id}"));
        context_refs.push(format!("provider-turn:{turn_id}"));
        context_refs.sort();
        context_refs.dedup();
        let allowed_actions = update.allowed_actions.map_or_else(
            || {
                Ok(current
                    .allowed_actions
                    .iter()
                    .map(TaskActionType::from)
                    .collect())
            },
            |actions| {
                actions
                    .iter()
                    .map(|action| parse_action_type(action))
                    .collect::<Result<Vec<_>, _>>()
            },
        )?;
        let command_id = format!("command:agent-chat-update:{call_ref}:{}", index + 1);
        let client_id = ClientId(format!("client:agent-chat:{conversation_id}"));
        let title = update
            .title
            .as_ref()
            .map(|title| title.trim().to_owned())
            .unwrap_or_else(|| current.title.clone());
        commands.push(ServerControlRequest {
            id: ServerControlRequestId(format!("request:{command_id}")),
            client_id: client_id.clone(),
            kind: ServerControlRequestKind::Command(ServerCommand {
                id: ServerCommandId(command_id),
                client_id,
                kind: ServerCommandKind::Task(TaskCommand::Update(TaskUpdateCommand {
                    task_id: nucleus_tasks::TaskId(update.task_id.clone()),
                    expected_revision: Some(RevisionId(update.expected_revision)),
                    changes: TaskUpdateChanges {
                        title: update.title.map(|value| value.trim().to_owned()),
                        description: update
                            .description
                            .map(|value| Some(value.trim().to_owned())),
                        acceptance_criteria: update.acceptance_criteria.map(|criteria| {
                            criteria
                                .into_iter()
                                .map(|text| AcceptanceCriterion {
                                    text: text.trim().to_owned(),
                                    required: true,
                                })
                                .collect()
                        }),
                        importance: update
                            .importance
                            .as_deref()
                            .map(parse_importance)
                            .transpose()?,
                        action_type: update
                            .action_type
                            .as_deref()
                            .map(parse_action_type)
                            .transpose()?,
                        activity: None,
                        agent_readiness: Some(AgentReadiness {
                            ready_for_agent: update.ready_for_agent.unwrap_or(current.agent_ready),
                            required_context_refs: context_refs,
                            allowed_actions,
                            stop_conditions: update
                                .stop_conditions
                                .unwrap_or(current.stop_conditions),
                            validation_commands: update
                                .validation_commands
                                .unwrap_or(current.validation_commands),
                        }),
                    },
                })),
            }),
        });
        receipts.push(TaskCreationReceipt {
            task_id: update.task_id,
            title,
            activity: activity_label(&current.activity).to_owned(),
        });
    }

    for request in commands {
        execute(request)?;
    }
    Ok(TaskAuthoringReceipt {
        created: Vec::new(),
        updated: receipts,
        goals_created: Vec::new(),
        goals_updated: Vec::new(),
    })
}

fn activity_label(activity: &nucleus_tasks::TaskStorageActivityState) -> &'static str {
    use nucleus_tasks::TaskStorageActivityState::*;
    match activity {
        Proposed => "proposed",
        Ready => "ready",
        Active => "active",
        Blocked { .. } => "blocked",
        Done => "done",
        Archived => "archived",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{seed_local_project, seed_local_task, LocalProjectSeed, LocalTaskSeed};
    use nucleus_local_store::SqliteBackend;
    use serde_json::json;

    #[test]
    fn update_builds_revision_safe_intent_command_with_provenance() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("state.sqlite")));
        seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("project");
        seed_local_task(&state, LocalTaskSeed::nucleus_local_bootstrap()).expect("task");
        let revision = state
            .tasks()
            .get(&PersistenceRecordId(
                "task:nucleus-local:bootstrap".to_owned(),
            ))
            .expect("lookup")
            .expect("task")
            .revision_id
            .0;
        let mut captured = Vec::new();

        let receipt = update_tasks(
            &state,
            "project:nucleus-local",
            "conversation:1",
            "turn:1",
            "call:1",
            json!({
                "updates": [{
                    "task_id": "task:nucleus-local:bootstrap",
                    "expected_revision": revision,
                    "title": "Refined task",
                    "acceptance_criteria": ["Refinement is visible"],
                    "ready_for_agent": true
                }]
            }),
            &mut |request| {
                captured.push(request);
                Ok(())
            },
        )
        .expect("update");

        assert_eq!(receipt.updated.len(), 1);
        let ServerControlRequestKind::Command(command) = &captured[0].kind else {
            panic!("expected command");
        };
        let ServerCommandKind::Task(TaskCommand::Update(update)) = &command.kind else {
            panic!("expected task update");
        };
        assert!(update.changes.activity.is_none());
        let readiness = update.changes.agent_readiness.as_ref().expect("readiness");
        assert!(readiness.ready_for_agent);
        assert!(readiness
            .required_context_refs
            .contains(&"conversation:conversation:1".to_owned()));
        assert!(readiness
            .required_context_refs
            .contains(&"provider-turn:turn:1".to_owned()));
    }

    #[test]
    fn stale_update_is_rejected_before_any_command_runs() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("state.sqlite")));
        seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("project");
        seed_local_task(&state, LocalTaskSeed::nucleus_local_bootstrap()).expect("task");
        let mut executed = 0;

        let error = update_tasks(
            &state,
            "project:nucleus-local",
            "conversation:1",
            "turn:1",
            "call:1",
            json!({
                "updates": [{
                    "task_id": "task:nucleus-local:bootstrap",
                    "expected_revision": "rev:stale",
                    "title": "Must not apply"
                }]
            }),
            &mut |_| {
                executed += 1;
                Ok(())
            },
        )
        .expect_err("stale update");

        assert!(error.contains("revision conflict"));
        assert_eq!(executed, 0);
    }
}
