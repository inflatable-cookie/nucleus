//! Workflow mandate wire types: admission, task snapshot, scope, status, and
//! the durable mandate record.
//!
//! Split from the mandates god file; behavior unchanged.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkflowMandateAdmission {
    pub mandate_id: String,
    pub conversation_id: String,
    pub operator_message_id: String,
    pub operator_message_excerpt: String,
    pub project_id: String,
    pub scope: WorkflowMandateScope,
    pub idempotency_key: String,
    pub expires_at_epoch_seconds: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkflowMandateTaskSnapshot {
    pub task_id: String,
    pub revision_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkflowMandateScope {
    Goal {
        goal_id: String,
        goal_revision: String,
    },
    Task {
        task_id: String,
        task_revision: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowMandateStatus {
    Active,
    Cancelled,
    Revoked,
    Expired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkflowMandate {
    pub mandate_id: String,
    pub conversation_id: String,
    pub source_turn_id: String,
    pub operator_message_id: String,
    pub operator_message_excerpt: String,
    pub project_id: String,
    pub scope: WorkflowMandateScope,
    pub ordered_task_snapshot: Vec<WorkflowMandateTaskSnapshot>,
    pub idempotency_key: String,
    pub status: WorkflowMandateStatus,
    pub created_at_epoch_seconds: u64,
    pub expires_at_epoch_seconds: u64,
    pub terminal_reason: Option<String>,
    pub outcome_refs: Vec<String>,
    pub revision_id: String,
}
