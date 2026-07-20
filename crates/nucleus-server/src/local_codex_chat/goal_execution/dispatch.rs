//! Split from the goal_execution god file; behavior unchanged.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use super::{outcome::*, persistence::*, rules::*, run_loop::*};
#[allow(unused_imports)]
use std::time::{SystemTime, UNIX_EPOCH};

use nucleus_tasks::TaskActionType;

use super::super::goal_run::{GoalRunPlan, GoalRunPlanTask};
use super::super::task_execution::TaskExecutionLinkage;
use crate::{
    durable_dispatch_invocation_preflight, durable_dispatch_invocation_request,
    durable_provider_executor_command, durable_provider_executor_dispatch_admission,
    durable_provider_executor_dispatch_selection, DurableDispatchInvocationPreflightInput,
    DurableDispatchInvocationPreflightStatus, DurableDispatchInvocationRequestInput,
    DurableDispatchInvocationRequestStatus, DurableProviderExecutorCommandId,
    DurableProviderExecutorCommandInput, DurableProviderExecutorDispatchAdmissionInput,
    DurableProviderExecutorDispatchAdmissionStatus, DurableProviderExecutorDispatchSelectionInput,
    DurableProviderExecutorDispatchSelectionStatus, DurableProviderExecutorLane,
    DurableProviderExecutorMethod,
};

pub(super) fn compose_dispatch(
    plan: &GoalRunPlan,
    task: &GoalRunPlanTask,
    ordinal: usize,
    work_item_id: &str,
) -> Result<GoalTaskDispatchRefs, String> {
    let command_id = format!("durable-command:{}:{ordinal}", plan.plan_id);
    let write_attempt_id = format!("write-attempt:{}:{ordinal}", plan.plan_id);
    let dispatch_attempt_id = format!("dispatch-attempt:{}:{ordinal}", plan.plan_id);
    let runtime_session_ref = format!("runtime-session:{}:{ordinal}", plan.plan_id);
    let evidence = vec![
        format!("mandate:{}", plan.mandate_id),
        format!("plan:{}", plan.plan_id),
    ];
    let command = durable_provider_executor_command(DurableProviderExecutorCommandInput {
        command_id: DurableProviderExecutorCommandId(command_id.clone()),
        lane: DurableProviderExecutorLane::TaskBackedTurnStart,
        lane_admission_id: plan.revision_id.clone(),
        provider_instance_id: plan.route.provider_instance_id.clone(),
        runtime_session_ref: runtime_session_ref.clone(),
        write_attempt_id: write_attempt_id.clone(),
        idempotency_key: format!("{}:task:{ordinal}", plan.idempotency_key),
        task_id: Some(task.task_id.clone()),
        work_item_id: Some(work_item_id.to_owned()),
        method: DurableProviderExecutorMethod::TurnStart,
        evidence_refs: evidence.clone(),
        operator_confirmation_ref: Some(plan.operator_message_id.clone()),
        client_authority_requested: false,
        invoke_executor_requested: false,
        raw_provider_material_requested: false,
        raw_callback_material_requested: false,
        task_mutation_requested: false,
        review_acceptance_requested: false,
        callback_answer_requested: false,
        interruption_requested: false,
        recovery_requested: false,
        replacement_thread_promotion_requested: false,
        scm_mutation_requested: false,
    });
    let selection = durable_provider_executor_dispatch_selection(
        DurableProviderExecutorDispatchSelectionInput {
            command,
            latest_status: None,
            provider_ready_evidence_refs: vec![format!(
                "provider-ready:{}",
                plan.route.provider_instance_id
            )],
            runtime_ready_evidence_refs: vec![runtime_session_ref.clone()],
            selection_evidence_refs: evidence.clone(),
            in_flight_write_attempt_ids: Vec::new(),
            stale_command_evidence: false,
            background_execution_requested: false,
            provider_write_requested: false,
            raw_provider_material_requested: false,
            raw_callback_material_requested: false,
            task_mutation_requested: false,
            review_acceptance_requested: false,
            callback_answer_requested: false,
            interruption_requested: false,
            recovery_requested: false,
            replacement_thread_promotion_requested: false,
            scm_mutation_requested: false,
        },
    );
    if selection.status
        != DurableProviderExecutorDispatchSelectionStatus::SelectedForDispatchAdmission
    {
        return Err(format!(
            "provider dispatch selection blocked: {:?}",
            selection.blockers
        ));
    }
    let selection_id = selection.selection_id.0.clone();
    let admission = durable_provider_executor_dispatch_admission(
        DurableProviderExecutorDispatchAdmissionInput {
            selection,
            dispatch_attempt_id,
            operator_confirmation_ref: Some(plan.operator_message_id.clone()),
            runtime_session_evidence_refs: vec![runtime_session_ref],
            provider_ready_evidence_refs: vec![format!(
                "provider-ready:{}",
                plan.route.provider_instance_id
            )],
            admission_evidence_refs: evidence.clone(),
            write_attempt_id: write_attempt_id.clone(),
            idempotency_key: format!("{}:task:{ordinal}", plan.idempotency_key),
            invoke_executor_requested: false,
            background_execution_requested: false,
            provider_write_requested: false,
            raw_provider_material_requested: false,
            raw_callback_material_requested: false,
            task_mutation_requested: false,
            review_acceptance_requested: false,
            callback_answer_requested: false,
            interruption_requested: false,
            recovery_requested: false,
            replacement_thread_promotion_requested: false,
            scm_mutation_requested: false,
        },
    );
    if admission.status != DurableProviderExecutorDispatchAdmissionStatus::AcceptedForDispatch {
        return Err(format!(
            "provider dispatch admission blocked: {:?}",
            admission.blockers
        ));
    }
    let admission_id = admission.admission_id.0.clone();
    let preflight =
        durable_dispatch_invocation_preflight(DurableDispatchInvocationPreflightInput {
            admission,
            operator_confirmation_ref: Some(plan.operator_message_id.clone()),
            provider_ready_evidence_refs: vec![format!(
                "provider-ready:{}",
                plan.route.provider_instance_id
            )],
            runtime_session_evidence_refs: vec![format!(
                "runtime-session:{}:{ordinal}",
                plan.plan_id
            )],
            invocation_evidence_refs: evidence.clone(),
            supported_methods: vec![DurableProviderExecutorMethod::TurnStart],
            in_flight_invocation_attempt_ids: Vec::new(),
            stale_admission_evidence: false,
            write_attempt_id: write_attempt_id.clone(),
            idempotency_key: format!("{}:task:{ordinal}", plan.idempotency_key),
            executor_invocation_requested: false,
            background_execution_requested: false,
            provider_write_requested: false,
            raw_provider_material_requested: false,
            raw_callback_material_requested: false,
            task_mutation_requested: false,
            review_acceptance_requested: false,
            callback_answer_requested: false,
            interruption_requested: false,
            recovery_requested: false,
            replacement_thread_promotion_requested: false,
            scm_mutation_requested: false,
        });
    if preflight.status != DurableDispatchInvocationPreflightStatus::AcceptedForInvocationRequest {
        return Err(format!(
            "provider dispatch preflight blocked: {:?}",
            preflight.blockers
        ));
    }
    let preflight_id = preflight.preflight_id.0.clone();
    let invocation = durable_dispatch_invocation_request(DurableDispatchInvocationRequestInput {
        preflight,
        invocation_request_evidence_refs: evidence,
        executor_invocation_requested: false,
        background_execution_requested: false,
        provider_write_requested: false,
        raw_provider_material_requested: false,
        raw_callback_material_requested: false,
        task_mutation_requested: false,
        review_acceptance_requested: false,
        callback_answer_requested: false,
        interruption_requested: false,
        recovery_requested: false,
        replacement_thread_promotion_requested: false,
        scm_mutation_requested: false,
    });
    if invocation.status != DurableDispatchInvocationRequestStatus::AcceptedForExecutorHandoff {
        return Err(format!(
            "provider invocation request blocked: {:?}",
            invocation.blockers
        ));
    }
    Ok(GoalTaskDispatchRefs {
        command_id,
        selection_id,
        admission_id,
        preflight_id,
        invocation_request_id: invocation.request_id.0,
        write_attempt_id,
    })
}

pub(super) fn task_prompt(
    plan: &GoalRunPlan,
    ordinal: usize,
    task: &crate::ControlTaskRecordDto,
) -> String {
    let rework = plan.ordered_tasks.get(ordinal).and_then(|plan_task| {
        plan_task.rework_decision_ref.as_ref().map(|decision_ref| {
            nucleus_engine::EngineGoalRunReworkContext {
                decision_ref: decision_ref.clone(),
                reason: plan_task.rework_reason.clone(),
                reviewed_work_item_refs: plan_task.reviewed_work_item_refs.clone(),
                reviewed_evidence_refs: plan_task.reviewed_evidence_refs.clone(),
            }
        })
    });
    nucleus_engine::goal_run_task_prompt(
        plan.goal_id.as_deref(),
        ordinal,
        &goal_run_task_view(task),
        rework.as_ref(),
    )
}

pub(super) fn goal_run_task_view(
    task: &crate::ControlTaskRecordDto,
) -> nucleus_engine::EngineGoalRunTaskView {
    nucleus_engine::EngineGoalRunTaskView {
        task_id: task.task_id.clone(),
        revision_id: task.revision_id.clone(),
        title: task.title.clone(),
        description: task.description.clone(),
        action_type: task.action_type.clone(),
        activity: task.activity.clone(),
        agent_ready: task.agent_ready,
        acceptance_criteria: task
            .acceptance_criteria
            .iter()
            .map(|criterion| criterion.text.clone())
            .collect(),
        validation_commands: task.validation_commands.clone(),
        stop_conditions: task.stop_conditions.clone(),
    }
}

pub(super) fn task_action(value: &str) -> Result<TaskActionType, String> {
    nucleus_engine::parse_task_action(value)
}

pub(super) fn work_item_id(plan: &GoalRunPlan, task: &GoalRunPlanTask) -> String {
    nucleus_engine::goal_run_work_item_id(&plan.plan_id, &task.task_id)
}

pub(super) fn task_record_linkage(
    record: &GoalTaskExecutionRecord,
) -> Option<TaskExecutionLinkage> {
    Some(TaskExecutionLinkage {
        session_id: record.session_id.clone()?,
        thread_id: record.provider_thread_id.clone()?,
        turn_id: record.provider_turn_id.clone()?,
    })
}

pub(super) fn upsert_task_execution(
    execution: &mut GoalRunExecutionRecord,
    task: GoalTaskExecutionRecord,
) {
    if let Some(existing) = execution
        .task_executions
        .iter_mut()
        .find(|existing| existing.ordinal == task.ordinal)
    {
        *existing = task;
    } else {
        execution.task_executions.push(task);
        execution
            .task_executions
            .sort_by_key(|record| record.ordinal);
    }
}
