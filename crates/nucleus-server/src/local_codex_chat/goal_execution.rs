use std::time::{SystemTime, UNIX_EPOCH};

use nucleus_agent_protocol::{AgentSessionId, AgentTurnId};
use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_engine::{
    admit_task_agent_work_unit, EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptRecord,
    EngineRuntimeReceiptRecordId, EngineRuntimeReceiptRef, EngineRuntimeReceiptStatus,
    EngineTaskAgentWorkUnitReviewStatus, EngineTaskAgentWorkUnitRuntimeStatus,
    EngineTaskAgentWorkUnitSourceId, EngineTaskWorkItemAssignment, EngineTaskWorkItemId,
    EngineTaskWorkItemRecord, EngineTaskWorkItemRefs, EngineTaskWorkItemReviewState,
    EngineTaskWorkItemRuntimeState,
};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreRecord, LocalStoreRecordPayload, RevisionExpectation,
};
use nucleus_projects::ProjectId;
use nucleus_tasks::{TaskActionType, TaskId};
use serde::{Deserialize, Serialize};

use super::goal_inspection::goal_record;
use super::goal_run::{read_goal_run_plan, GoalRunPlan, GoalRunPlanTask, GoalRunRoute};
use super::mandates::{expire_workflow_mandate, read_workflow_mandate, WorkflowMandateStatus};
use super::project_root;
use super::task_execution::{
    run_task, TaskExecutionLinkage, TaskExecutionOutcome, TaskExecutionRequest,
};
use super::task_inspection::active_task;
use crate::runtime_receipt_state::write_runtime_receipt;
use crate::task_agent_work_unit_state::{
    read_task_agent_work_unit_source_records, write_task_agent_work_unit_source_record,
};
use crate::{
    durable_dispatch_invocation_preflight, durable_dispatch_invocation_request,
    durable_provider_executor_command, durable_provider_executor_dispatch_admission,
    durable_provider_executor_dispatch_selection, DurableDispatchInvocationPreflightInput,
    DurableDispatchInvocationPreflightStatus, DurableDispatchInvocationRequestInput,
    DurableDispatchInvocationRequestStatus, DurableProviderExecutorCommandId,
    DurableProviderExecutorCommandInput, DurableProviderExecutorDispatchAdmissionInput,
    DurableProviderExecutorDispatchAdmissionStatus, DurableProviderExecutorDispatchSelectionInput,
    DurableProviderExecutorDispatchSelectionStatus, DurableProviderExecutorLane,
    DurableProviderExecutorMethod, ServerStateService,
};

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
    request: GoalRunExecutionRequest,
) -> Result<GoalRunExecutionRecord, String>
where
    B: LocalStoreBackend,
{
    execute_goal_run_with(state, request, &mut |input, on_started| {
        run_task(
            TaskExecutionRequest {
                project_root: &input.project_root,
                route: &input.route,
                prompt: &input.prompt,
            },
            on_started,
        )
    })
}

struct GoalTaskRunInput {
    project_root: String,
    route: GoalRunRoute,
    prompt: String,
}

fn execute_goal_run_with<B, F>(
    state: &ServerStateService<B>,
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
    let plan = read_goal_run_plan(state, &request.plan_id)?
        .ok_or_else(|| format!("goal run plan not found: {}", request.plan_id))?;
    if plan.revision_id != request.expected_plan_revision {
        return Err("goal run plan revision conflict".to_owned());
    }
    if let Some(existing) = read_execution(state, &plan.plan_id)? {
        return Ok(existing);
    }
    validate_continuation(state, &plan)?;
    let project_root = project_root(state, &plan.project_id)?;
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
            summary: "Task work is scheduled; provider handoff has not started.".to_owned(),
        };
        let mut running_source = None;
        let outcome = runner(
            GoalTaskRunInput {
                project_root: project_root.clone(),
                route: plan.route.clone(),
                prompt,
            },
            &mut |linkage| {
                let running = transition_source(
                    state,
                    &scheduled,
                    ordinal,
                    1,
                    EngineTaskAgentWorkUnitRuntimeStatus::Running,
                    EngineTaskAgentWorkUnitReviewStatus::NotReady,
                    Some(linkage),
                    None,
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
        let should_continue = apply_outcome(
            state,
            &plan,
            ordinal,
            &mut execution,
            &mut task_record,
            running_source.as_ref(),
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

fn validate_continuation<B>(state: &ServerStateService<B>, plan: &GoalRunPlan) -> Result<(), String>
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

fn validate_task_for_execution<B>(
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

fn ensure_scheduled_source<B>(
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

fn apply_outcome<B>(
    state: &ServerStateService<B>,
    plan: &GoalRunPlan,
    ordinal: usize,
    execution: &mut GoalRunExecutionRecord,
    task_record: &mut GoalTaskExecutionRecord,
    running: Option<&nucleus_engine::EngineTaskAgentWorkUnitSourceRecord>,
    outcome: TaskExecutionOutcome,
) -> Result<bool, String>
where
    B: LocalStoreBackend,
{
    let (status, receipt_status, linkage, reason, continue_run) = match outcome {
        TaskExecutionOutcome::Completed(linkage) => (
            "completed",
            EngineRuntimeReceiptStatus::Completed,
            Some(linkage),
            "Provider task turn completed with a reviewable candidate result.".to_owned(),
            true,
        ),
        TaskExecutionOutcome::WaitingForApproval(linkage) => (
            "waiting_for_approval",
            EngineRuntimeReceiptStatus::WaitingForApproval,
            Some(linkage),
            "Provider requested approval; the serial Goal run stopped.".to_owned(),
            false,
        ),
        TaskExecutionOutcome::WaitingForUserInput(linkage) => (
            "waiting_for_user_input",
            EngineRuntimeReceiptStatus::WaitingForUserInput,
            Some(linkage),
            "Provider requested user input; the serial Goal run stopped.".to_owned(),
            false,
        ),
        TaskExecutionOutcome::Cancelled { linkage, reason } => (
            "cancelled",
            EngineRuntimeReceiptStatus::Cancelled,
            linkage,
            reason,
            false,
        ),
        TaskExecutionOutcome::Failed { linkage, reason } => (
            "failed",
            EngineRuntimeReceiptStatus::Failed,
            linkage,
            reason,
            false,
        ),
        TaskExecutionOutcome::RecoveryRequired { linkage, reason } => (
            "recovery_required",
            EngineRuntimeReceiptStatus::RecoveryRequired,
            linkage,
            reason,
            false,
        ),
    };
    let receipt = runtime_receipt(plan, task_record, receipt_status, linkage.as_ref(), &reason);
    write_runtime_receipt(
        state,
        &receipt,
        RevisionId(format!("rev:{}", receipt.receipt_id.0)),
        RevisionExpectation::MustNotExist,
    )
    .map_err(|error| format!("failed to persist Goal task receipt: {error:?}"))?;
    let Some(running) = running else {
        task_record.status = "recovery_required".to_owned();
        task_record.runtime_receipt_id = Some(receipt.receipt_id.0);
        task_record.summary = reason.clone();
        execution.status = GoalRunExecutionStatus::RecoveryRequired;
        execution.terminal_reason = Some(reason);
        return Ok(false);
    };
    let terminal_runtime = match status {
        "completed" => EngineTaskAgentWorkUnitRuntimeStatus::Completed,
        "waiting_for_approval" => EngineTaskAgentWorkUnitRuntimeStatus::WaitingForApproval,
        "waiting_for_user_input" => EngineTaskAgentWorkUnitRuntimeStatus::WaitingForUserInput,
        "cancelled" => EngineTaskAgentWorkUnitRuntimeStatus::Cancelled,
        "failed" => EngineTaskAgentWorkUnitRuntimeStatus::Failed(reason.clone()),
        "recovery_required" => EngineTaskAgentWorkUnitRuntimeStatus::Failed(reason.clone()),
        _ => unreachable!(),
    };
    let review = if status == "completed" {
        EngineTaskAgentWorkUnitReviewStatus::AwaitingReview
    } else {
        EngineTaskAgentWorkUnitReviewStatus::NotReady
    };
    let terminal = transition_source(
        state,
        running,
        ordinal,
        2,
        terminal_runtime,
        review,
        linkage.as_ref(),
        Some(&receipt.receipt_id),
        &reason,
    )?;
    if status == "recovery_required" {
        transition_source(
            state,
            &terminal,
            ordinal,
            3,
            EngineTaskAgentWorkUnitRuntimeStatus::RecoveryRequired(reason.clone()),
            EngineTaskAgentWorkUnitReviewStatus::NotReady,
            linkage.as_ref(),
            Some(&receipt.receipt_id),
            &reason,
        )?;
    }
    if matches!(status, "waiting_for_approval" | "waiting_for_user_input") {
        let failed = transition_source(
            state,
            &terminal,
            ordinal,
            3,
            EngineTaskAgentWorkUnitRuntimeStatus::Failed(
                "Interactive provider session could not remain attached.".to_owned(),
            ),
            EngineTaskAgentWorkUnitReviewStatus::NotReady,
            linkage.as_ref(),
            Some(&receipt.receipt_id),
            "Interactive wait requires recovery.",
        )?;
        transition_source(
            state,
            &failed,
            ordinal,
            4,
            EngineTaskAgentWorkUnitRuntimeStatus::RecoveryRequired(
                "Interactive wait requires a new admitted continuation.".to_owned(),
            ),
            EngineTaskAgentWorkUnitReviewStatus::NotReady,
            linkage.as_ref(),
            Some(&receipt.receipt_id),
            "Interactive wait requires recovery.",
        )?;
    }
    task_record.status = status.to_owned();
    task_record.runtime_receipt_id = Some(receipt.receipt_id.0);
    task_record.summary = reason.clone();
    if let Some(linkage) = linkage {
        task_record.session_id = Some(linkage.session_id);
        task_record.provider_thread_id = Some(linkage.thread_id);
        task_record.provider_turn_id = Some(linkage.turn_id);
    }
    if !continue_run {
        execution.status = if status == "recovery_required"
            || matches!(status, "waiting_for_approval" | "waiting_for_user_input")
        {
            GoalRunExecutionStatus::RecoveryRequired
        } else if status == "cancelled" {
            GoalRunExecutionStatus::Stopped
        } else {
            GoalRunExecutionStatus::Stopped
        };
        execution.terminal_reason = Some(reason);
    }
    Ok(continue_run)
}

fn transition_source<B>(
    state: &ServerStateService<B>,
    previous: &nucleus_engine::EngineTaskAgentWorkUnitSourceRecord,
    ordinal: usize,
    sequence: usize,
    runtime: EngineTaskAgentWorkUnitRuntimeStatus,
    review: EngineTaskAgentWorkUnitReviewStatus,
    linkage: Option<&TaskExecutionLinkage>,
    receipt_id: Option<&EngineRuntimeReceiptRecordId>,
    summary: &str,
) -> Result<nucleus_engine::EngineTaskAgentWorkUnitSourceRecord, String>
where
    B: LocalStoreBackend,
{
    let mut refs = previous.refs.clone();
    if let Some(linkage) = linkage {
        refs.session_id = Some(AgentSessionId(linkage.session_id.clone()));
        if !refs.turn_ids.iter().any(|turn| turn.0 == linkage.turn_id) {
            refs.turn_ids.push(AgentTurnId(linkage.turn_id.clone()));
        }
    }
    if let Some(receipt_id) = receipt_id {
        if !refs.receipt_ids.contains(receipt_id) {
            refs.receipt_ids.push(receipt_id.clone());
        }
    }
    let source_id =
        EngineTaskAgentWorkUnitSourceId(format!("{}:event:{sequence}", previous.work_item_id.0));
    let next = nucleus_engine::EngineTaskAgentWorkUnitSourceRecord {
        source_id: source_id.clone(),
        source_cursor: nucleus_engine::EngineTaskAgentWorkUnitSourceCursor(format!(
            "zz:goal-run:{ordinal:03}:{sequence:03}:{}",
            previous.work_item_id.0
        )),
        runtime,
        review,
        refs,
        previous_source_id: Some(previous.source_id.clone()),
        summary: summary.chars().take(500).collect(),
        ..previous.clone()
    };
    write_task_agent_work_unit_source_record(
        state,
        next.clone(),
        RevisionId(format!("rev:{}", source_id.0)),
        RevisionExpectation::MustNotExist,
    )
    .map_err(|error| format!("failed to persist Goal task transition: {error:?}"))?;
    Ok(next)
}

fn latest_source<B>(
    state: &ServerStateService<B>,
    work_item_id: &str,
) -> Result<Option<nucleus_engine::EngineTaskAgentWorkUnitSourceRecord>, String>
where
    B: LocalStoreBackend,
{
    read_task_agent_work_unit_source_records(state)
        .map_err(|error| format!("failed to read Goal task work sources: {error:?}"))
        .map(|records| {
            records
                .into_iter()
                .filter(|source| source.work_item_id.0 == work_item_id)
                .max_by(|left, right| left.source_cursor.0.cmp(&right.source_cursor.0))
        })
}

fn runtime_receipt(
    plan: &GoalRunPlan,
    task: &GoalTaskExecutionRecord,
    status: EngineRuntimeReceiptStatus,
    linkage: Option<&TaskExecutionLinkage>,
    summary: &str,
) -> EngineRuntimeReceiptRecord {
    let receipt_id =
        EngineRuntimeReceiptRecordId(format!("receipt:{}:task:{}", plan.plan_id, task.ordinal));
    let mut evidence_refs = vec![
        EngineRuntimeReceiptRef::Custom(plan.mandate_id.clone()),
        EngineRuntimeReceiptRef::Custom(plan.plan_id.clone()),
        EngineRuntimeReceiptRef::Custom(task.dispatch.invocation_request_id.clone()),
    ];
    if let Some(linkage) = linkage {
        evidence_refs.push(EngineRuntimeReceiptRef::Custom(linkage.thread_id.clone()));
        evidence_refs.push(EngineRuntimeReceiptRef::Custom(linkage.turn_id.clone()));
    }
    EngineRuntimeReceiptRecord {
        receipt_id,
        family: EngineRuntimeReceiptEffectFamily::HarnessProvider,
        status,
        command_ref: Some(EngineRuntimeReceiptRef::CommandId(
            task.dispatch.command_id.clone(),
        )),
        effect_ref: linkage.map(|value| {
            EngineRuntimeReceiptRef::Custom(format!("provider-turn:{}", value.turn_id))
        }),
        evidence_refs,
        artifact_refs: Vec::new(),
        summary: Some(summary.chars().take(500).collect()),
    }
}

fn compose_dispatch(
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

fn task_prompt(plan: &GoalRunPlan, ordinal: usize, task: &crate::ControlTaskRecordDto) -> String {
    let criteria = task
        .acceptance_criteria
        .iter()
        .map(|criterion| format!("- {}", criterion.text))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "Execute this Nucleus task as position {} in {}.\n\nTitle: {}\nDescription: {}\nAction: {}\nAcceptance criteria:\n{}\nValidation commands:\n{}\nTask stop conditions:\n{}\n\nMake the required workspace changes and run proportionate validation. Do not complete or otherwise mutate the Nucleus task record. End with a concise result summary.",
        ordinal + 1,
        plan.goal_id
            .as_deref()
            .map(|goal_id| format!("Goal {goal_id}"))
            .unwrap_or_else(|| "the explicit single-task scope".to_owned()),
        task.title,
        task.description.as_deref().unwrap_or("No description supplied."),
        task.action_type,
        criteria,
        task.validation_commands.join("\n"),
        task.stop_conditions.join("\n")
    )
}

fn task_action(value: &str) -> Result<TaskActionType, String> {
    match value {
        "research" => Ok(TaskActionType::Research),
        "plan" => Ok(TaskActionType::Plan),
        "execute" => Ok(TaskActionType::Execute),
        "test" => Ok(TaskActionType::Test),
        "check" => Ok(TaskActionType::Check),
        "review" => Ok(TaskActionType::Review),
        other => Err(format!("unsupported task action type: {other}")),
    }
}

fn work_item_id(plan: &GoalRunPlan, task: &GoalRunPlanTask) -> String {
    format!("work-item:goal-run:{}:{}", plan.plan_id, task.task_id)
}

fn task_record_linkage(record: &GoalTaskExecutionRecord) -> Option<TaskExecutionLinkage> {
    Some(TaskExecutionLinkage {
        session_id: record.session_id.clone()?,
        thread_id: record.provider_thread_id.clone()?,
        turn_id: record.provider_turn_id.clone()?,
    })
}

fn upsert_task_execution(execution: &mut GoalRunExecutionRecord, task: GoalTaskExecutionRecord) {
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

fn update_execution<B>(
    state: &ServerStateService<B>,
    execution: &mut GoalRunExecutionRecord,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let previous = RevisionId(execution.revision_id.clone());
    let next = execution
        .revision_id
        .rsplit_once(':')
        .and_then(|(_, value)| value.parse::<u64>().ok())
        .unwrap_or(0)
        + 1;
    execution.revision_id = format!("rev:{}:{next}", execution.plan_id);
    persist_execution(state, execution, RevisionExpectation::Exact(previous))
}

fn stop_execution<B>(
    state: &ServerStateService<B>,
    plan: &GoalRunPlan,
    execution: &mut GoalRunExecutionRecord,
    reason: String,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    execution.status = GoalRunExecutionStatus::Stopped;
    execution.terminal_reason = Some(reason);
    update_execution(state, execution)?;
    expire_for_execution(state, plan, execution)
}

fn persist_execution<B>(
    state: &ServerStateService<B>,
    execution: &GoalRunExecutionRecord,
    expectation: RevisionExpectation,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let bytes = serde_json::to_vec(execution).map_err(|error| error.to_string())?;
    state
        .agent_sessions()
        .put(
            LocalStoreRecord {
                id: PersistenceRecordId(format!("{EXECUTION_PREFIX}{}", execution.plan_id)),
                revision_id: RevisionId(execution.revision_id.clone()),
                domain: PersistenceDomain::AgentSessions,
                kind: PersistenceRecordKind::AgentSession,
                payload: LocalStoreRecordPayload {
                    media_type: Some("application/json".to_owned()),
                    bytes,
                },
            },
            expectation,
        )
        .map(|_| ())
        .map_err(|error| format!("goal run execution persistence failed: {error:?}"))
}

fn read_execution<B>(
    state: &ServerStateService<B>,
    plan_id: &str,
) -> Result<Option<GoalRunExecutionRecord>, String>
where
    B: LocalStoreBackend,
{
    state
        .agent_sessions()
        .get(&PersistenceRecordId(format!("{EXECUTION_PREFIX}{plan_id}")))
        .map_err(|error| format!("goal run execution lookup failed: {error:?}"))?
        .map(|record| {
            serde_json::from_slice(&record.payload.bytes).map_err(|error| error.to_string())
        })
        .transpose()
}

fn expire_for_execution<B>(
    state: &ServerStateService<B>,
    plan: &GoalRunPlan,
    execution: &GoalRunExecutionRecord,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let mandate = read_workflow_mandate(state, &plan.mandate_id)?;
    if mandate.status != WorkflowMandateStatus::Active {
        return Ok(());
    }
    expire_workflow_mandate(
        state,
        &plan.mandate_id,
        &plan.mandate_revision,
        execution
            .terminal_reason
            .as_deref()
            .unwrap_or("Goal run reached a terminal execution outcome."),
        vec![execution.execution_id.clone()],
    )
    .map(|_| ())
}

fn now_epoch_seconds() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| "system clock is before the Unix epoch".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_codex_chat::goal_run::tests::{fixture, run_request};
    use crate::local_codex_chat::{admit_goal_run, GoalRunOutcome};
    use crate::runtime_receipt_state::read_runtime_receipts;
    use nucleus_local_store::{LocalStoreRecordPayload, RevisionExpectation};

    #[test]
    fn two_task_goal_executes_serially_and_stops_at_reviewable_results() {
        let fixture = fixture(true);
        let plan = admitted_plan(&fixture.state, &fixture.mandate, "execute:two");
        let mut calls = 0;
        let execution = execute_goal_run_with(
            &fixture.state,
            GoalRunExecutionRequest {
                plan_id: plan.plan_id.clone(),
                expected_plan_revision: plan.revision_id.clone(),
            },
            &mut |_, on_started| {
                calls += 1;
                let linkage = linkage(calls);
                on_started(&linkage)?;
                Ok(TaskExecutionOutcome::Completed(linkage))
            },
        )
        .expect("execute Goal");

        assert_eq!(calls, 2);
        assert_eq!(execution.status, GoalRunExecutionStatus::Completed);
        assert_eq!(execution.task_executions.len(), 2);
        assert!(execution
            .task_executions
            .iter()
            .all(|task| task.status == "completed"));
        assert!(execution
            .task_executions
            .iter()
            .all(|task| !task.dispatch.invocation_request_id.is_empty()));
        assert_eq!(
            read_runtime_receipts(&fixture.state)
                .expect("runtime receipts")
                .len(),
            2
        );
        assert_eq!(
            read_task_agent_work_unit_source_records(&fixture.state)
                .expect("work sources")
                .len(),
            6
        );
        let tasks = fixture.state.tasks().list().expect("tasks");
        assert_eq!(tasks.len(), 2);
        assert!(tasks.iter().all(|record| {
            crate::ControlTaskRecordDto::try_from(record).is_ok_and(|task| task.activity == "ready")
        }));
        assert_eq!(
            read_workflow_mandate(&fixture.state, &fixture.mandate.mandate_id)
                .expect("expired mandate")
                .status,
            WorkflowMandateStatus::Expired
        );
        assert!(!execution.task_completion_permitted);
        assert!(!execution.review_acceptance_permitted);
        assert!(!execution.goal_achievement_permitted);
        assert!(!execution.scm_mutation_permitted);
    }

    #[test]
    fn failure_stops_before_scheduling_the_next_goal_task() {
        let fixture = fixture(true);
        let plan = admitted_plan(&fixture.state, &fixture.mandate, "execute:failure");
        let mut calls = 0;
        let execution = execute_goal_run_with(
            &fixture.state,
            GoalRunExecutionRequest {
                plan_id: plan.plan_id.clone(),
                expected_plan_revision: plan.revision_id,
            },
            &mut |_, on_started| {
                calls += 1;
                let linkage = linkage(calls);
                on_started(&linkage)?;
                Ok(TaskExecutionOutcome::Failed {
                    linkage: Some(linkage),
                    reason: "validation failed".to_owned(),
                })
            },
        )
        .expect("stopped Goal");

        assert_eq!(calls, 1);
        assert_eq!(execution.status, GoalRunExecutionStatus::Stopped);
        assert_eq!(execution.task_executions.len(), 1);
        assert_eq!(execution.task_executions[0].status, "failed");
        assert_eq!(
            read_task_agent_work_unit_source_records(&fixture.state)
                .expect("work sources")
                .len(),
            3
        );
    }

    #[test]
    fn interactive_wait_is_recorded_then_closed_as_recovery_required() {
        let fixture = fixture(true);
        let plan = admitted_plan(&fixture.state, &fixture.mandate, "execute:wait");
        let execution = execute_goal_run_with(
            &fixture.state,
            GoalRunExecutionRequest {
                plan_id: plan.plan_id.clone(),
                expected_plan_revision: plan.revision_id,
            },
            &mut |_, on_started| {
                let linkage = linkage(1);
                on_started(&linkage)?;
                Ok(TaskExecutionOutcome::WaitingForUserInput(linkage))
            },
        )
        .expect("wait outcome");

        assert_eq!(execution.status, GoalRunExecutionStatus::RecoveryRequired);
        assert_eq!(
            execution.task_executions[0].status,
            "waiting_for_user_input"
        );
        let sources =
            read_task_agent_work_unit_source_records(&fixture.state).expect("work sources");
        assert!(sources.iter().any(|source| matches!(
            source.runtime,
            EngineTaskAgentWorkUnitRuntimeStatus::WaitingForUserInput
        )));
        assert!(sources.iter().any(|source| matches!(
            source.runtime,
            EngineTaskAgentWorkUnitRuntimeStatus::RecoveryRequired(_)
        )));
    }

    #[test]
    fn mandate_revocation_stops_before_the_next_serial_task() {
        let fixture = fixture(true);
        let plan = admitted_plan(&fixture.state, &fixture.mandate, "execute:revoke");
        let mut calls = 0;
        let execution = execute_goal_run_with(
            &fixture.state,
            GoalRunExecutionRequest {
                plan_id: plan.plan_id,
                expected_plan_revision: plan.revision_id,
            },
            &mut |_, on_started| {
                calls += 1;
                let linkage = linkage(calls);
                on_started(&linkage)?;
                crate::local_codex_chat::revoke_workflow_mandate(
                    &fixture.state,
                    &fixture.mandate.mandate_id,
                    &fixture.mandate.revision_id,
                    "operator revoked execution",
                )?;
                Ok(TaskExecutionOutcome::Completed(linkage))
            },
        )
        .expect("revoked Goal");

        assert_eq!(calls, 1);
        assert_eq!(execution.status, GoalRunExecutionStatus::Stopped);
        assert!(execution
            .terminal_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("no longer active")));
    }

    #[test]
    fn repeated_execution_returns_the_terminal_record_without_provider_replay() {
        let fixture = fixture(true);
        let plan = admitted_plan(&fixture.state, &fixture.mandate, "execute:idem");
        let request = GoalRunExecutionRequest {
            plan_id: plan.plan_id,
            expected_plan_revision: plan.revision_id,
        };
        let first = execute_goal_run_with(&fixture.state, request.clone(), &mut |_, on_started| {
            let linkage = linkage(1);
            on_started(&linkage)?;
            Ok(TaskExecutionOutcome::Failed {
                linkage: Some(linkage),
                reason: "stop".to_owned(),
            })
        })
        .expect("first execution");
        let mut replay_calls = 0;
        let repeated = execute_goal_run_with(&fixture.state, request, &mut |_, _| {
            replay_calls += 1;
            Err("must not replay".to_owned())
        })
        .expect("repeat execution");

        assert_eq!(replay_calls, 0);
        assert_eq!(repeated, first);
    }

    #[test]
    #[ignore = "requires a locally authenticated Codex app-server"]
    fn authenticated_single_task_runner_performs_a_workspace_write() {
        let workspace = tempfile::tempdir().expect("workspace");
        let root = workspace.path().to_string_lossy().into_owned();
        let route = GoalRunRoute {
            adapter_id: "codex-app-server".to_owned(),
            provider_instance_id: "codex:local-default".to_owned(),
            model: "gpt-5.4-mini".to_owned(),
            reasoning_effort: Some("low".to_owned()),
        };
        let mut started = false;
        let outcome = run_task(
            TaskExecutionRequest {
                project_root: &root,
                route: &route,
                prompt: "Create a UTF-8 file named nucleus-single-task-smoke.txt containing exactly the text nucleus task smoke ok followed by a newline. Do nothing else.",
            },
            |_| {
                started = true;
                Ok(())
            },
        )
        .expect("live task");

        assert!(started);
        assert!(matches!(outcome, TaskExecutionOutcome::Completed(_)));
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("nucleus-single-task-smoke.txt"))
                .expect("smoke file"),
            "nucleus task smoke ok\n"
        );
    }

    #[test]
    #[ignore = "requires a locally authenticated Codex app-server"]
    fn authenticated_two_task_goal_reaches_two_serial_provider_turns() {
        let fixture = fixture(true);
        let workspace = tempfile::tempdir().expect("workspace");
        redirect_project_root(&fixture.state, workspace.path());
        let plan = admitted_plan(&fixture.state, &fixture.mandate, "execute:live-two");
        let execution = execute_goal_run(
            &fixture.state,
            GoalRunExecutionRequest {
                plan_id: plan.plan_id,
                expected_plan_revision: plan.revision_id,
            },
        )
        .expect("live Goal execution");

        assert_eq!(execution.status, GoalRunExecutionStatus::Completed);
        assert_eq!(execution.task_executions.len(), 2);
        assert!(execution
            .task_executions
            .iter()
            .all(|task| task.provider_turn_id.is_some()));
    }

    fn admitted_plan(
        state: &ServerStateService<nucleus_local_store::SqliteBackend>,
        mandate: &super::super::WorkflowMandate,
        key: &str,
    ) -> GoalRunPlan {
        match admit_goal_run(state, run_request(mandate, key)).expect("admit Goal") {
            GoalRunOutcome::Admitted { plan } => plan,
            other => panic!("expected plan, got {other:?}"),
        }
    }

    fn linkage(index: usize) -> TaskExecutionLinkage {
        TaskExecutionLinkage {
            session_id: format!("session:{index}"),
            thread_id: format!("thread:{index}"),
            turn_id: format!("turn:{index}"),
        }
    }

    fn redirect_project_root(
        state: &ServerStateService<nucleus_local_store::SqliteBackend>,
        root: &std::path::Path,
    ) {
        let id = PersistenceRecordId("project:nucleus-local".to_owned());
        let mut record = state
            .projects()
            .get(&id)
            .expect("project lookup")
            .expect("project");
        let previous = record.revision_id.clone();
        let mut project =
            nucleus_projects::decode_project_storage_record(&record.payload.bytes).expect("decode");
        project.repo_count = 1;
        project.primary_location = Some(root.to_string_lossy().into_owned());
        project.location_status = nucleus_projects::ProjectStorageLocationStatus::Present;
        record.revision_id = RevisionId("rev:project:live-smoke".to_owned());
        record.payload = LocalStoreRecordPayload {
            media_type: Some("application/json".to_owned()),
            bytes: nucleus_projects::encode_project_storage_payload(&project).expect("encode"),
        };
        state
            .projects()
            .put(record, RevisionExpectation::Exact(previous))
            .expect("redirect project");
    }
}
