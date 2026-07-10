use nucleus_planning::GoalStatus;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;
use serde::Deserialize;
use serde_json::Value;

use super::task_authoring::{safe_ref, GoalCreationReceipt, TaskAuthoringReceipt};
use crate::commands::{GoalCommand, GoalCreateCommand, ServerCommand, ServerCommandKind};
use crate::control_api::{ServerControlRequest, ServerControlRequestKind};
use crate::ids::{ClientId, ServerCommandId, ServerControlRequestId};

#[derive(Debug, Deserialize)]
struct GoalBatchInput {
    goals: Vec<GoalInput>,
}

#[derive(Debug, Deserialize)]
struct GoalInput {
    title: String,
    desired_outcome: String,
    scope: String,
    #[serde(default = "proposed_status")]
    status: String,
    #[serde(default)]
    owner_refs: Vec<String>,
    #[serde(default)]
    ordered_task_refs: Vec<String>,
    #[serde(default)]
    planning_artifact_refs: Vec<String>,
    #[serde(default)]
    stop_conditions: Vec<String>,
    #[serde(default)]
    evidence_refs: Vec<String>,
    #[serde(default)]
    current_next_task_ref: Option<String>,
    #[serde(default)]
    next_action: Option<String>,
}

pub(super) fn create_goals<F>(
    project_id: &str,
    conversation_id: &str,
    turn_id: &str,
    call_id: &str,
    arguments: Value,
    execute: &mut F,
) -> Result<TaskAuthoringReceipt, String>
where
    F: FnMut(ServerControlRequest) -> Result<(), String> + ?Sized,
{
    let batch: GoalBatchInput = serde_json::from_value(arguments)
        .map_err(|error| format!("invalid goal creation arguments: {error}"))?;
    if batch.goals.is_empty() {
        return Err("goal creation requires at least one goal".to_owned());
    }
    if batch.goals.len() > 10 {
        return Err("goal creation accepts at most 10 goals per call".to_owned());
    }

    let call_ref = safe_ref(call_id);
    let mut commands = Vec::with_capacity(batch.goals.len());
    let mut receipts = Vec::with_capacity(batch.goals.len());
    for (index, input) in batch.goals.into_iter().enumerate() {
        let command_id = format!("command:agent-chat-goal:{call_ref}:{}", index + 1);
        let status = parse_goal_status(&input.status)?;
        let status_label = input.status;
        let title = input.title.trim().to_owned();
        let client_id = ClientId(format!("client:agent-chat:{conversation_id}"));
        let mut owner_refs = input.owner_refs;
        if owner_refs.is_empty() {
            owner_refs.push(client_id.0.clone());
        }
        let mut provenance_refs = vec![
            format!("conversation:{conversation_id}"),
            format!("provider-turn:{turn_id}"),
        ];
        provenance_refs.sort();
        commands.push(ServerControlRequest {
            id: ServerControlRequestId(format!("request:{command_id}")),
            client_id: client_id.clone(),
            kind: ServerControlRequestKind::Command(ServerCommand {
                id: ServerCommandId(command_id.clone()),
                client_id,
                kind: ServerCommandKind::Goal(GoalCommand::Create(GoalCreateCommand {
                    project_id: ProjectId(project_id.to_owned()),
                    title: title.clone(),
                    desired_outcome: input.desired_outcome.trim().to_owned(),
                    scope: input.scope.trim().to_owned(),
                    status,
                    owner_refs,
                    ordered_task_refs: input.ordered_task_refs.into_iter().map(TaskId).collect(),
                    planning_artifact_refs: input.planning_artifact_refs,
                    provenance_refs,
                    stop_conditions: input.stop_conditions,
                    evidence_refs: input.evidence_refs,
                    current_next_task_ref: input.current_next_task_ref.map(TaskId),
                    next_action: input.next_action,
                })),
            }),
        });
        receipts.push(GoalCreationReceipt {
            goal_id: format!("goal:{command_id}"),
            title,
            status: status_label,
            revision_id: format!("rev:goal-create:{command_id}"),
        });
    }
    for request in commands {
        execute(request)?;
    }
    Ok(TaskAuthoringReceipt {
        created: Vec::new(),
        updated: Vec::new(),
        goals_created: receipts,
        goals_updated: Vec::new(),
    })
}

fn parse_goal_status(value: &str) -> Result<GoalStatus, String> {
    match value {
        "proposed" => Ok(GoalStatus::Proposed),
        "ready" => Ok(GoalStatus::Ready),
        _ => Err(format!("unsupported goal authoring status: {value}")),
    }
}

fn proposed_status() -> String {
    "proposed".to_owned()
}
