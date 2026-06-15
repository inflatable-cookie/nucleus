//! Task history and agent attempt audit records.

use std::time::SystemTime;

use nucleus_agent_protocol::AgentSessionId;

use crate::assignment::{TaskAssignmentSnapshot, TaskAssignmentTarget};
use crate::TaskId;

/// Durable task history entry.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskHistoryEntry {
    pub entry_id: TaskHistoryEntryId,
    pub task_id: TaskId,
    pub occurred_at: Option<SystemTime>,
    pub actor: TaskHistoryActor,
    pub event: TaskHistoryEvent,
    pub note: Option<String>,
}

/// Stable task history entry id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct TaskHistoryEntryId(pub String);

/// Actor associated with a task history entry.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TaskHistoryActor {
    Human(String),
    Agent(String),
    System,
    Mixed(Vec<String>),
}

/// Durable task history event.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TaskHistoryEvent {
    Created,
    Updated,
    AssignmentChanged(TaskAssignmentSnapshot),
    AgentAttemptStarted(AgentAttemptRecord),
    AgentAttemptInterrupted(AgentAttemptSummary),
    AgentAttemptFailed(AgentAttemptSummary),
    AgentAttemptCompleted(AgentAttemptSummary),
    Handoff(TaskHandoffRecord),
    ValidationRecorded(TaskValidationRecord),
    Blocked(String),
    Released,
}

/// Agent attempt record before execution detail exists.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentAttemptRecord {
    pub attempt_id: AgentAttemptId,
    pub assignment_target: TaskAssignmentTarget,
    pub adapter_instance_ref: String,
    pub route_ref: Option<String>,
    pub session_id: Option<AgentSessionId>,
    pub runtime_event_refs: Vec<String>,
}

/// Stable agent attempt id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct AgentAttemptId(pub String);

/// Summary of an agent attempt outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentAttemptSummary {
    pub attempt_id: AgentAttemptId,
    pub outcome: AgentAttemptOutcome,
    pub adapter_instance_ref: String,
    pub route_ref: Option<String>,
    pub session_id: Option<AgentSessionId>,
    pub validation_refs: Vec<String>,
    pub runtime_event_refs: Vec<String>,
    pub summary: Option<String>,
}

/// Coarse agent attempt outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentAttemptOutcome {
    Interrupted,
    Failed,
    Completed,
    Reassigned,
    Abandoned,
}

/// Handoff record between humans and/or agents.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskHandoffRecord {
    pub from: TaskHistoryActor,
    pub to: TaskHistoryActor,
    pub reason: Option<String>,
    pub context_refs: Vec<String>,
}

/// Validation evidence attached to a task.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskValidationRecord {
    pub validation_id: String,
    pub command: Option<String>,
    pub status: TaskValidationStatus,
    pub evidence_refs: Vec<String>,
    pub summary: Option<String>,
}

/// Validation outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TaskValidationStatus {
    NotRun,
    Passed,
    Failed,
    Skipped(String),
    Unknown,
}
