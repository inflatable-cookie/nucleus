use nucleus_projects::ProjectId;
use nucleus_tasks::{
    AcceptanceCriterion, AgentReadiness, TaskActionType, TaskActivityState, TaskImportance,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::commands::{ServerCommand, ServerCommandKind, TaskCommand, TaskCreateCommand};
use crate::control_api::{ServerControlRequest, ServerControlRequestKind};
use crate::ids::{ClientId, ServerCommandId, ServerControlRequestId};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TaskCreationReceipt {
    pub task_id: String,
    pub title: String,
    pub activity: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GoalCreationReceipt {
    pub goal_id: String,
    pub title: String,
    pub status: String,
    pub revision_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TaskAuthoringReceipt {
    #[serde(default)]
    pub created: Vec<TaskCreationReceipt>,
    #[serde(default)]
    pub updated: Vec<TaskCreationReceipt>,
    #[serde(default)]
    pub goals_created: Vec<GoalCreationReceipt>,
    #[serde(default)]
    pub goals_updated: Vec<GoalCreationReceipt>,
}

pub(super) struct TaskToolOutcome {
    pub text: String,
    pub receipt: Option<TaskAuthoringReceipt>,
}

impl TaskToolOutcome {
    pub(super) fn from_receipt(receipt: TaskAuthoringReceipt) -> Result<Self, String> {
        Ok(Self {
            text: serde_json::to_string(&receipt)
                .map_err(|error| format!("failed to encode task receipt: {error}"))?,
            receipt: Some(receipt),
        })
    }

    pub(super) fn text(text: String) -> Self {
        Self {
            text,
            receipt: None,
        }
    }
}

#[derive(Debug, Deserialize)]
struct TaskBatchInput {
    tasks: Vec<TaskInput>,
}

#[derive(Debug, Deserialize)]
struct TaskInput {
    title: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    acceptance_criteria: Vec<String>,
    #[serde(default = "normal_importance")]
    importance: String,
    #[serde(default = "execute_action")]
    action_type: String,
    #[serde(default)]
    ready_for_agent: bool,
    #[serde(default)]
    dependency_task_refs: Vec<String>,
    #[serde(default)]
    required_context_refs: Vec<String>,
    #[serde(default)]
    allowed_actions: Vec<String>,
    #[serde(default)]
    stop_conditions: Vec<String>,
    #[serde(default)]
    validation_commands: Vec<String>,
}

pub(super) fn execute_task_batch<F>(
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
    let batch: TaskBatchInput = serde_json::from_value(arguments)
        .map_err(|error| format!("invalid task creation arguments: {error}"))?;
    if batch.tasks.is_empty() {
        return Err("task creation requires at least one task".to_owned());
    }
    if batch.tasks.len() > 50 {
        return Err("task creation accepts at most 50 tasks per call".to_owned());
    }

    let call_ref = safe_ref(call_id);
    let mut commands = Vec::with_capacity(batch.tasks.len());
    let mut receipts = Vec::with_capacity(batch.tasks.len());
    for (index, task) in batch.tasks.into_iter().enumerate() {
        let command_id = format!("command:agent-chat:{call_ref}:{}", index + 1);
        let action_type = parse_action_type(&task.action_type)?;
        let activity = if task.ready_for_agent {
            TaskActivityState::Ready
        } else {
            TaskActivityState::Proposed
        };
        let activity_label = if task.ready_for_agent {
            "ready"
        } else {
            "proposed"
        };
        let mut context_refs = task.required_context_refs;
        context_refs.extend(task.dependency_task_refs);
        context_refs.push(format!("conversation:{conversation_id}"));
        context_refs.push(format!("provider-turn:{turn_id}"));
        context_refs.sort();
        context_refs.dedup();
        let allowed_actions = if task.allowed_actions.is_empty() {
            vec![action_type.clone()]
        } else {
            task.allowed_actions
                .iter()
                .map(|action| parse_action_type(action))
                .collect::<Result<Vec<_>, _>>()?
        };
        let title = task.title.trim().to_owned();
        let request = ServerControlRequest {
            id: ServerControlRequestId(format!("request:{command_id}")),
            client_id: ClientId(format!("client:agent-chat:{conversation_id}")),
            kind: ServerControlRequestKind::Command(ServerCommand {
                id: ServerCommandId(command_id.clone()),
                client_id: ClientId(format!("client:agent-chat:{conversation_id}")),
                kind: ServerCommandKind::Task(TaskCommand::Create(TaskCreateCommand {
                    project_id: ProjectId(project_id.to_owned()),
                    title: title.clone(),
                    description: task.description.map(|value| value.trim().to_owned()),
                    acceptance_criteria: task
                        .acceptance_criteria
                        .into_iter()
                        .map(|text| AcceptanceCriterion {
                            text: text.trim().to_owned(),
                            required: true,
                        })
                        .collect(),
                    importance: parse_importance(&task.importance)?,
                    action_type,
                    activity,
                    agent_readiness: AgentReadiness {
                        ready_for_agent: task.ready_for_agent,
                        required_context_refs: context_refs,
                        allowed_actions,
                        stop_conditions: task.stop_conditions,
                        validation_commands: task.validation_commands,
                    },
                })),
            }),
        };
        commands.push(request);
        receipts.push(TaskCreationReceipt {
            task_id: format!("task:{command_id}"),
            title,
            activity: activity_label.to_owned(),
        });
    }

    for request in commands {
        execute(request)?;
    }
    Ok(TaskAuthoringReceipt {
        created: receipts,
        updated: Vec::new(),
        goals_created: Vec::new(),
        goals_updated: Vec::new(),
    })
}

pub(super) fn parse_importance(value: &str) -> Result<TaskImportance, String> {
    match value {
        "low" => Ok(TaskImportance::Low),
        "normal" => Ok(TaskImportance::Normal),
        "high" => Ok(TaskImportance::High),
        "critical" => Ok(TaskImportance::Critical),
        _ => Err(format!("unsupported task importance: {value}")),
    }
}

pub(super) fn parse_action_type(value: &str) -> Result<TaskActionType, String> {
    match value {
        "research" => Ok(TaskActionType::Research),
        "plan" => Ok(TaskActionType::Plan),
        "execute" => Ok(TaskActionType::Execute),
        "test" => Ok(TaskActionType::Test),
        "check" => Ok(TaskActionType::Check),
        "review" => Ok(TaskActionType::Review),
        _ => Err(format!("unsupported task action type: {value}")),
    }
}

pub(super) fn safe_ref(value: &str) -> String {
    value
        .chars()
        .take(80)
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect()
}

fn normal_importance() -> String {
    "normal".to_owned()
}

fn execute_action() -> String {
    "execute".to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn task_batch_builds_rich_server_commands_with_chat_provenance() {
        let mut captured = Vec::new();
        let receipt = execute_task_batch(
            "project:1",
            "project:1:panel:chat",
            "turn:1",
            "call/1",
            json!({
                "tasks": [{
                    "title": "Build the first slice",
                    "description": "Implement the smallest useful vertical slice.",
                    "acceptance_criteria": ["The slice is usable"],
                    "importance": "high",
                    "action_type": "execute",
                    "ready_for_agent": true,
                    "dependency_task_refs": ["task:foundation"],
                    "required_context_refs": ["docs/contracts/005-task-contract.md"],
                    "allowed_actions": ["execute", "test"],
                    "stop_conditions": ["Stop if the contract is ambiguous"],
                    "validation_commands": ["effigy qa"]
                }]
            }),
            &mut |request| {
                captured.push(request);
                Ok(())
            },
        )
        .expect("author task");

        assert_eq!(receipt.created.len(), 1);
        assert_eq!(receipt.created[0].activity, "ready");
        assert_eq!(captured.len(), 1);
        let ServerControlRequestKind::Command(command) = &captured[0].kind else {
            panic!("expected command");
        };
        let ServerCommandKind::Task(TaskCommand::Create(task)) = &command.kind else {
            panic!("expected task create");
        };
        assert_eq!(task.title, "Build the first slice");
        assert_eq!(task.activity, TaskActivityState::Ready);
        assert!(task
            .agent_readiness
            .required_context_refs
            .contains(&"conversation:project:1:panel:chat".to_owned()));
        assert!(task
            .agent_readiness
            .required_context_refs
            .contains(&"provider-turn:turn:1".to_owned()));
        assert!(task
            .agent_readiness
            .required_context_refs
            .contains(&"task:foundation".to_owned()));
    }

    #[test]
    fn task_batch_is_fully_validated_before_any_command_runs() {
        let mut executed = 0;
        let error = execute_task_batch(
            "project:1",
            "conversation:1",
            "turn:1",
            "call:1",
            json!({
                "tasks": [
                    { "title": "Valid", "action_type": "plan" },
                    { "title": "Invalid", "action_type": "invent" }
                ]
            }),
            &mut |_| {
                executed += 1;
                Ok(())
            },
        )
        .expect_err("invalid batch");

        assert!(error.contains("unsupported task action type"));
        assert_eq!(executed, 0);
    }
}
