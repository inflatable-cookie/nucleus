//! Split from the goal_execution god file; behavior unchanged.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use super::{dispatch::*, outcome::*, persistence::*, rules::*};
#[allow(unused_imports)]
use std::time::{SystemTime, UNIX_EPOCH};

use nucleus_engine::{EngineTaskAgentWorkUnitReviewStatus, EngineTaskAgentWorkUnitRuntimeStatus};
use nucleus_local_store::{LocalStoreBackend, RevisionExpectation};

use super::super::goal_run::{read_goal_run_plan, GoalRunRoute};
use super::super::review_evidence::{capture_baseline, capture_completed, TaskReviewEvidenceInput};
use super::super::task_execution::{TaskExecutionLinkage, TaskExecutionOutcome};
use super::super::task_inspection::active_task;
use crate::{ServerStateService, TaskReviewSnapshotStore};

pub(super) struct GoalTaskRunInput {
    pub(super) session_id: String,
    pub(super) project_root: String,
    pub(super) route: GoalRunRoute,
    pub(super) prompt: String,
}

#[cfg(test)]
pub(super) fn execute_goal_run_with<B, F>(
    state: &ServerStateService<B>,
    snapshot_store: Option<&TaskReviewSnapshotStore>,
    request: GoalRunExecutionRequest,
    runner: &mut F,
) -> Result<GoalRunExecutionRecord, String>
where
    B: LocalStoreBackend,
    F: FnMut(
        GoalTaskRunInput,
        &mut dyn FnMut(&TaskExecutionLinkage) -> Result<(), String>,
    ) -> Result<TaskExecutionOutcome, String>,
{
    execute_goal_run_with_resource(state, snapshot_store, request, None, runner)
}

pub(super) fn execute_goal_run_with_resource<B, F>(
    state: &ServerStateService<B>,
    snapshot_store: Option<&TaskReviewSnapshotStore>,
    request: GoalRunExecutionRequest,
    resource_id: Option<&str>,
    runner: &mut F,
) -> Result<GoalRunExecutionRecord, String>
where
    B: LocalStoreBackend,
    F: FnMut(
        GoalTaskRunInput,
        &mut dyn FnMut(&TaskExecutionLinkage) -> Result<(), String>,
    ) -> Result<TaskExecutionOutcome, String>,
{
    let plan = read_goal_run_plan(state, &request.plan_id)?
        .ok_or_else(|| format!("goal run plan not found: {}", request.plan_id))?;
    if plan.revision_id != request.expected_plan_revision {
        return Err("goal run plan revision conflict".to_owned());
    }
    if let Some(existing) = read_execution(state, &plan.plan_id)? {
        return Ok(existing);
    }
    validate_continuation(state, &plan)?;
    let target = crate::project_resource_target::resolve_project_resource_target(
        state,
        &plan.project_id,
        resource_id,
    )?;
    let project_root = target.root.to_string_lossy().into_owned();
    let resource_id = Some(target.resource_id);
    let mut execution = GoalRunExecutionRecord {
        execution_id: format!("execution:{}", plan.plan_id),
        plan_id: plan.plan_id.clone(),
        mandate_id: plan.mandate_id.clone(),
        goal_id: plan.goal_id.clone(),
        project_id: plan.project_id.clone(),
        status: GoalRunExecutionStatus::Running,
        current_task_index: plan.current_task_index,
        task_executions: Vec::new(),
        terminal_reason: None,
        provider_execution_started: false,
        task_completion_permitted: false,
        review_acceptance_permitted: false,
        goal_achievement_permitted: false,
        scm_mutation_permitted: false,
        revision_id: format!("rev:{}:0", plan.plan_id),
    };
    persist_execution(state, &execution, RevisionExpectation::MustNotExist)?;

    for (ordinal, plan_task) in plan.ordered_tasks.iter().enumerate() {
        if plan_task.disposition == "already_terminal" {
            continue;
        }
        if ordinal < plan.current_task_index {
            continue;
        }
        if let Err(reason) = validate_continuation(state, &plan) {
            stop_execution(state, &plan, &mut execution, reason)?;
            return Ok(execution);
        }
        if let Err(reason) = validate_task_for_execution(state, &plan, plan_task) {
            stop_execution(state, &plan, &mut execution, reason)?;
            return Ok(execution);
        }
        execution.current_task_index = ordinal;
        let work_item_id = work_item_id(&plan, plan_task);
        let scheduled = match ensure_scheduled_source(state, &plan, plan_task, ordinal) {
            Ok(source) => source,
            Err(reason) => {
                stop_execution(state, &plan, &mut execution, reason)?;
                return Ok(execution);
            }
        };
        let dispatch = match compose_dispatch(&plan, plan_task, ordinal, &work_item_id) {
            Ok(dispatch) => dispatch,
            Err(reason) => {
                stop_execution(state, &plan, &mut execution, reason)?;
                return Ok(execution);
            }
        };
        let task = active_task(state, &plan.project_id, &plan_task.task_id)?;
        let prompt = task_prompt(&plan, ordinal, &task);
        let mut task_record = GoalTaskExecutionRecord {
            ordinal,
            task_id: plan_task.task_id.clone(),
            task_revision: plan_task.revision_id.clone(),
            work_item_id,
            status: "scheduled".to_owned(),
            dispatch,
            session_id: None,
            provider_thread_id: None,
            provider_turn_id: None,
            runtime_receipt_id: None,
            baseline_checkpoint_id: None,
            target_checkpoint_id: None,
            diff_summary_id: None,
            summary: "Task work is scheduled; provider handoff has not started.".to_owned(),
        };
        let review_input = TaskReviewEvidenceInput {
            project_id: plan.project_id.clone(),
            resource_id: resource_id.clone(),
            task_id: plan_task.task_id.clone(),
            work_item_id: task_record.work_item_id.clone(),
            command_id: task_record.dispatch.command_id.clone(),
            actor_ref: scheduled.actor_ref.clone(),
        };
        let baseline = match capture_baseline(state, snapshot_store, &review_input) {
            Ok(baseline) => baseline,
            Err(reason) => {
                record_pre_dispatch_recovery(
                    state,
                    &plan,
                    ordinal,
                    &mut execution,
                    &mut task_record,
                    &scheduled,
                    reason,
                )?;
                upsert_task_execution(&mut execution, task_record);
                update_execution(state, &mut execution)?;
                expire_for_execution(state, &plan, &execution)?;
                return Ok(execution);
            }
        };
        task_record.baseline_checkpoint_id = Some(baseline.checkpoint_id.0.clone());
        task_record.summary = "Baseline captured; provider handoff has not started.".to_owned();
        let baseline_source = transition_source(
            state,
            &scheduled,
            ordinal,
            1,
            EngineTaskAgentWorkUnitRuntimeStatus::Scheduled,
            EngineTaskAgentWorkUnitReviewStatus::NotReady,
            None,
            None,
            std::slice::from_ref(&baseline.checkpoint_id),
            &[],
            "Task review baseline captured before provider dispatch.",
        )?;
        upsert_task_execution(&mut execution, task_record.clone());
        update_execution(state, &mut execution)?;
        let mut running_source = None;
        let outcome = runner(
            GoalTaskRunInput {
                session_id: format!("session:task:{}", task_record.work_item_id),
                project_root: project_root.clone(),
                route: plan.route.clone(),
                prompt,
            },
            &mut |linkage| {
                let running = transition_source(
                    state,
                    &baseline_source,
                    ordinal,
                    2,
                    EngineTaskAgentWorkUnitRuntimeStatus::Running,
                    EngineTaskAgentWorkUnitReviewStatus::NotReady,
                    Some(linkage),
                    None,
                    &[],
                    &[],
                    "Provider task turn started.",
                )?;
                running_source = Some(running);
                task_record.status = "running".to_owned();
                task_record.session_id = Some(linkage.session_id.clone());
                task_record.provider_thread_id = Some(linkage.thread_id.clone());
                task_record.provider_turn_id = Some(linkage.turn_id.clone());
                task_record.summary = "Provider task turn started.".to_owned();
                execution.provider_execution_started = true;
                upsert_task_execution(&mut execution, task_record.clone());
                update_execution(state, &mut execution)
            },
        );
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(error) => TaskExecutionOutcome::RecoveryRequired {
                linkage: task_record_linkage(&task_record),
                reason: error,
            },
        };
        let mut completed_evidence = None;
        let outcome = match outcome {
            TaskExecutionOutcome::Completed(linkage) if running_source.is_some() => {
                match capture_completed(
                    state,
                    snapshot_store.expect("baseline requires configured snapshot store"),
                    &review_input,
                    &baseline,
                ) {
                    Ok(evidence) => {
                        task_record.target_checkpoint_id =
                            Some(evidence.target_checkpoint_id.0.clone());
                        task_record.diff_summary_id = Some(evidence.diff_summary_id.0.clone());
                        completed_evidence = Some(evidence);
                        TaskExecutionOutcome::Completed(linkage)
                    }
                    Err(reason) => TaskExecutionOutcome::RecoveryRequired {
                        linkage: Some(linkage),
                        reason,
                    },
                }
            }
            TaskExecutionOutcome::Completed(linkage) => TaskExecutionOutcome::RecoveryRequired {
                linkage: Some(linkage),
                reason: "provider completed without a persisted running transition".to_owned(),
            },
            outcome => outcome,
        };
        let should_continue = apply_outcome(
            state,
            &plan,
            ordinal,
            &mut execution,
            &mut task_record,
            running_source.as_ref(),
            completed_evidence.as_ref(),
            outcome,
        )?;
        upsert_task_execution(&mut execution, task_record);
        update_execution(state, &mut execution)?;
        if !should_continue {
            expire_for_execution(state, &plan, &execution)?;
            return Ok(execution);
        }
    }

    execution.status = GoalRunExecutionStatus::Completed;
    execution.terminal_reason =
        Some("All snapshotted Goal tasks reached reviewable provider outcomes.".to_owned());
    update_execution(state, &mut execution)?;
    expire_for_execution(state, &plan, &execution)?;
    Ok(execution)
}
