//! JSON storage codec for first task records.

use serde::{Deserialize, Serialize};

use crate::{
    AcceptanceCriterion, AssignmentState, Task, TaskActionType, TaskActivityState, TaskImportance,
};

/// Display-ready task record stored as server-owned JSON payload.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TaskStorageRecord {
    pub task_id: String,
    pub project_id: String,
    pub title: String,
    pub description: Option<String>,
    pub acceptance_criteria: Vec<TaskStorageAcceptanceCriterion>,
    pub importance: TaskStorageImportance,
    pub action_type: TaskStorageActionType,
    pub activity: TaskStorageActivityState,
    pub assignment_intent: Option<String>,
    pub agent_ready: bool,
}

/// Serializable task acceptance criterion.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TaskStorageAcceptanceCriterion {
    pub text: String,
    pub required: bool,
}

/// Serializable task importance.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStorageImportance {
    Low,
    Normal,
    High,
    Critical,
}

/// Serializable task action type.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStorageActionType {
    Research,
    Plan,
    Execute,
    Test,
    Check,
    Review,
}

/// Serializable task activity state.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStorageActivityState {
    Proposed,
    Ready,
    Active,
    Blocked { reason: String },
    Done,
    Archived,
}

/// Task record codec error.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskRecordCodecError {
    pub reason: String,
}

impl From<&Task> for TaskStorageRecord {
    fn from(task: &Task) -> Self {
        Self {
            task_id: task.id.0.clone(),
            project_id: task.project_id.0.clone(),
            title: task.title.clone(),
            description: task.description.clone(),
            acceptance_criteria: task
                .acceptance_criteria
                .iter()
                .map(TaskStorageAcceptanceCriterion::from)
                .collect(),
            importance: TaskStorageImportance::from(&task.importance),
            action_type: TaskStorageActionType::from(&task.action_type),
            activity: TaskStorageActivityState::from(&task.activity),
            assignment_intent: assignment_intent(&task.assignment),
            agent_ready: task.agent_readiness.ready_for_agent,
        }
    }
}

impl From<&AcceptanceCriterion> for TaskStorageAcceptanceCriterion {
    fn from(criterion: &AcceptanceCriterion) -> Self {
        Self {
            text: criterion.text.clone(),
            required: criterion.required,
        }
    }
}

impl From<&TaskImportance> for TaskStorageImportance {
    fn from(importance: &TaskImportance) -> Self {
        match importance {
            TaskImportance::Low => Self::Low,
            TaskImportance::Normal => Self::Normal,
            TaskImportance::High => Self::High,
            TaskImportance::Critical => Self::Critical,
        }
    }
}

impl From<&TaskActionType> for TaskStorageActionType {
    fn from(action_type: &TaskActionType) -> Self {
        match action_type {
            TaskActionType::Research => Self::Research,
            TaskActionType::Plan => Self::Plan,
            TaskActionType::Execute => Self::Execute,
            TaskActionType::Test => Self::Test,
            TaskActionType::Check => Self::Check,
            TaskActionType::Review => Self::Review,
        }
    }
}

impl From<&TaskActivityState> for TaskStorageActivityState {
    fn from(activity: &TaskActivityState) -> Self {
        match activity {
            TaskActivityState::Proposed => Self::Proposed,
            TaskActivityState::Ready => Self::Ready,
            TaskActivityState::Active => Self::Active,
            TaskActivityState::Blocked(reason) => Self::Blocked {
                reason: reason.clone(),
            },
            TaskActivityState::Done => Self::Done,
            TaskActivityState::Archived => Self::Archived,
        }
    }
}

/// Encode a task into the first JSON storage payload.
pub fn encode_task_storage_record(task: &Task) -> Result<Vec<u8>, TaskRecordCodecError> {
    serde_json::to_vec(&TaskStorageRecord::from(task)).map_err(codec_error)
}

/// Decode the first JSON storage payload into a display-ready record.
pub fn decode_task_storage_record(bytes: &[u8]) -> Result<TaskStorageRecord, TaskRecordCodecError> {
    serde_json::from_slice(bytes).map_err(codec_error)
}

fn assignment_intent(assignment: &AssignmentState) -> Option<String> {
    match assignment {
        AssignmentState::Unassigned => None,
        AssignmentState::Human(name) => Some(format!("human:{name}")),
        AssignmentState::Agent(name) => Some(format!("agent:{name}")),
        AssignmentState::Mixed(names) => Some(format!("mixed:{}", names.join(","))),
    }
}

fn codec_error(error: serde_json::Error) -> TaskRecordCodecError {
    TaskRecordCodecError {
        reason: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use nucleus_projects::ProjectId;

    use crate::{
        AcceptanceCriterion, AgentReadiness, AssignmentState, NeglectLevel, NeglectSignal, Task,
        TaskActionType, TaskActivityState, TaskId, TaskImportance, TaskTimestamps,
    };

    use super::*;

    #[test]
    fn task_storage_codec_preserves_display_fields() {
        let task = Task {
            id: TaskId("task:nucleus:1".to_owned()),
            project_id: ProjectId("project:nucleus".to_owned()),
            title: "Compile task codec".to_owned(),
            description: Some("Make task records display-ready.".to_owned()),
            acceptance_criteria: vec![AcceptanceCriterion {
                text: "Task id is preserved".to_owned(),
                required: true,
            }],
            importance: TaskImportance::High,
            neglect: NeglectSignal {
                level: NeglectLevel::Fresh,
                last_addressed_at: None,
                note: None,
            },
            action_type: TaskActionType::Execute,
            assignment: AssignmentState::Agent("steward".to_owned()),
            activity: TaskActivityState::Ready,
            agent_readiness: AgentReadiness {
                ready_for_agent: true,
                required_context_refs: Vec::new(),
                allowed_actions: vec![TaskActionType::Execute],
                stop_conditions: Vec::new(),
                validation_commands: Vec::new(),
            },
            assignment_plan: None,
            assignment_snapshot: None,
            history: Vec::new(),
            model_preferences: None,
            timestamps: TaskTimestamps {
                created_at: None,
                updated_at: None,
                started_at: None,
                completed_at: None,
            },
        };

        let bytes = encode_task_storage_record(&task).expect("encode task");
        let decoded = decode_task_storage_record(&bytes).expect("decode task");

        assert_eq!(decoded.task_id, "task:nucleus:1");
        assert_eq!(decoded.project_id, "project:nucleus");
        assert_eq!(decoded.title, "Compile task codec");
        assert_eq!(decoded.importance, TaskStorageImportance::High);
        assert_eq!(decoded.action_type, TaskStorageActionType::Execute);
        assert_eq!(decoded.activity, TaskStorageActivityState::Ready);
        assert_eq!(decoded.assignment_intent, Some("agent:steward".to_owned()));
        assert!(decoded.agent_ready);
    }
}
