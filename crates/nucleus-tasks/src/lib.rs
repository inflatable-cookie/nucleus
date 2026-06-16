//! Project task model types.
//!
//! This crate names task records used for planning and agent-ready work. It
//! does not implement scoring, scheduling, assignment, or execution yet.

use std::time::SystemTime;

use nucleus_projects::ProjectId;

pub mod assignment;
pub mod history;
pub mod preferences;
pub mod projection;

pub use assignment::{
    TaskAssignmentAuditEntry, TaskAssignmentAuditEvent, TaskAssignmentPlan, TaskAssignmentSnapshot,
    TaskAssignmentStatus, TaskAssignmentTarget, TaskCapabilityRequirement,
};
pub use history::{
    AgentAttemptId, AgentAttemptOutcome, AgentAttemptRecord, AgentAttemptSummary,
    TaskHandoffRecord, TaskHistoryActor, TaskHistoryEntry, TaskHistoryEntryId, TaskHistoryEvent,
    TaskValidationRecord, TaskValidationStatus,
};
pub use preferences::{
    TaskModelPreferenceMode, TaskModelPreferences, TaskPreferenceWeight, TaskRoutePreference,
};
pub use projection::{TaskProjectionHistorySummary, TaskProjectionRecord};

/// Stable task id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct TaskId(pub String);

/// Durable task record attached to a project.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Task {
    pub id: TaskId,
    pub project_id: ProjectId,
    pub title: String,
    pub description: Option<String>,
    pub acceptance_criteria: Vec<AcceptanceCriterion>,
    pub importance: TaskImportance,
    pub neglect: NeglectSignal,
    pub action_type: TaskActionType,
    pub assignment: AssignmentState,
    pub activity: TaskActivityState,
    pub agent_readiness: AgentReadiness,
    pub assignment_plan: Option<TaskAssignmentPlan>,
    pub assignment_snapshot: Option<TaskAssignmentSnapshot>,
    pub history: Vec<TaskHistoryEntry>,
    pub model_preferences: Option<TaskModelPreferences>,
    pub timestamps: TaskTimestamps,
}

/// A checkable task acceptance condition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptanceCriterion {
    pub text: String,
    pub required: bool,
}

/// Task-level importance before scoring policy exists.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TaskImportance {
    Low,
    Normal,
    High,
    Critical,
}

/// Staleness and neglect signal for future prioritisation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NeglectSignal {
    pub level: NeglectLevel,
    pub last_addressed_at: Option<SystemTime>,
    pub note: Option<String>,
}

/// Coarse neglect level before scoring policy exists.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NeglectLevel {
    Fresh,
    Aging,
    Neglected,
    Dormant,
}

/// High-level task action taxonomy.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TaskActionType {
    Research,
    Plan,
    Execute,
    Test,
    Check,
    Review,
}

/// Who or what currently owns a task.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AssignmentState {
    Unassigned,
    Human(String),
    Agent(String),
    Mixed(Vec<String>),
}

/// Task execution/activity state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TaskActivityState {
    Proposed,
    Ready,
    Active,
    Blocked(String),
    Done,
    Archived,
}

/// Fields that make a task safe to hand to an agent.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentReadiness {
    pub ready_for_agent: bool,
    pub required_context_refs: Vec<String>,
    pub allowed_actions: Vec<TaskActionType>,
    pub stop_conditions: Vec<String>,
    pub validation_commands: Vec<String>,
}

/// Task timestamps.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskTimestamps {
    pub created_at: Option<SystemTime>,
    pub updated_at: Option<SystemTime>,
    pub started_at: Option<SystemTime>,
    pub completed_at: Option<SystemTime>,
}
