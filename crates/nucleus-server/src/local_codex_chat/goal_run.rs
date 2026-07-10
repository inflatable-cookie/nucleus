use std::collections::HashMap;

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_engine::{
    admit_task_agent_work_unit, project_task_agent_work_units,
    EngineTaskAgentWorkUnitRuntimeStatus, EngineTaskWorkItemAssignment, EngineTaskWorkItemId,
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
use super::mandates::{
    read_workflow_mandate, WorkflowMandate, WorkflowMandateScope, WorkflowMandateStatus,
};
use super::persistence::{read_session, StoredChatSession};
use super::task_inspection::active_task;
use crate::task_agent_work_unit_state::{
    read_task_agent_work_unit_source_records, write_task_agent_work_unit_source_record,
};
use crate::{ControlTaskRecordDto, ServerStateService};

const PLAN_PREFIX: &str = "goal-run-plan:";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GoalRunAdmissionRequest {
    pub mandate_id: String,
    pub expected_mandate_revision: String,
    pub idempotency_key: String,
    pub now_epoch_seconds: u64,
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
        refs: EngineTaskWorkItemRefs::default(),
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

fn validate_goal_run_authority<B>(
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

pub fn read_goal_run_plan<B>(
    state: &ServerStateService<B>,
    plan_id: &str,
) -> Result<Option<GoalRunPlan>, String>
where
    B: LocalStoreBackend,
{
    state
        .agent_sessions()
        .get(&PersistenceRecordId(format!("{PLAN_PREFIX}{plan_id}")))
        .map_err(storage_error)?
        .map(|record| {
            serde_json::from_slice(&record.payload.bytes).map_err(|error| error.to_string())
        })
        .transpose()
}

fn persist_plan<B>(state: &ServerStateService<B>, plan: &GoalRunPlan) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let bytes = serde_json::to_vec(plan).map_err(|error| error.to_string())?;
    state
        .agent_sessions()
        .put(
            LocalStoreRecord {
                id: PersistenceRecordId(format!("{PLAN_PREFIX}{}", plan.plan_id)),
                revision_id: RevisionId(plan.revision_id.clone()),
                domain: PersistenceDomain::AgentSessions,
                kind: PersistenceRecordKind::AgentSession,
                payload: LocalStoreRecordPayload {
                    media_type: Some("application/json".to_owned()),
                    bytes,
                },
            },
            RevisionExpectation::MustNotExist,
        )
        .map(|_| ())
        .map_err(storage_error)
}

fn storage_error(error: impl std::fmt::Debug) -> String {
    format!("goal run persistence failed: {error:?}")
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::commands::{GoalCommand, GoalCreateCommand, ServerCommand, ServerCommandKind};
    use crate::control_api::{
        ServerControlRequest, ServerControlRequestKind, ServerControlResponseStatus,
    };
    use crate::local_codex_chat::mandates::{
        create_workflow_mandate, WorkflowMandate, WorkflowMandateAdmission, WorkflowMandateScope,
    };
    use crate::local_codex_chat::persistence::{
        operator_message_id, persist_turn_start, StoredChatSession,
    };
    use crate::local_codex_chat::task_authoring::execute_task_batch;
    use crate::{
        seed_local_project, ClientId, LocalControlRequestHandler, LocalProjectSeed,
        ServerCommandId, ServerControlRequestId,
    };
    use nucleus_local_store::SqliteBackend;
    use nucleus_planning::GoalStatus;

    #[test]
    fn goal_run_admits_one_scheduled_work_item_and_repeats_idempotently() {
        let fixture = fixture(true);
        let request = run_request(&fixture.mandate, "goal-run:idem:1");

        let first = admit_goal_run(&fixture.state, request.clone()).expect("first admission");
        let first_plan = match first {
            GoalRunOutcome::Admitted { plan } => plan,
            other => panic!("expected admission, got {other:?}"),
        };
        assert_eq!(first_plan.ordered_tasks.len(), 2);
        assert_eq!(first_plan.current_task_index, 0);
        assert_eq!(first_plan.ordered_tasks[0].disposition, "scheduled");
        assert!(first_plan.provider_execution_deferred);
        assert_eq!(first_plan.route.provider_instance_id, "codex:local-default");
        assert_eq!(
            read_task_agent_work_unit_source_records(&fixture.state)
                .expect("work sources")
                .len(),
            1
        );
        let conflicting = inspect_goal_run(
            &fixture.state,
            &run_request(&fixture.mandate, "goal-run:conflict"),
        )
        .expect("conflict inspection");
        assert!(conflicting
            .blockers
            .iter()
            .any(|blocker| blocker.reason.contains("already has active work")));

        let repeated = admit_goal_run(&fixture.state, request).expect("repeat admission");
        assert_eq!(
            repeated,
            GoalRunOutcome::Admitted {
                plan: first_plan.clone()
            }
        );
        assert_eq!(
            read_task_agent_work_unit_source_records(&fixture.state)
                .expect("work sources")
                .len(),
            1
        );
        assert!(fixture
            .state
            .runtime_effects()
            .list()
            .expect("effects")
            .is_empty());
    }

    #[test]
    fn goal_run_reports_task_readiness_blockers_without_admission() {
        let fixture = fixture(false);
        let outcome = admit_goal_run(
            &fixture.state,
            run_request(&fixture.mandate, "goal-run:blocked"),
        )
        .expect("blocked outcome");
        let inspection = match outcome {
            GoalRunOutcome::Blocked { inspection } => inspection,
            other => panic!("expected blocker, got {other:?}"),
        };

        assert!(inspection
            .blockers
            .iter()
            .any(|blocker| blocker.scope == "task" && blocker.reason.contains("not agent-ready")));
        assert!(inspection
            .blockers
            .iter()
            .any(|blocker| blocker.reason.contains("activity is proposed")));
        assert!(read_task_agent_work_unit_source_records(&fixture.state)
            .expect("work sources")
            .is_empty());
    }

    #[test]
    fn goal_run_rejects_stale_or_expired_mandate_authority() {
        let fixture = fixture(true);
        let mut stale = run_request(&fixture.mandate, "goal-run:stale");
        stale.expected_mandate_revision = "rev:stale".to_owned();
        assert!(inspect_goal_run(&fixture.state, &stale)
            .expect_err("stale mandate")
            .contains("revision conflict"));

        let mut expired = run_request(&fixture.mandate, "goal-run:expired");
        expired.now_epoch_seconds = fixture.mandate.expires_at_epoch_seconds;
        assert!(inspect_goal_run(&fixture.state, &expired)
            .expect_err("expired mandate")
            .contains("expired"));
    }

    #[test]
    fn goal_run_request_rejects_arbitrary_task_sets() {
        let error = serde_json::from_value::<GoalRunAdmissionRequest>(serde_json::json!({
            "mandate_id": "mandate:1",
            "expected_mandate_revision": "rev:1",
            "idempotency_key": "run:1",
            "now_epoch_seconds": 1,
            "task_ids": ["task:outside-mandate"]
        }))
        .expect_err("arbitrary task set");
        assert!(error.to_string().contains("unknown field"));
        let error = serde_json::from_value::<GoalRunAdmissionRequest>(serde_json::json!({
            "mandate_id": "mandate:1",
            "expected_mandate_revision": "rev:1",
            "idempotency_key": "run:1",
            "now_epoch_seconds": 1,
            "project_id": "project:sweep"
        }))
        .expect_err("project sweep");
        assert!(error.to_string().contains("unknown field"));
    }

    pub(crate) struct Fixture {
        _temp_dir: tempfile::TempDir,
        pub(crate) state: ServerStateService<SqliteBackend>,
        pub(crate) mandate: WorkflowMandate,
    }

    pub(crate) fn fixture(tasks_ready: bool) -> Fixture {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        let state = ServerStateService::new(backend.clone());
        seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("project");
        let mut handler = LocalControlRequestHandler::new(backend, None);
        let first_id = "task:command:agent-chat:goal-run-tasks:1";
        let second_id = "task:command:agent-chat:goal-run-tasks:2";
        execute_task_batch(
            "project:nucleus-local",
            "conversation:goal-run",
            "provider-turn:goal-run",
            "goal-run-tasks",
            serde_json::json!({
                "tasks": [
                    {
                        "title": "First Goal task",
                        "description": "First serial unit.",
                        "acceptance_criteria": ["First task produces evidence."],
                        "action_type": "execute",
                        "ready_for_agent": tasks_ready,
                        "stop_conditions": ["Stop on failure."]
                    },
                    {
                        "title": "Second Goal task",
                        "description": "Second serial unit.",
                        "acceptance_criteria": ["Second task produces evidence."],
                        "action_type": "test",
                        "ready_for_agent": tasks_ready,
                        "dependency_task_refs": [first_id],
                        "stop_conditions": ["Stop on failed validation."]
                    }
                ]
            }),
            &mut |request| accept(&mut handler, request),
        )
        .expect("tasks");
        let goal_command_id = "command:goal-run-goal";
        accept(
            &mut handler,
            ServerControlRequest {
                id: ServerControlRequestId(format!("request:{goal_command_id}")),
                client_id: ClientId("client:test".to_owned()),
                kind: ServerControlRequestKind::Command(ServerCommand {
                    id: ServerCommandId(goal_command_id.to_owned()),
                    client_id: ClientId("client:test".to_owned()),
                    kind: ServerCommandKind::Goal(GoalCommand::Create(GoalCreateCommand {
                        project_id: ProjectId("project:nucleus-local".to_owned()),
                        title: "Serial Goal".to_owned(),
                        desired_outcome: "Both tasks produce reviewable evidence.".to_owned(),
                        scope: "Two ordered tasks.".to_owned(),
                        status: GoalStatus::Ready,
                        owner_refs: vec!["operator:test".to_owned()],
                        ordered_task_refs: vec![
                            TaskId(first_id.to_owned()),
                            TaskId(second_id.to_owned()),
                        ],
                        planning_artifact_refs: Vec::new(),
                        provenance_refs: vec!["conversation:goal-run".to_owned()],
                        stop_conditions: vec!["Stop on the first blocker.".to_owned()],
                        evidence_refs: Vec::new(),
                        current_next_task_ref: Some(TaskId(first_id.to_owned())),
                        next_action: Some("Run the first task.".to_owned()),
                    })),
                }),
            },
        )
        .expect("goal");
        let goal_id = format!("goal:{goal_command_id}");
        let goal = goal_record(&state, "project:nucleus-local", &goal_id).expect("goal record");
        let conversation_id = "conversation:goal-run";
        let turn_id = "turn:goal-run:1";
        persist_turn_start(
            &state,
            StoredChatSession {
                conversation_id: conversation_id.to_owned(),
                project_id: "project:nucleus-local".to_owned(),
                session_id: "session:goal-run".to_owned(),
                provider_thread_id: "thread:goal-run".to_owned(),
                model: "gpt-5.4-mini".to_owned(),
                reasoning_effort: Some("low".to_owned()),
                adapter_id: "codex-app-server".to_owned(),
                provider_instance_id: "codex:local-default".to_owned(),
                turn_count: 1,
                task_toolset_version: 4,
            },
            turn_id,
            "Execute this Goal now.",
            Some(goal_id.clone()),
        )
        .expect("turn start");
        let mandate = create_workflow_mandate(
            &state,
            WorkflowMandateAdmission {
                mandate_id: "mandate:goal-run".to_owned(),
                conversation_id: conversation_id.to_owned(),
                operator_message_id: operator_message_id(turn_id),
                operator_message_excerpt: "Execute this Goal".to_owned(),
                project_id: "project:nucleus-local".to_owned(),
                scope: WorkflowMandateScope::Goal {
                    goal_id,
                    goal_revision: goal.revision_id,
                },
                idempotency_key: "mandate:idem".to_owned(),
                expires_at_epoch_seconds: u64::MAX,
            },
        )
        .expect("mandate");
        Fixture {
            _temp_dir: temp_dir,
            state,
            mandate,
        }
    }

    pub(crate) fn run_request(mandate: &WorkflowMandate, key: &str) -> GoalRunAdmissionRequest {
        GoalRunAdmissionRequest {
            mandate_id: mandate.mandate_id.clone(),
            expected_mandate_revision: mandate.revision_id.clone(),
            idempotency_key: key.to_owned(),
            now_epoch_seconds: mandate.created_at_epoch_seconds,
        }
    }

    fn accept(
        handler: &mut LocalControlRequestHandler<SqliteBackend>,
        request: ServerControlRequest,
    ) -> Result<(), String> {
        let response = handler.handle(request);
        if response.status == ServerControlResponseStatus::Accepted {
            Ok(())
        } else {
            Err(format!("command rejected: {:?}", response.body))
        }
    }
}
