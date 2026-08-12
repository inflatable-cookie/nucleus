//! Goal run admission: blocker-free inspection, rework context validation,
//! and first-work-item scheduling with an idempotent persisted plan.
//!
//! Split from the goal_run god file; behavior unchanged.

use nucleus_core::{PersistenceRecordId, RevisionId};
use nucleus_engine::admit_task_agent_work_unit;
use nucleus_engine::{
    EngineTaskWorkItemAssignment, EngineTaskWorkItemId, EngineTaskWorkItemRecord,
    EngineTaskWorkItemRefs, EngineTaskWorkItemReviewState, EngineTaskWorkItemRuntimeState,
};
use nucleus_local_store::{LocalStoreBackend, RevisionExpectation};
use nucleus_projects::ProjectId;
use nucleus_tasks::{TaskActionType, TaskId};

use super::inspect::{inspect_goal_run, validate_goal_run_authority};
use super::plan_store::{persist_plan, read_goal_run_plan};
use super::super::rework_context::current_task_review_context;
use super::super::task_inspection::active_task;
use super::types::{
    GoalRunAdmissionRequest, GoalRunInspection, GoalRunOutcome, GoalRunPlan, GoalRunPlanTask,
};
use crate::task_agent_work_unit_state::write_task_agent_work_unit_source_record;
use crate::ServerStateService;

pub fn admit_goal_run<B>(
    state: &ServerStateService<B>,
    request: GoalRunAdmissionRequest,
) -> Result<GoalRunOutcome, String>
where
    B: LocalStoreBackend,
{
    validate_goal_run_authority(state, &request)?;
    let plan_id = plan_id(&request.mandate_id, &request.idempotency_key);
    if let Some(plan) = read_goal_run_plan(state, &plan_id)? {
        return Ok(GoalRunOutcome::Admitted { plan });
    }
    let inspection = inspect_goal_run(state, &request)?;
    if !inspection.blockers.is_empty() {
        return Ok(GoalRunOutcome::Blocked { inspection });
    }
    validate_rework_context(state, &inspection, &request)?;
    let route = inspection
        .route
        .clone()
        .ok_or_else(|| "goal run route disappeared after inspection".to_owned())?;
    let first_index = inspection
        .ordered_tasks
        .iter()
        .position(|task| task.disposition == "pending")
        .ok_or_else(|| "goal run has no pending task".to_owned())?;
    let first = &inspection.ordered_tasks[first_index];
    let work_item_id = format!("work-item:goal-run:{plan_id}:{}", first.task_id);
    let command_id = format!("command:{plan_id}");
    let mut refs = EngineTaskWorkItemRefs::default();
    if let Some(decision_ref) = request.rework_decision_ref.as_ref() {
        refs.artifact_refs.push(decision_ref.clone());
        refs.artifact_refs
            .extend(request.reviewed_work_item_refs.clone());
        refs.artifact_refs
            .extend(request.reviewed_evidence_refs.clone());
        refs.artifact_refs.sort();
        refs.artifact_refs.dedup();
    }
    let work_item = EngineTaskWorkItemRecord {
        work_item_id: EngineTaskWorkItemId(work_item_id.clone()),
        task_id: TaskId(first.task_id.clone()),
        project_id: ProjectId(inspection.project_id.clone()),
        title: format!("Goal run work for {}", first.title),
        intent: task_action(
            &active_task(state, &inspection.project_id, &first.task_id)?.action_type,
        )?,
        assignment: EngineTaskWorkItemAssignment::AdapterInstance {
            adapter_id: route.adapter_id.clone(),
            provider_instance_id: route.provider_instance_id.clone(),
        },
        runtime: EngineTaskWorkItemRuntimeState::Scheduled,
        review: EngineTaskWorkItemReviewState::NotReady,
        refs,
        summary: Some(format!(
            "Goal run admitted from mandate {}; provider execution deferred",
            inspection.mandate_id
        )),
    };
    let admission = admit_task_agent_work_unit(
        &command_id,
        &inspection.operator_message_id,
        &request.idempotency_key,
        Some(RevisionId(first.revision_id.clone())),
        &work_item,
    );
    let source_revision = RevisionId(format!("rev:{}", admission.source_record.source_id.0));
    write_task_agent_work_unit_source_record(
        state,
        admission.source_record.clone(),
        source_revision.clone(),
        RevisionExpectation::MustNotExist,
    )
    .map_err(|error| format!("goal run work-item admission failed: {error:?}"))?;

    let plan = GoalRunPlan {
        plan_id: plan_id.clone(),
        mandate_id: inspection.mandate_id,
        mandate_revision: request.expected_mandate_revision,
        operator_message_id: inspection.operator_message_id,
        project_id: inspection.project_id,
        scope_kind: inspection.scope_kind,
        goal_id: inspection.goal_id,
        goal_revision: inspection.goal_revision,
        ordered_tasks: inspection
            .ordered_tasks
            .iter()
            .enumerate()
            .map(|(ordinal, task)| GoalRunPlanTask {
                ordinal,
                task_id: task.task_id.clone(),
                revision_id: task.revision_id.clone(),
                disposition: if ordinal == first_index {
                    "scheduled".to_owned()
                } else {
                    task.disposition.clone()
                },
                rework_decision_ref: (ordinal == first_index)
                    .then(|| request.rework_decision_ref.clone())
                    .flatten(),
                rework_reason: (ordinal == first_index)
                    .then(|| request.rework_reason.clone())
                    .flatten(),
                reviewed_work_item_refs: if ordinal == first_index {
                    request.reviewed_work_item_refs.clone()
                } else {
                    Vec::new()
                },
                reviewed_evidence_refs: if ordinal == first_index {
                    request.reviewed_evidence_refs.clone()
                } else {
                    Vec::new()
                },
            })
            .collect(),
        current_task_index: first_index,
        first_work_item_id: work_item_id,
        first_work_unit_source_id: admission.source_record.source_id.0,
        route,
        idempotency_key: request.idempotency_key,
        provider_execution_deferred: admission.provider_execution_deferred,
        revision_id: format!("rev:{plan_id}:admitted"),
    };
    if let Err(plan_error) = persist_plan(state, &plan) {
        state
            .task_history()
            .delete(
                &PersistenceRecordId(plan.first_work_unit_source_id.clone()),
                RevisionExpectation::Exact(source_revision),
            )
            .map_err(|cleanup_error| {
                format!("{plan_error}; goal run source cleanup also failed: {cleanup_error:?}")
            })?;
        return Err(plan_error);
    }
    Ok(GoalRunOutcome::Admitted { plan })
}

fn validate_rework_context<B>(
    state: &ServerStateService<B>,
    inspection: &GoalRunInspection,
    request: &GoalRunAdmissionRequest,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    if inspection.scope_kind != "task" {
        if request.rework_decision_ref.is_some()
            || request.rework_reason.is_some()
            || !request.reviewed_work_item_refs.is_empty()
            || !request.reviewed_evidence_refs.is_empty()
        {
            return Err("Goal runs cannot carry task rework context".to_owned());
        }
        return Ok(());
    }

    let task_id = &inspection
        .ordered_tasks
        .first()
        .ok_or_else(|| "task run inspection has no task".to_owned())?
        .task_id;
    let current = current_task_review_context(state, &inspection.project_id, task_id)?;
    match current {
        None if request.rework_decision_ref.is_none() => Ok(()),
        None => Err("rework request has no current durable review decision".to_owned()),
        Some(context) if !context.rework_ready => {
            Err("current task review outcome does not admit rework execution".to_owned())
        }
        Some(context)
            if request.rework_decision_ref.as_deref() == Some(&context.decision_ref)
                && request.rework_reason == context.reason
                && request.reviewed_work_item_refs == context.reviewed_work_item_refs
                && request.reviewed_evidence_refs == context.reviewed_evidence_refs =>
        {
            Ok(())
        }
        Some(_) => Err("rework request does not match current durable review context".to_owned()),
    }
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

fn plan_id(mandate_id: &str, idempotency_key: &str) -> String {
    format!("goal-run:{mandate_id}:{idempotency_key}")
}
