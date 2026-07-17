//! Split from the goal_execution god file; behavior unchanged.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use super::{dispatch::*, outcome::*, persistence::*, run_loop::*};
#[allow(unused_imports)]
use std::time::{SystemTime, UNIX_EPOCH};

use nucleus_core::RevisionId;
use nucleus_engine::{
    admit_task_agent_work_unit, EngineRuntimeReceiptStatus, EngineTaskAgentWorkUnitReviewStatus,
    EngineTaskAgentWorkUnitRuntimeStatus,
    EngineTaskWorkItemAssignment, EngineTaskWorkItemId, EngineTaskWorkItemRecord,
    EngineTaskWorkItemRefs, EngineTaskWorkItemReviewState, EngineTaskWorkItemRuntimeState,
};
use nucleus_local_store::{
    LocalStoreBackend, RevisionExpectation,
};
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use super::super::goal_inspection::goal_record;
use super::super::goal_run::{GoalRunPlan, GoalRunPlanTask};
use super::super::mandates::{read_workflow_mandate, WorkflowMandateStatus};
use super::super::task_inspection::active_task;
use crate::runtime_receipt_state::write_runtime_receipt;
use crate::task_agent_work_unit_state::write_task_agent_work_unit_source_record;
use crate::ServerStateService;

pub(super) fn validate_continuation<B>(state: &ServerStateService<B>, plan: &GoalRunPlan) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let mandate = read_workflow_mandate(state, &plan.mandate_id)?;
    if mandate.revision_id != plan.mandate_revision
        || mandate.status != WorkflowMandateStatus::Active
    {
        return Err("goal run mandate is no longer active at its admitted revision".to_owned());
    }
    if now_epoch_seconds()? >= mandate.expires_at_epoch_seconds {
        return Err("goal run mandate expired before the next task".to_owned());
    }
    if let Some(goal_id) = plan.goal_id.as_deref() {
        let goal = goal_record(state, &plan.project_id, goal_id)?;
        if !matches!(goal.status.as_str(), "ready" | "active") {
            return Err(format!("Goal cannot continue from status {}", goal.status));
        }
    }
    Ok(())
}

pub(super) fn validate_task_for_execution<B>(
    state: &ServerStateService<B>,
    plan: &GoalRunPlan,
    plan_task: &GoalRunPlanTask,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let task = active_task(state, &plan.project_id, &plan_task.task_id)?;
    if task.revision_id != plan_task.revision_id {
        return Err(format!(
            "task changed after Goal run admission: {}",
            task.task_id
        ));
    }
    if task.activity != "ready" || !task.agent_ready {
        return Err(format!(
            "task is no longer ready for agent execution: {}",
            task.task_id
        ));
    }
    Ok(())
}

pub(super) fn ensure_scheduled_source<B>(
    state: &ServerStateService<B>,
    plan: &GoalRunPlan,
    task: &GoalRunPlanTask,
    ordinal: usize,
) -> Result<nucleus_engine::EngineTaskAgentWorkUnitSourceRecord, String>
where
    B: LocalStoreBackend,
{
    let id = work_item_id(plan, task);
    if let Some(source) = latest_source(state, &id)? {
        return if matches!(
            source.runtime,
            EngineTaskAgentWorkUnitRuntimeStatus::Scheduled
        ) {
            Ok(source)
        } else {
            Err(format!(
                "Goal run work item requires recovery before replay: {id}"
            ))
        };
    }
    let current = active_task(state, &plan.project_id, &task.task_id)?;
    let work_item = EngineTaskWorkItemRecord {
        work_item_id: EngineTaskWorkItemId(id),
        task_id: TaskId(task.task_id.clone()),
        project_id: ProjectId(plan.project_id.clone()),
        title: format!("Goal run work for {}", current.title),
        intent: task_action(&current.action_type)?,
        assignment: EngineTaskWorkItemAssignment::AdapterInstance {
            adapter_id: plan.route.adapter_id.clone(),
            provider_instance_id: plan.route.provider_instance_id.clone(),
        },
        runtime: EngineTaskWorkItemRuntimeState::Scheduled,
        review: EngineTaskWorkItemReviewState::NotReady,
        refs: EngineTaskWorkItemRefs::default(),
        summary: Some("Goal run task scheduled; provider execution deferred.".to_owned()),
    };
    let admission = admit_task_agent_work_unit(
        &format!("command:{}:task:{ordinal}", plan.plan_id),
        &plan.operator_message_id,
        &format!("{}:task:{ordinal}", plan.idempotency_key),
        Some(RevisionId(task.revision_id.clone())),
        &work_item,
    );
    let source = admission.source_record;
    write_task_agent_work_unit_source_record(
        state,
        source.clone(),
        RevisionId(format!("rev:{}", source.source_id.0)),
        RevisionExpectation::MustNotExist,
    )
    .map_err(|error| format!("failed to schedule Goal task work: {error:?}"))?;
    Ok(source)
}

pub(super) fn record_pre_dispatch_recovery<B>(
    state: &ServerStateService<B>,
    plan: &GoalRunPlan,
    ordinal: usize,
    execution: &mut GoalRunExecutionRecord,
    task_record: &mut GoalTaskExecutionRecord,
    scheduled: &nucleus_engine::EngineTaskAgentWorkUnitSourceRecord,
    reason: String,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let receipt = runtime_receipt(
        plan,
        task_record,
        EngineRuntimeReceiptStatus::RecoveryRequired,
        None,
        &reason,
    );
    write_runtime_receipt(
        state,
        &receipt,
        RevisionId(format!("rev:{}", receipt.receipt_id.0)),
        RevisionExpectation::MustNotExist,
    )
    .map_err(|error| format!("failed to persist Goal task recovery receipt: {error:?}"))?;
    let failed = transition_source(
        state,
        scheduled,
        ordinal,
        1,
        EngineTaskAgentWorkUnitRuntimeStatus::Failed(reason.clone()),
        EngineTaskAgentWorkUnitReviewStatus::NotReady,
        None,
        Some(&receipt.receipt_id),
        &[],
        &[],
        &reason,
    )?;
    transition_source(
        state,
        &failed,
        ordinal,
        2,
        EngineTaskAgentWorkUnitRuntimeStatus::RecoveryRequired(reason.clone()),
        EngineTaskAgentWorkUnitReviewStatus::NotReady,
        None,
        Some(&receipt.receipt_id),
        &[],
        &[],
        &reason,
    )?;
    task_record.status = "recovery_required".to_owned();
    task_record.runtime_receipt_id = Some(receipt.receipt_id.0);
    task_record.summary = reason.clone();
    execution.status = GoalRunExecutionStatus::RecoveryRequired;
    execution.terminal_reason = Some(reason);
    Ok(())
}

