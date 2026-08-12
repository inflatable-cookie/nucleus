//! Task workflow run: mandate creation, Goal-run admission, provider
//! execution handoff, and receipt composition.
//!
//! Split from the task_workflow god file; behavior unchanged.

use std::time::{SystemTime, UNIX_EPOCH};

use nucleus_engine::{project_task_agent_work_units, EngineTaskAgentWorkUnitRuntimeStatus};
use nucleus_local_store::LocalStoreBackend;

use super::super::goal_execution::{
    execute_goal_run_for_resource, GoalRunExecutionRequest, GoalRunExecutionStatus,
};
use super::super::goal_run::{
    admit_goal_run, read_goal_run_plan, GoalRunAdmissionRequest, GoalRunOutcome,
};
use super::super::mandates::{
    create_workflow_mandate, expire_workflow_mandate, find_workflow_mandate, WorkflowMandate,
    WorkflowMandateAdmission, WorkflowMandateScope, WorkflowMandateStatus,
};
use super::super::persistence::{current_turn, operator_message_id};
use super::super::rework_context::current_task_review_context;
use super::super::task_authoring::{safe_ref, TaskToolOutcome};
use super::types::{TaskWorkflowInput, TaskWorkflowReceipt, TaskWorkflowReceiptStatus};
use crate::task_agent_work_unit_state::read_task_agent_work_unit_source_records;
use crate::{ServerStateService, TaskReviewSnapshotStore};

const MANDATE_TTL_SECONDS: u64 = 60 * 60;

pub(super) fn run<B>(
    state: &ServerStateService<B>,
    snapshot_store: Option<&TaskReviewSnapshotStore>,
    project_id: &str,
    conversation_id: &str,
    resource_id: Option<&str>,
    input: TaskWorkflowInput,
) -> Result<TaskToolOutcome, String>
where
    B: LocalStoreBackend,
{
    let expected_revision = required(input.expected_revision.as_deref(), "expected_revision")?;
    let excerpt = required(
        input.operator_message_excerpt.as_deref(),
        "operator_message_excerpt",
    )?;
    let idempotency_key = required(input.idempotency_key.as_deref(), "idempotency_key")?;
    let review = match input.scope.as_str() {
        "task" => current_task_review_context(
            state,
            project_id,
            input.task_id.as_deref().expect("validated task scope"),
        )?,
        "goal" => None,
        _ => unreachable!("validated scope"),
    };
    if review.as_ref().is_some_and(|review| !review.rework_ready) {
        return Err("current task review outcome does not admit rework execution".to_owned());
    }
    let scope = match input.scope.as_str() {
        "task" => WorkflowMandateScope::Task {
            task_id: input.task_id.clone().expect("validated task scope"),
            task_revision: expected_revision.to_owned(),
        },
        "goal" => WorkflowMandateScope::Goal {
            goal_id: input.goal_id.clone().expect("validated Goal scope"),
            goal_revision: expected_revision.to_owned(),
        },
        _ => unreachable!("validated scope"),
    };
    let mandate_id = format!(
        "mandate:{}:{}",
        safe_ref(conversation_id),
        safe_ref(idempotency_key)
    );
    let mandate = existing_or_create_mandate(
        state,
        &mandate_id,
        conversation_id,
        project_id,
        excerpt,
        idempotency_key,
        scope,
    )?;
    let outcome = if mandate.status == WorkflowMandateStatus::Active {
        admit_goal_run(
            state,
            GoalRunAdmissionRequest {
                mandate_id: mandate.mandate_id.clone(),
                expected_mandate_revision: mandate.revision_id.clone(),
                idempotency_key: idempotency_key.to_owned(),
                now_epoch_seconds: now_epoch_seconds()?,
                rework_decision_ref: review.as_ref().map(|review| review.decision_ref.clone()),
                rework_reason: review.as_ref().and_then(|review| review.reason.clone()),
                reviewed_work_item_refs: review
                    .as_ref()
                    .map(|review| review.reviewed_work_item_refs.clone())
                    .unwrap_or_default(),
                reviewed_evidence_refs: review
                    .as_ref()
                    .map(|review| review.reviewed_evidence_refs.clone())
                    .unwrap_or_default(),
            },
        )?
    } else {
        let plan_id = format!("goal-run:{}:{idempotency_key}", mandate.mandate_id);
        GoalRunOutcome::Admitted {
            plan: read_goal_run_plan(state, &plan_id)?
                .ok_or_else(|| "task_workflow mandate closed without an admitted run".to_owned())?,
        }
    };
    let plan = match outcome {
        GoalRunOutcome::Admitted { plan } => plan,
        GoalRunOutcome::Blocked { inspection } => {
            let reason = inspection
                .blockers
                .first()
                .map(|blocker| blocker.reason.clone())
                .unwrap_or_else(|| "Workflow run is blocked".to_owned());
            expire_workflow_mandate(
                state,
                &mandate.mandate_id,
                &mandate.revision_id,
                &reason,
                Vec::new(),
            )?;
            return TaskToolOutcome::from_workflow_receipt(TaskWorkflowReceipt {
                status: TaskWorkflowReceiptStatus::Blocked,
                scope_kind: inspection.scope_kind,
                project_id: inspection.project_id,
                goal_id: inspection.goal_id,
                task_id: inspection
                    .ordered_tasks
                    .first()
                    .map(|task| task.task_id.clone()),
                title: inspection
                    .ordered_tasks
                    .first()
                    .map(|task| task.title.clone())
                    .unwrap_or_else(|| "Workflow run".to_owned()),
                current_task_id: inspection
                    .ordered_tasks
                    .first()
                    .map(|task| task.task_id.clone()),
                current_position: 0,
                total_tasks: inspection.ordered_tasks.len(),
                summary: reason,
                mandate_id: mandate.mandate_id,
                plan_id: None,
                work_item_refs: Vec::new(),
                runtime_receipt_refs: Vec::new(),
            });
        }
    };
    let execution = execute_goal_run_for_resource(
        state,
        snapshot_store,
        GoalRunExecutionRequest {
            plan_id: plan.plan_id.clone(),
            expected_plan_revision: plan.revision_id.clone(),
        },
        resource_id,
    )?;
    let status = match execution.status {
        GoalRunExecutionStatus::Completed => TaskWorkflowReceiptStatus::ReviewReady,
        GoalRunExecutionStatus::Stopped => TaskWorkflowReceiptStatus::Stopped,
        GoalRunExecutionStatus::RecoveryRequired => TaskWorkflowReceiptStatus::RecoveryRequired,
        GoalRunExecutionStatus::Running => TaskWorkflowReceiptStatus::Stopped,
    };
    let current = execution
        .task_executions
        .get(execution.current_task_index)
        .or_else(|| execution.task_executions.last());
    let first_task = plan.ordered_tasks.first();
    TaskToolOutcome::from_workflow_receipt(TaskWorkflowReceipt {
        status,
        scope_kind: plan.scope_kind,
        project_id: plan.project_id,
        goal_id: plan.goal_id,
        task_id: if plan.ordered_tasks.len() == 1 {
            first_task.map(|task| task.task_id.clone())
        } else {
            None
        },
        title: current
            .map(|task| task.task_id.clone())
            .or_else(|| first_task.map(|task| task.task_id.clone()))
            .unwrap_or_else(|| "Workflow run".to_owned()),
        current_task_id: current.map(|task| task.task_id.clone()),
        current_position: execution.current_task_index.saturating_add(1),
        total_tasks: plan.ordered_tasks.len(),
        summary: execution
            .terminal_reason
            .unwrap_or_else(|| "Provider execution started".to_owned()),
        mandate_id: execution.mandate_id,
        plan_id: Some(execution.plan_id),
        work_item_refs: execution
            .task_executions
            .iter()
            .map(|task| task.work_item_id.clone())
            .collect(),
        runtime_receipt_refs: execution
            .task_executions
            .iter()
            .filter_map(|task| task.runtime_receipt_id.clone())
            .collect(),
    })
}

fn existing_or_create_mandate<B>(
    state: &ServerStateService<B>,
    mandate_id: &str,
    conversation_id: &str,
    project_id: &str,
    excerpt: &str,
    idempotency_key: &str,
    scope: WorkflowMandateScope,
) -> Result<WorkflowMandate, String>
where
    B: LocalStoreBackend,
{
    if let Some(existing) = find_workflow_mandate(state, mandate_id)? {
        if existing.conversation_id != conversation_id
            || existing.project_id != project_id
            || existing.idempotency_key != idempotency_key
            || existing.scope != scope
        {
            return Err("task_workflow idempotency key conflicts with another scope".to_owned());
        }
        return Ok(existing);
    }
    let turn = current_turn(state, conversation_id)?;
    create_workflow_mandate(
        state,
        WorkflowMandateAdmission {
            mandate_id: mandate_id.to_owned(),
            conversation_id: conversation_id.to_owned(),
            operator_message_id: operator_message_id(&turn.turn_id),
            operator_message_excerpt: excerpt.to_owned(),
            project_id: project_id.to_owned(),
            scope,
            idempotency_key: idempotency_key.to_owned(),
            expires_at_epoch_seconds: now_epoch_seconds()? + MANDATE_TTL_SECONDS,
        },
    )
}

pub(super) fn task_blockers<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    task: &crate::ControlTaskRecordDto,
) -> Result<Vec<String>, String>
where
    B: LocalStoreBackend,
{
    let mut blockers = Vec::new();
    if task.activity != "ready" {
        blockers.push(format!(
            "Task {} activity is {}",
            task.task_id, task.activity
        ));
    }
    if !task.agent_ready {
        blockers.push(format!("Task {} is not agent-ready", task.task_id));
    }
    let sources = read_task_agent_work_unit_source_records(state)
        .map_err(|error| format!("task_workflow active-work inspection failed: {error:?}"))?;
    let has_active_work = project_task_agent_work_units(&sources).iter().any(|work| {
        work.project_id.0 == project_id
            && work.task_id.0 == task.task_id
            && matches!(
                work.runtime,
                EngineTaskAgentWorkUnitRuntimeStatus::Scheduled
                    | EngineTaskAgentWorkUnitRuntimeStatus::Running
                    | EngineTaskAgentWorkUnitRuntimeStatus::WaitingForApproval
                    | EngineTaskAgentWorkUnitRuntimeStatus::WaitingForUserInput
            )
    });
    if has_active_work {
        blockers.push(format!("Task {} already has active work", task.task_id));
    }
    Ok(blockers)
}

fn required<'a>(value: Option<&'a str>, field: &str) -> Result<&'a str, String> {
    value
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("task_workflow run requires {field}"))
}

fn now_epoch_seconds() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| "system clock is before the Unix epoch".to_owned())
}
