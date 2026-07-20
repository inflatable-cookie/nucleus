use nucleus_local_store::LocalStoreBackend;
use serde::{Deserialize, Serialize};

use super::task_execution::{run_task, TaskExecutionRequest};
use crate::{ServerStateService, TaskReviewSnapshotStore};

const EXECUTION_PREFIX: &str = "goal-run-execution:";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GoalRunExecutionRequest {
    pub plan_id: String,
    pub expected_plan_revision: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalRunExecutionStatus {
    Running,
    Completed,
    Stopped,
    RecoveryRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GoalTaskDispatchRefs {
    pub command_id: String,
    pub selection_id: String,
    pub admission_id: String,
    pub preflight_id: String,
    pub invocation_request_id: String,
    pub write_attempt_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GoalTaskExecutionRecord {
    pub ordinal: usize,
    pub task_id: String,
    pub task_revision: String,
    pub work_item_id: String,
    pub status: String,
    pub dispatch: GoalTaskDispatchRefs,
    pub session_id: Option<String>,
    pub provider_thread_id: Option<String>,
    pub provider_turn_id: Option<String>,
    pub runtime_receipt_id: Option<String>,
    #[serde(default)]
    pub baseline_checkpoint_id: Option<String>,
    #[serde(default)]
    pub target_checkpoint_id: Option<String>,
    #[serde(default)]
    pub diff_summary_id: Option<String>,
    pub summary: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GoalRunExecutionRecord {
    pub execution_id: String,
    pub plan_id: String,
    pub mandate_id: String,
    pub goal_id: Option<String>,
    pub project_id: String,
    pub status: GoalRunExecutionStatus,
    pub current_task_index: usize,
    pub task_executions: Vec<GoalTaskExecutionRecord>,
    pub terminal_reason: Option<String>,
    pub provider_execution_started: bool,
    pub task_completion_permitted: bool,
    pub review_acceptance_permitted: bool,
    pub goal_achievement_permitted: bool,
    pub scm_mutation_permitted: bool,
    pub revision_id: String,
}

pub fn execute_goal_run<B>(
    state: &ServerStateService<B>,
    snapshot_store: Option<&TaskReviewSnapshotStore>,
    request: GoalRunExecutionRequest,
) -> Result<GoalRunExecutionRecord, String>
where
    B: LocalStoreBackend,
{
    execute_goal_run_for_resource(state, snapshot_store, request, None)
}

pub(super) fn execute_goal_run_for_resource<B>(
    state: &ServerStateService<B>,
    snapshot_store: Option<&TaskReviewSnapshotStore>,
    request: GoalRunExecutionRequest,
    resource_id: Option<&str>,
) -> Result<GoalRunExecutionRecord, String>
where
    B: LocalStoreBackend,
{
    execute_goal_run_with_resource(
        state,
        snapshot_store,
        request,
        resource_id,
        &mut |input, on_started| {
            run_task(
                TaskExecutionRequest {
                    session_id: &input.session_id,
                    project_root: &input.project_root,
                    route: &input.route,
                    prompt: &input.prompt,
                },
                on_started,
            )
        },
    )
}

mod dispatch;
mod outcome;
mod persistence;
mod rules;
mod run_loop;
#[cfg(test)]
mod tests_split;

use run_loop::*;
