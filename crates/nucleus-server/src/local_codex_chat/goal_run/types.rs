//! Goal run wire types: admission request, route, inspection, plan, and
//! outcome records.
//!
//! Split from the goal_run god file; behavior unchanged.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GoalRunAdmissionRequest {
    pub mandate_id: String,
    pub expected_mandate_revision: String,
    pub idempotency_key: String,
    pub now_epoch_seconds: u64,
    #[serde(default)]
    pub rework_decision_ref: Option<String>,
    #[serde(default)]
    pub rework_reason: Option<String>,
    #[serde(default)]
    pub reviewed_work_item_refs: Vec<String>,
    #[serde(default)]
    pub reviewed_evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GoalRunRoute {
    pub adapter_id: String,
    pub provider_instance_id: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GoalRunTaskInspection {
    pub task_id: String,
    pub revision_id: String,
    pub title: String,
    pub activity: String,
    pub agent_ready: bool,
    pub dependency_task_refs: Vec<String>,
    pub stop_conditions: Vec<String>,
    pub disposition: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GoalRunBlocker {
    pub scope: String,
    pub subject_ref: String,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GoalRunInspection {
    pub mandate_id: String,
    pub operator_message_id: String,
    pub project_id: String,
    pub scope_kind: String,
    pub goal_id: Option<String>,
    pub goal_revision: Option<String>,
    pub goal_status: Option<String>,
    pub goal_stop_conditions: Vec<String>,
    pub ordered_tasks: Vec<GoalRunTaskInspection>,
    pub completed_task_count: usize,
    pub remaining_task_count: usize,
    pub route: Option<GoalRunRoute>,
    pub blockers: Vec<GoalRunBlocker>,
    pub available_outcomes: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GoalRunPlanTask {
    pub ordinal: usize,
    pub task_id: String,
    pub revision_id: String,
    pub disposition: String,
    pub rework_decision_ref: Option<String>,
    pub rework_reason: Option<String>,
    pub reviewed_work_item_refs: Vec<String>,
    pub reviewed_evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GoalRunPlan {
    pub plan_id: String,
    pub mandate_id: String,
    pub mandate_revision: String,
    pub operator_message_id: String,
    pub project_id: String,
    pub scope_kind: String,
    pub goal_id: Option<String>,
    pub goal_revision: Option<String>,
    pub ordered_tasks: Vec<GoalRunPlanTask>,
    pub current_task_index: usize,
    pub first_work_item_id: String,
    pub first_work_unit_source_id: String,
    pub route: GoalRunRoute,
    pub idempotency_key: String,
    pub provider_execution_deferred: bool,
    pub revision_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum GoalRunOutcome {
    Admitted { plan: GoalRunPlan },
    Blocked { inspection: GoalRunInspection },
}
