use std::time::{SystemTime, UNIX_EPOCH};

use nucleus_engine::{project_task_agent_work_units, EngineTaskAgentWorkUnitRuntimeStatus};
use nucleus_local_store::LocalStoreBackend;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::goal_execution::{
    execute_goal_run_for_resource, GoalRunExecutionRequest, GoalRunExecutionStatus,
};
use super::goal_inspection::goal_record;
use super::goal_run::{
    admit_goal_run, read_goal_run_plan, GoalRunAdmissionRequest, GoalRunOutcome,
};
use super::mandates::{
    create_workflow_mandate, expire_workflow_mandate, find_workflow_mandate, WorkflowMandate,
    WorkflowMandateAdmission, WorkflowMandateScope, WorkflowMandateStatus,
};
use super::persistence::{current_turn, operator_message_id};
use super::rework_context::current_task_review_context;
use super::task_authoring::{safe_ref, TaskToolOutcome};
use super::task_inspection::active_task;
use crate::task_agent_work_unit_state::read_task_agent_work_unit_source_records;
use crate::{ServerStateService, TaskReviewSnapshotStore};

const MANDATE_TTL_SECONDS: u64 = 60 * 60;

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
struct TaskWorkflowInput {
    action: String,
    scope: String,
    #[serde(default)]
    task_id: Option<String>,
    #[serde(default)]
    goal_id: Option<String>,
    #[serde(default)]
    expected_revision: Option<String>,
    #[serde(default)]
    operator_message_excerpt: Option<String>,
    #[serde(default)]
    idempotency_key: Option<String>,
}

pub(super) fn dynamic_tool_spec() -> Value {
    json!({
        "type": "function",
        "name": "task_workflow",
        "description": "Inspect or run one durable Nucleus task or one Goal's ordered task snapshot. Task inspection includes the current durable review context. A fresh task run after rejected or needs-changes review carries that note and prior evidence refs into a new work item. Run requires an exact excerpt from the current operator message, the current scope revision, and an idempotency key. It performs the complete provider handoff; it does not accept review, complete tasks, achieve Goals, or publish SCM changes.",
        "inputSchema": {
            "type": "object",
            "required": ["action", "scope"],
            "additionalProperties": false,
            "properties": {
                "action": { "type": "string", "enum": ["inspect", "run"] },
                "scope": { "type": "string", "enum": ["task", "goal"] },
                "task_id": { "type": "string", "description": "Required only for task scope." },
                "goal_id": { "type": "string", "description": "Required only for Goal scope." },
                "expected_revision": { "type": "string", "description": "Run only. Current task or Goal revision." },
                "operator_message_excerpt": { "type": "string", "description": "Run only. Exact non-empty excerpt from the current operator message that grants execution authority." },
                "idempotency_key": { "type": "string", "description": "Run only. Stable key for this bounded execution intent." }
            }
        }
    })
}

pub(super) fn execute<B>(
    state: &ServerStateService<B>,
    snapshot_store: Option<&TaskReviewSnapshotStore>,
    project_id: &str,
    conversation_id: &str,
    resource_id: Option<&str>,
    arguments: Value,
) -> Result<TaskToolOutcome, String>
where
    B: LocalStoreBackend,
{
    let input: TaskWorkflowInput = serde_json::from_value(arguments)
        .map_err(|error| format!("invalid task_workflow input: {error}"))?;
    validate_scope_fields(&input)?;
    match input.action.as_str() {
        "inspect" => inspect(state, project_id, input),
        "run" => run(
            state,
            snapshot_store,
            project_id,
            conversation_id,
            resource_id,
            input,
        ),
        action => Err(format!("unsupported task_workflow action: {action}")),
    }
}

fn inspect<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    input: TaskWorkflowInput,
) -> Result<TaskToolOutcome, String>
where
    B: LocalStoreBackend,
{
    reject_run_fields_for_inspect(&input)?;
    let value = match input.scope.as_str() {
        "task" => {
            let task_id = input.task_id.as_deref().expect("validated task scope");
            let task = active_task(state, project_id, task_id)?;
            let review = current_task_review_context(state, project_id, task_id)?;
            let mut blockers = task_blockers(state, project_id, &task)?;
            for dependency_id in task
                .required_context_refs
                .iter()
                .filter(|reference| reference.starts_with("task:"))
            {
                let dependency = active_task(state, project_id, dependency_id)?;
                if !matches!(dependency.activity.as_str(), "done" | "archived") {
                    blockers.push(format!(
                        "Task {} dependency is not terminal: {dependency_id}",
                        task.task_id
                    ));
                }
            }
            json!({
                "scope": "task",
                "task": task,
                "review": review,
                "ready_to_run": blockers.is_empty(),
                "blockers": blockers,
                "available_outcomes": if blockers.is_empty() { vec!["run"] } else { vec!["blocked"] }
            })
        }
        "goal" => {
            let goal_id = input.goal_id.as_deref().expect("validated Goal scope");
            let goal = goal_record(state, project_id, goal_id)?;
            let mut tasks = Vec::with_capacity(goal.ordered_task_refs.len());
            let mut blockers = Vec::new();
            if !matches!(goal.status.as_str(), "ready" | "active") {
                blockers.push(format!("Goal status is {}", goal.status));
            }
            for (ordinal, task_id) in goal.ordered_task_refs.iter().enumerate() {
                let task = active_task(state, project_id, task_id)?;
                blockers.extend(task_blockers(state, project_id, &task)?);
                for dependency_id in task
                    .required_context_refs
                    .iter()
                    .filter(|reference| reference.starts_with("task:"))
                {
                    if let Some(dependency_ordinal) = goal
                        .ordered_task_refs
                        .iter()
                        .position(|candidate| candidate == dependency_id)
                    {
                        if dependency_ordinal >= ordinal {
                            blockers.push(format!(
                                "Task {} dependency {dependency_id} does not precede it in Goal order",
                                task.task_id
                            ));
                        }
                    } else {
                        let dependency = active_task(state, project_id, dependency_id)?;
                        if !matches!(dependency.activity.as_str(), "done" | "archived") {
                            blockers.push(format!(
                                "Task {} external dependency is not terminal: {dependency_id}",
                                task.task_id
                            ));
                        }
                    }
                }
                tasks.push(task);
            }
            if tasks.is_empty() {
                blockers.push("Goal has no ordered tasks".to_owned());
            }
            json!({
                "scope": "goal",
                "goal": goal,
                "tasks": tasks,
                "ready_to_run": blockers.is_empty(),
                "blockers": blockers,
                "available_outcomes": if blockers.is_empty() { vec!["run"] } else { vec!["blocked"] }
            })
        }
        _ => unreachable!("validated scope"),
    };
    Ok(TaskToolOutcome::text(
        serde_json::to_string(&value)
            .map_err(|error| format!("failed to encode task_workflow inspection: {error}"))?,
    ))
}

fn run<B>(
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

fn task_blockers<B>(
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

fn validate_scope_fields(input: &TaskWorkflowInput) -> Result<(), String> {
    match input.scope.as_str() {
        "task" if input.task_id.is_some() && input.goal_id.is_none() => Ok(()),
        "goal" if input.goal_id.is_some() && input.task_id.is_none() => Ok(()),
        "task" => Err("task_workflow task scope requires only task_id".to_owned()),
        "goal" => Err("task_workflow Goal scope requires only goal_id".to_owned()),
        scope => Err(format!("unsupported task_workflow scope: {scope}")),
    }
}

fn reject_run_fields_for_inspect(input: &TaskWorkflowInput) -> Result<(), String> {
    if input.expected_revision.is_some()
        || input.operator_message_excerpt.is_some()
        || input.idempotency_key.is_some()
    {
        Err("task_workflow inspect does not accept run authority fields".to_owned())
    } else {
        Ok(())
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_codex_chat::goal_run::tests::fixture;

    #[test]
    fn tool_schema_exposes_two_actions_without_atomic_workflow_stages() {
        let schema = dynamic_tool_spec();
        let encoded = serde_json::to_string(&schema).expect("schema");
        assert!(encoded.contains("task_workflow"));
        assert!(encoded.contains("inspect"));
        assert!(encoded.contains("run"));
        for forbidden in [
            "start_task",
            "schedule_task",
            "delegate_task",
            "select_adapter",
        ] {
            assert!(!encoded.contains(forbidden));
        }
    }

    #[test]
    fn arbitrary_task_arrays_are_rejected_by_the_portal_schema() {
        let error = serde_json::from_value::<TaskWorkflowInput>(json!({
            "action": "run",
            "scope": "task",
            "task_id": "task:1",
            "task_ids": ["task:1", "task:2"]
        }))
        .expect_err("task arrays");
        assert!(error.to_string().contains("unknown field"));
    }

    #[test]
    fn inspect_reads_one_task_without_creating_execution_authority() {
        let fixture = fixture(true);
        let outcome = execute(
            &fixture.state,
            None,
            "project:nucleus-local",
            "conversation:goal-run",
            None,
            json!({
                "action": "inspect",
                "scope": "task",
                "task_id": fixture.mandate.ordered_task_snapshot[0].task_id
            }),
        )
        .expect("inspect task");

        assert!(outcome.text.contains("ready_to_run"));
        assert!(outcome.receipt.is_none());
        assert!(outcome.workflow_receipt.is_none());
    }

    #[test]
    fn blocked_goal_run_returns_one_compact_receipt_without_provider_execution() {
        let fixture = fixture(false);
        let (goal_id, goal_revision) = match &fixture.mandate.scope {
            WorkflowMandateScope::Goal {
                goal_id,
                goal_revision,
            } => (goal_id, goal_revision),
            WorkflowMandateScope::Task { .. } => panic!("expected Goal scope"),
        };
        let outcome = execute(
            &fixture.state,
            None,
            "project:nucleus-local",
            "conversation:goal-run",
            None,
            json!({
                "action": "run",
                "scope": "goal",
                "goal_id": goal_id,
                "expected_revision": goal_revision,
                "operator_message_excerpt": "Execute this Goal",
                "idempotency_key": "portal-blocked"
            }),
        )
        .expect("blocked run");

        let receipt = outcome.workflow_receipt.expect("workflow receipt");
        assert_eq!(receipt.status, TaskWorkflowReceiptStatus::Blocked);
        assert!(receipt.plan_id.is_none());
        assert!(fixture
            .state
            .runtime_effects()
            .list()
            .expect("effects")
            .is_empty());
    }

    #[test]
    fn single_task_mandate_admits_exactly_one_task_without_a_goal() {
        let fixture = fixture(true);
        let task = active_task(
            &fixture.state,
            "project:nucleus-local",
            &fixture.mandate.ordered_task_snapshot[0].task_id,
        )
        .expect("task");
        let mandate = create_workflow_mandate(
            &fixture.state,
            WorkflowMandateAdmission {
                mandate_id: "mandate:portal-single".to_owned(),
                conversation_id: "conversation:goal-run".to_owned(),
                operator_message_id: operator_message_id("turn:goal-run:1"),
                operator_message_excerpt: "Execute".to_owned(),
                project_id: "project:nucleus-local".to_owned(),
                scope: WorkflowMandateScope::Task {
                    task_id: task.task_id,
                    task_revision: task.revision_id,
                },
                idempotency_key: "portal-single".to_owned(),
                expires_at_epoch_seconds: u64::MAX,
            },
        )
        .expect("task mandate");
        let outcome = admit_goal_run(
            &fixture.state,
            GoalRunAdmissionRequest {
                mandate_id: mandate.mandate_id,
                expected_mandate_revision: mandate.revision_id,
                idempotency_key: "portal-single".to_owned(),
                now_epoch_seconds: mandate.created_at_epoch_seconds,
                rework_decision_ref: None,
                rework_reason: None,
                reviewed_work_item_refs: Vec::new(),
                reviewed_evidence_refs: Vec::new(),
            },
        )
        .expect("task admission");
        let GoalRunOutcome::Admitted { plan } = outcome else {
            panic!("expected admitted single-task plan");
        };
        assert_eq!(plan.scope_kind, "task");
        assert_eq!(plan.ordered_tasks.len(), 1);
        assert!(plan.goal_id.is_none());
    }
}
