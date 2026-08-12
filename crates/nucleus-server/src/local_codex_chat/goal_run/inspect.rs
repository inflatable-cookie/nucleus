//! Goal run inspection: mandate authority validation and task-readiness
//! inspection over the mandate's ordered task snapshot.
//!
//! Split from the goal_run god file; behavior unchanged.

use std::collections::HashMap;

use nucleus_engine::{
    project_task_agent_work_units, EngineTaskAgentWorkUnitRuntimeStatus,
};
use nucleus_local_store::LocalStoreBackend;

use super::super::goal_inspection::goal_record;
use super::super::mandates::{
    read_workflow_mandate, WorkflowMandate, WorkflowMandateScope, WorkflowMandateStatus,
};
use super::super::persistence::{read_session, StoredChatSession};
use super::super::task_inspection::active_task;
use super::types::{
    GoalRunAdmissionRequest, GoalRunBlocker, GoalRunInspection, GoalRunRoute,
    GoalRunTaskInspection,
};
use crate::task_agent_work_unit_state::read_task_agent_work_unit_source_records;
use crate::{ControlTaskRecordDto, ServerStateService};

pub(super) fn validate_goal_run_authority<B>(
    state: &ServerStateService<B>,
    request: &GoalRunAdmissionRequest,
) -> Result<WorkflowMandate, String>
where
    B: LocalStoreBackend,
{
    if request.idempotency_key.trim().is_empty() {
        return Err("goal run idempotency key must not be empty".to_owned());
    }
    let mandate = read_workflow_mandate(state, &request.mandate_id)?;
    if mandate.revision_id != request.expected_mandate_revision {
        return Err("goal run mandate revision conflict".to_owned());
    }
    if mandate.status != WorkflowMandateStatus::Active {
        return Err("workflow run mandate is not active".to_owned());
    }
    if request.now_epoch_seconds >= mandate.expires_at_epoch_seconds {
        return Err("goal run mandate has expired".to_owned());
    }
    Ok(mandate)
}

pub fn inspect_goal_run<B>(
    state: &ServerStateService<B>,
    request: &GoalRunAdmissionRequest,
) -> Result<GoalRunInspection, String>
where
    B: LocalStoreBackend,
{
    let mandate = validate_goal_run_authority(state, request)?;

    let goal = match &mandate.scope {
        WorkflowMandateScope::Goal { goal_id, .. } => {
            Some(goal_record(state, &mandate.project_id, goal_id)?)
        }
        WorkflowMandateScope::Task { .. } => None,
    };
    let session = read_session(state, &mandate.conversation_id)?
        .ok_or_else(|| "goal run conversation session is unavailable".to_owned())?;
    let route = route_from_session(&session);
    let mut blockers = Vec::new();
    if goal
        .as_ref()
        .is_some_and(|goal| !matches!(goal.status.as_str(), "ready" | "active"))
    {
        let goal = goal.as_ref().expect("checked Goal");
        blockers.push(GoalRunBlocker {
            scope: "goal".to_owned(),
            subject_ref: goal.goal_id.clone(),
            reason: goal
                .blocked_reason
                .clone()
                .unwrap_or_else(|| format!("Goal status is {}", goal.status)),
        });
    }
    if route.is_none() {
        blockers.push(GoalRunBlocker {
            scope: "route".to_owned(),
            subject_ref: mandate.conversation_id.clone(),
            reason: "Conversation has no complete adapter, provider, and model route".to_owned(),
        });
    }

    let active_work = active_work_by_task(state, &mandate.project_id)?;
    let mut tasks = Vec::with_capacity(mandate.ordered_task_snapshot.len());
    let mut completed_task_count = 0;
    for (ordinal, snapshot) in mandate.ordered_task_snapshot.iter().enumerate() {
        let task = active_task(state, &mandate.project_id, &snapshot.task_id)?;
        let dependencies = dependency_refs(&task);
        let terminal = matches!(task.activity.as_str(), "done" | "archived");
        if terminal {
            completed_task_count += 1;
        }
        if task.revision_id != snapshot.revision_id {
            blockers.push(task_blocker(
                &task,
                "Task changed after the mandate snapshot",
            ));
        }
        if !terminal && task.activity != "ready" {
            blockers.push(task_blocker(
                &task,
                &format!("Task activity is {}", task.activity),
            ));
        }
        if !terminal && !task.agent_ready {
            blockers.push(task_blocker(&task, "Task is not agent-ready"));
        }
        if let Some(work_item_id) = active_work.get(&task.task_id) {
            blockers.push(task_blocker(
                &task,
                &format!("Task already has active work: {work_item_id}"),
            ));
        }
        for dependency_id in &dependencies {
            if let Some(dependency_ordinal) = mandate
                .ordered_task_snapshot
                .iter()
                .position(|candidate| candidate.task_id == *dependency_id)
            {
                if dependency_ordinal >= ordinal {
                    blockers.push(task_blocker(
                        &task,
                        &format!(
                            "Dependency {dependency_id} does not precede this task in Goal order"
                        ),
                    ));
                }
            } else {
                let dependency = active_task(state, &mandate.project_id, dependency_id)?;
                if !matches!(dependency.activity.as_str(), "done" | "archived") {
                    blockers.push(task_blocker(
                        &task,
                        &format!("External dependency is not terminal: {dependency_id}"),
                    ));
                }
            }
        }
        tasks.push(GoalRunTaskInspection {
            task_id: task.task_id,
            revision_id: task.revision_id,
            title: task.title,
            activity: task.activity,
            agent_ready: task.agent_ready,
            dependency_task_refs: dependencies,
            stop_conditions: task.stop_conditions,
            disposition: if terminal {
                "already_terminal".to_owned()
            } else {
                "pending".to_owned()
            },
        });
    }
    let remaining_task_count = tasks.len().saturating_sub(completed_task_count);
    if remaining_task_count == 0 {
        blockers.push(GoalRunBlocker {
            scope: "workflow".to_owned(),
            subject_ref: mandate.mandate_id.clone(),
            reason: "Workflow mandate contains no remaining task to execute".to_owned(),
        });
    }
    let available_outcomes = if blockers.is_empty() {
        vec!["admit_serial_run".to_owned()]
    } else {
        vec!["blocked".to_owned()]
    };
    Ok(GoalRunInspection {
        mandate_id: mandate.mandate_id,
        operator_message_id: mandate.operator_message_id,
        project_id: mandate.project_id,
        scope_kind: match mandate.scope {
            WorkflowMandateScope::Goal { .. } => "goal".to_owned(),
            WorkflowMandateScope::Task { .. } => "task".to_owned(),
        },
        goal_id: goal.as_ref().map(|goal| goal.goal_id.clone()),
        goal_revision: goal.as_ref().map(|goal| goal.revision_id.clone()),
        goal_status: goal.as_ref().map(|goal| goal.status.clone()),
        goal_stop_conditions: goal.map(|goal| goal.stop_conditions).unwrap_or_default(),
        ordered_tasks: tasks,
        completed_task_count,
        remaining_task_count,
        route,
        blockers,
        available_outcomes,
    })
}

fn active_work_by_task<B>(
    state: &ServerStateService<B>,
    project_id: &str,
) -> Result<HashMap<String, String>, String>
where
    B: LocalStoreBackend,
{
    let records = read_task_agent_work_unit_source_records(state)
        .map_err(|error| format!("goal run active-work inspection failed: {error:?}"))?;
    Ok(project_task_agent_work_units(&records)
        .into_iter()
        .filter(|projection| projection.project_id.0 == project_id)
        .filter(|projection| {
            matches!(
                projection.runtime,
                EngineTaskAgentWorkUnitRuntimeStatus::Scheduled
                    | EngineTaskAgentWorkUnitRuntimeStatus::Running
                    | EngineTaskAgentWorkUnitRuntimeStatus::WaitingForApproval
                    | EngineTaskAgentWorkUnitRuntimeStatus::WaitingForUserInput
            )
        })
        .map(|projection| (projection.task_id.0, projection.work_item_id.0))
        .collect())
}

fn dependency_refs(task: &ControlTaskRecordDto) -> Vec<String> {
    task.required_context_refs
        .iter()
        .filter(|reference| reference.starts_with("task:"))
        .cloned()
        .collect()
}

fn route_from_session(session: &StoredChatSession) -> Option<GoalRunRoute> {
    if session.adapter_id.trim().is_empty()
        || session.provider_instance_id.trim().is_empty()
        || session.model.trim().is_empty()
    {
        return None;
    }
    Some(GoalRunRoute {
        adapter_id: session.adapter_id.clone(),
        provider_instance_id: session.provider_instance_id.clone(),
        model: session.model.clone(),
        reasoning_effort: session.reasoning_effort.clone(),
    })
}

fn task_blocker(task: &ControlTaskRecordDto, reason: &str) -> GoalRunBlocker {
    GoalRunBlocker {
        scope: "task".to_owned(),
        subject_ref: task.task_id.clone(),
        reason: reason.to_owned(),
    }
}
