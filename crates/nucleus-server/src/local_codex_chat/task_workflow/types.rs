//! Task workflow wire types: receipt status, receipt, and portal input.
//!
//! Split from the task_workflow god file; behavior unchanged.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskWorkflowReceiptStatus {
    ReviewReady,
    Blocked,
    Stopped,
    RecoveryRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TaskWorkflowReceipt {
    pub status: TaskWorkflowReceiptStatus,
    pub scope_kind: String,
    pub project_id: String,
    pub goal_id: Option<String>,
    pub task_id: Option<String>,
    pub title: String,
    pub current_task_id: Option<String>,
    pub current_position: usize,
    pub total_tasks: usize,
    pub summary: String,
    pub mandate_id: String,
    pub plan_id: Option<String>,
    pub work_item_refs: Vec<String>,
    pub runtime_receipt_refs: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct TaskWorkflowInput {
    pub(super) action: String,
    pub(super) scope: String,
    #[serde(default)]
    pub(super) task_id: Option<String>,
    #[serde(default)]
    pub(super) goal_id: Option<String>,
    #[serde(default)]
    pub(super) expected_revision: Option<String>,
    #[serde(default)]
    pub(super) operator_message_excerpt: Option<String>,
    #[serde(default)]
    pub(super) idempotency_key: Option<String>,
}
