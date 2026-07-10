use std::collections::HashSet;

use nucleus_core::RevisionId;
use nucleus_local_store::LocalStoreBackend;
use nucleus_planning::PlanningGoalId;
use nucleus_tasks::TaskId;
use serde::Deserialize;
use serde_json::Value;

use super::goal_inspection::goal_record;
use super::task_authoring::{safe_ref, GoalCreationReceipt, TaskAuthoringReceipt};
use crate::commands::{
    GoalCommand, GoalUpdateChanges, GoalUpdateCommand, ServerCommand, ServerCommandKind,
};
use crate::control_api::{ServerControlRequest, ServerControlRequestKind};
use crate::ids::{ClientId, ServerCommandId, ServerControlRequestId};
use crate::ServerStateService;

#[derive(Debug, Deserialize)]
struct GoalUpdateBatchInput {
    updates: Vec<GoalUpdateInput>,
}

#[derive(Debug, Deserialize)]
struct GoalUpdateInput {
    goal_id: String,
    expected_revision: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    desired_outcome: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    owner_refs: Option<Vec<String>>,
    #[serde(default)]
    ordered_task_refs: Option<Vec<String>>,
    #[serde(default)]
    planning_artifact_refs: Option<Vec<String>>,
    #[serde(default)]
    stop_conditions: Option<Vec<String>>,
    #[serde(default)]
    evidence_refs: Option<Vec<String>>,
    #[serde(default)]
    current_next_task_ref: Option<String>,
    #[serde(default)]
    next_action: Option<String>,
}

pub(super) fn update_goals<B, F>(
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
    let batch: GoalUpdateBatchInput = serde_json::from_value(arguments)
        .map_err(|error| format!("invalid goal update arguments: {error}"))?;
    if batch.updates.is_empty() {
        return Err("goal update requires at least one update".to_owned());
    }
    if batch.updates.len() > 10 {
        return Err("goal update accepts at most 10 goals per call".to_owned());
    }
    let call_ref = safe_ref(call_id);
    let mut requests = Vec::with_capacity(batch.updates.len());
    let mut receipts = Vec::with_capacity(batch.updates.len());
    for (index, input) in batch.updates.into_iter().enumerate() {
        let current = goal_record(state, project_id, &input.goal_id)?;
        if current.revision_id != input.expected_revision {
            return Err(format!("goal revision conflict for {}", input.goal_id));
        }
        let command_id = format!("command:agent-chat-goal-update:{call_ref}:{}", index + 1);
        let mut provenance_refs = current.provenance_refs;
        provenance_refs.push(format!("conversation:{conversation_id}"));
        provenance_refs.push(format!("provider-turn:{turn_id}"));
        provenance_refs.sort();
        provenance_refs.dedup();
        let title = input
            .title
            .as_deref()
            .map(str::trim)
            .unwrap_or(&current.title)
            .to_owned();
        requests.push(goal_update_request(
            conversation_id,
            &command_id,
            input.goal_id.clone(),
            input.expected_revision,
            GoalUpdateChanges {
                title: input.title.map(|value| value.trim().to_owned()),
                desired_outcome: input.desired_outcome.map(|value| value.trim().to_owned()),
                scope: input.scope.map(|value| value.trim().to_owned()),
                owner_refs: input.owner_refs,
                ordered_task_refs: input
                    .ordered_task_refs
                    .map(|refs| refs.into_iter().map(TaskId).collect()),
                planning_artifact_refs: input.planning_artifact_refs,
                provenance_refs: Some(provenance_refs),
                stop_conditions: input.stop_conditions,
                evidence_refs: input.evidence_refs,
                current_next_task_ref: input.current_next_task_ref.map(|value| Some(TaskId(value))),
                next_action: input.next_action.map(Some),
            },
        ));
        receipts.push(GoalCreationReceipt {
            goal_id: input.goal_id,
            title,
            status: current.status,
            revision_id: format!("rev:goal-update:{command_id}"),
        });
    }
    for request in requests {
        execute(request)?;
    }
    Ok(TaskAuthoringReceipt {
        created: Vec::new(),
        updated: Vec::new(),
        goals_created: Vec::new(),
        goals_updated: receipts,
    })
}

pub(super) fn prepare_task_membership_append<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    conversation_id: &str,
    turn_id: &str,
    call_id: &str,
    goal_id: &str,
    expected_revision: &str,
    task_ids: &[String],
) -> Result<(ServerControlRequest, GoalCreationReceipt), String>
where
    B: LocalStoreBackend,
{
    let current = goal_record(state, project_id, goal_id)?;
    if current.revision_id != expected_revision {
        return Err(format!("goal revision conflict for {goal_id}"));
    }
    let mut ordered = current.ordered_task_refs.clone();
    ordered.extend(task_ids.iter().cloned());
    if ordered.len() > nucleus_planning::MAX_GOAL_TASKS {
        return Err(format!(
            "goal task membership exceeds {} tasks",
            nucleus_planning::MAX_GOAL_TASKS
        ));
    }
    let mut seen = HashSet::new();
    if let Some(duplicate) = ordered
        .iter()
        .find(|task_id| !seen.insert(task_id.as_str()))
    {
        return Err(format!("goal contains duplicate task ref: {duplicate}"));
    }
    let mut provenance_refs = current.provenance_refs.clone();
    provenance_refs.push(format!("conversation:{conversation_id}"));
    provenance_refs.push(format!("provider-turn:{turn_id}"));
    provenance_refs.sort();
    provenance_refs.dedup();
    let command_id = format!("command:agent-chat-goal-link:{}", safe_ref(call_id));
    let request = goal_update_request(
        conversation_id,
        &command_id,
        goal_id.to_owned(),
        expected_revision.to_owned(),
        GoalUpdateChanges {
            ordered_task_refs: Some(ordered.into_iter().map(TaskId).collect()),
            provenance_refs: Some(provenance_refs),
            current_next_task_ref: if current.current_next_task_ref.is_none() {
                task_ids
                    .first()
                    .cloned()
                    .map(|task_id| Some(TaskId(task_id)))
            } else {
                None
            },
            ..GoalUpdateChanges::default()
        },
    );
    let receipt = GoalCreationReceipt {
        goal_id: goal_id.to_owned(),
        title: current.title,
        status: current.status,
        revision_id: format!("rev:goal-update:{command_id}"),
    };
    Ok((request, receipt))
}

fn goal_update_request(
    conversation_id: &str,
    command_id: &str,
    goal_id: String,
    expected_revision: String,
    changes: GoalUpdateChanges,
) -> ServerControlRequest {
    let client_id = ClientId(format!("client:agent-chat:{conversation_id}"));
    ServerControlRequest {
        id: ServerControlRequestId(format!("request:{command_id}")),
        client_id: client_id.clone(),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId(command_id.to_owned()),
            client_id,
            kind: ServerCommandKind::Goal(GoalCommand::Update(GoalUpdateCommand {
                goal_id: PlanningGoalId(goal_id),
                expected_revision: RevisionId(expected_revision),
                changes,
            })),
        }),
    }
}
