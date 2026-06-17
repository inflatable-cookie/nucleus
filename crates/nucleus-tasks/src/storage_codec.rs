//! JSON storage codec for first task records.

use serde::{Deserialize, Serialize};

use crate::{
    AcceptanceCriterion, AgentReadiness, AssignmentState, NeglectLevel, NeglectSignal, Task,
    TaskActionType, TaskActivityState, TaskId, TaskImportance, TaskTimestamps,
};
use nucleus_projects::ProjectId;

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
    #[serde(default)]
    pub required_context_refs: Vec<String>,
    #[serde(default)]
    pub allowed_actions: Vec<TaskStorageActionType>,
    #[serde(default)]
    pub stop_conditions: Vec<String>,
    #[serde(default)]
    pub validation_commands: Vec<String>,
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
            required_context_refs: task.agent_readiness.required_context_refs.clone(),
            allowed_actions: task
                .agent_readiness
                .allowed_actions
                .iter()
                .map(TaskStorageActionType::from)
                .collect(),
            stop_conditions: task.agent_readiness.stop_conditions.clone(),
            validation_commands: task.agent_readiness.validation_commands.clone(),
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

impl From<&TaskStorageAcceptanceCriterion> for AcceptanceCriterion {
    fn from(criterion: &TaskStorageAcceptanceCriterion) -> Self {
        Self {
            text: criterion.text.clone(),
            required: criterion.required,
        }
    }
}

impl From<&TaskStorageImportance> for TaskImportance {
    fn from(importance: &TaskStorageImportance) -> Self {
        match importance {
            TaskStorageImportance::Low => Self::Low,
            TaskStorageImportance::Normal => Self::Normal,
            TaskStorageImportance::High => Self::High,
            TaskStorageImportance::Critical => Self::Critical,
        }
    }
}

impl From<&TaskStorageActionType> for TaskActionType {
    fn from(action_type: &TaskStorageActionType) -> Self {
        match action_type {
            TaskStorageActionType::Research => Self::Research,
            TaskStorageActionType::Plan => Self::Plan,
            TaskStorageActionType::Execute => Self::Execute,
            TaskStorageActionType::Test => Self::Test,
            TaskStorageActionType::Check => Self::Check,
            TaskStorageActionType::Review => Self::Review,
        }
    }
}

impl From<&TaskStorageActivityState> for TaskActivityState {
    fn from(activity: &TaskStorageActivityState) -> Self {
        match activity {
            TaskStorageActivityState::Proposed => Self::Proposed,
            TaskStorageActivityState::Ready => Self::Ready,
            TaskStorageActivityState::Active => Self::Active,
            TaskStorageActivityState::Blocked { reason } => Self::Blocked(reason.clone()),
            TaskStorageActivityState::Done => Self::Done,
            TaskStorageActivityState::Archived => Self::Archived,
        }
    }
}

/// Encode a task into the first JSON storage payload.
pub fn encode_task_storage_record(task: &Task) -> Result<Vec<u8>, TaskRecordCodecError> {
    serde_json::to_vec(&TaskStorageRecord::from(task)).map_err(codec_error)
}

/// Encode an already decoded task storage record.
pub fn encode_task_storage_payload(
    record: &TaskStorageRecord,
) -> Result<Vec<u8>, TaskRecordCodecError> {
    serde_json::to_vec(record).map_err(codec_error)
}

/// Decode the first JSON storage payload into a display-ready record.
pub fn decode_task_storage_record(bytes: &[u8]) -> Result<TaskStorageRecord, TaskRecordCodecError> {
    serde_json::from_slice(bytes).map_err(codec_error)
}

/// Rebuild a domain task from the create/update-safe storage projection.
///
/// Server-owned fields that are not in this storage projection are restored as
/// empty/default values. Runtime records, provider transcripts, command
/// evidence, and task history are intentionally not reconstructed here.
pub fn task_from_storage_record(record: &TaskStorageRecord) -> Task {
    let action_type = TaskActionType::from(&record.action_type);
    let allowed_actions = if record.allowed_actions.is_empty() {
        vec![action_type.clone()]
    } else {
        record
            .allowed_actions
            .iter()
            .map(TaskActionType::from)
            .collect()
    };

    Task {
        id: TaskId(record.task_id.clone()),
        project_id: ProjectId(record.project_id.clone()),
        title: record.title.clone(),
        description: record.description.clone(),
        acceptance_criteria: record
            .acceptance_criteria
            .iter()
            .map(AcceptanceCriterion::from)
            .collect(),
        importance: TaskImportance::from(&record.importance),
        neglect: NeglectSignal {
            level: NeglectLevel::Fresh,
            last_addressed_at: None,
            note: None,
        },
        action_type,
        assignment: assignment_from_intent(record.assignment_intent.as_deref()),
        activity: TaskActivityState::from(&record.activity),
        agent_readiness: AgentReadiness {
            ready_for_agent: record.agent_ready,
            required_context_refs: record.required_context_refs.clone(),
            allowed_actions,
            stop_conditions: record.stop_conditions.clone(),
            validation_commands: record.validation_commands.clone(),
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
    }
}

fn assignment_intent(assignment: &AssignmentState) -> Option<String> {
    match assignment {
        AssignmentState::Unassigned => None,
        AssignmentState::Human(name) => Some(format!("human:{name}")),
        AssignmentState::Agent(name) => Some(format!("agent:{name}")),
        AssignmentState::Mixed(names) => Some(format!("mixed:{}", names.join(","))),
    }
}

fn assignment_from_intent(intent: Option<&str>) -> AssignmentState {
    let Some(intent) = intent else {
        return AssignmentState::Unassigned;
    };

    if let Some(name) = intent.strip_prefix("human:") {
        return AssignmentState::Human(name.to_owned());
    }

    if let Some(name) = intent.strip_prefix("agent:") {
        return AssignmentState::Agent(name.to_owned());
    }

    if let Some(names) = intent.strip_prefix("mixed:") {
        return AssignmentState::Mixed(
            names
                .split(',')
                .filter(|name| !name.is_empty())
                .map(ToOwned::to_owned)
                .collect(),
        );
    }

    AssignmentState::Unassigned
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
                required_context_refs: vec!["docs/contracts/005-task-contract.md".to_owned()],
                allowed_actions: vec![TaskActionType::Execute, TaskActionType::Test],
                stop_conditions: vec!["Stop before runtime execution".to_owned()],
                validation_commands: vec!["effigy test --plan".to_owned()],
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
        assert_eq!(
            decoded.required_context_refs,
            vec!["docs/contracts/005-task-contract.md"]
        );
        assert_eq!(
            decoded.allowed_actions,
            vec![TaskStorageActionType::Execute, TaskStorageActionType::Test]
        );
        assert_eq!(
            decoded.stop_conditions,
            vec!["Stop before runtime execution"]
        );
        assert_eq!(decoded.validation_commands, vec!["effigy test --plan"]);
    }

    #[test]
    fn task_storage_record_round_trips_to_domain_task() {
        let record = TaskStorageRecord {
            task_id: "task:nucleus:round-trip".to_owned(),
            project_id: "project:nucleus".to_owned(),
            title: "Round trip editable task fields".to_owned(),
            description: Some("Rebuild the domain task from storage.".to_owned()),
            acceptance_criteria: vec![TaskStorageAcceptanceCriterion {
                text: "Readiness refs are preserved".to_owned(),
                required: true,
            }],
            importance: TaskStorageImportance::Critical,
            action_type: TaskStorageActionType::Check,
            activity: TaskStorageActivityState::Blocked {
                reason: "Waiting on contract".to_owned(),
            },
            assignment_intent: Some("mixed:tom,steward".to_owned()),
            agent_ready: true,
            required_context_refs: vec!["docs/contracts/005-task-contract.md".to_owned()],
            allowed_actions: vec![TaskStorageActionType::Check, TaskStorageActionType::Review],
            stop_conditions: vec!["Stop on conflict".to_owned()],
            validation_commands: vec!["cargo test --workspace".to_owned()],
        };

        let task = task_from_storage_record(&record);
        let encoded = encode_task_storage_record(&task).expect("encode round-tripped task");
        let decoded = decode_task_storage_record(&encoded).expect("decode round-tripped task");

        assert_eq!(task.id, TaskId("task:nucleus:round-trip".to_owned()));
        assert_eq!(task.project_id, ProjectId("project:nucleus".to_owned()));
        assert_eq!(
            task.activity,
            TaskActivityState::Blocked("Waiting on contract".to_owned())
        );
        assert_eq!(
            task.assignment,
            AssignmentState::Mixed(vec!["tom".to_owned(), "steward".to_owned()])
        );
        assert_eq!(
            task.agent_readiness.required_context_refs,
            vec!["docs/contracts/005-task-contract.md"]
        );
        assert_eq!(
            task.agent_readiness.allowed_actions,
            vec![TaskActionType::Check, TaskActionType::Review]
        );
        assert_eq!(decoded, record);
    }
}
