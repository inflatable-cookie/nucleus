//! Task assignment and delegation boundary types.

use crate::{TaskActionType, TaskId};

/// Detailed assignment record for agent-ready tasks.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskAssignmentPlan {
    pub task_id: TaskId,
    pub target: TaskAssignmentTarget,
    pub required_context_refs: Vec<String>,
    pub required_capabilities: Vec<TaskCapabilityRequirement>,
    pub model_preferences: TaskModelPreferences,
    pub audit: Vec<TaskAssignmentAuditEntry>,
}

/// Assignment target requested before execution begins.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TaskAssignmentTarget {
    Human(String),
    ExplicitAgent(String),
    ExplicitAdapterInstance(String),
    BestAvailableAgent,
    Mixed(Vec<String>),
}

/// Capability requirement derived from task action and readiness.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskCapabilityRequirement {
    pub action_type: TaskActionType,
    pub capability_key: String,
    pub required: bool,
}

/// Audit entry for assignment decisions without execution logs.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskAssignmentAuditEntry {
    pub event: TaskAssignmentAuditEvent,
    pub actor_ref: Option<String>,
    pub note: Option<String>,
}

/// Assignment audit event.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TaskAssignmentAuditEvent {
    Proposed,
    Assigned,
    Reassigned,
    Interrupted,
    Released,
    Completed,
}

/// Persisted state after assignment has been decided.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskAssignmentSnapshot {
    pub task_id: TaskId,
    pub assigned_target: TaskAssignmentTarget,
    pub selected_adapter_instance_ref: Option<String>,
    pub selected_route_ref: Option<String>,
    pub selected_session_ref: Option<String>,
    pub status: TaskAssignmentStatus,
}

/// Assignment status independent of task activity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TaskAssignmentStatus {
    PendingSelection,
    Assigned,
    InProgress,
    Interrupted,
    Released,
    Complete,
}

use crate::preferences::TaskModelPreferences;
