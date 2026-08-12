//! Goal run admission tests, split from the goal_run god file; behavior
//! unchanged.

use super::*;

use crate::commands::{GoalCommand, GoalCreateCommand, ServerCommand, ServerCommandKind};
use crate::control_api::{
    ServerControlRequest, ServerControlRequestKind, ServerControlResponseStatus,
};
use crate::local_codex_chat::goal_inspection::goal_record;
use crate::local_codex_chat::mandates::{
    create_workflow_mandate, WorkflowMandate, WorkflowMandateAdmission, WorkflowMandateScope,
};
use crate::local_codex_chat::persistence::{
    operator_message_id, persist_turn_start, StoredChatSession,
};
use crate::local_codex_chat::task_authoring::execute_task_batch;
use crate::task_agent_work_unit_state::read_task_agent_work_unit_source_records;
use crate::{
    seed_local_project, ClientId, LocalControlRequestHandler, LocalProjectSeed,
    ServerCommandId, ServerControlRequestId, ServerStateService,
};
use nucleus_local_store::SqliteBackend;
use nucleus_planning::GoalStatus;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

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
            resource_id: None,
            session_id: "session:goal-run".to_owned(),
            provider_thread_id: "thread:goal-run".to_owned(),
            model: "gpt-5.4-mini".to_owned(),
            reasoning_effort: Some("low".to_owned()),
            harness_mode: crate::local_codex_chat::LocalCodexChatHarnessMode::Normal,
            adapter_id: "codex-app-server".to_owned(),
            provider_instance_id: "codex:local-default".to_owned(),
            provider_instance_revision: "1".to_owned(),
            protocol_facade_id: "codex-app-server-v2".to_owned(),
            provider_id: None,
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
        rework_decision_ref: None,
        rework_reason: None,
        reviewed_work_item_refs: Vec::new(),
        reviewed_evidence_refs: Vec::new(),
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
