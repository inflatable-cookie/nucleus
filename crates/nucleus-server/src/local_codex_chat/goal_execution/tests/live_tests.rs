//! Authenticated live goal-execution smokes, split from the tests_split god
//! file; behavior unchanged.

use super::*;

use crate::local_codex_chat::goal_run::tests::fixture;
use crate::local_codex_chat::goal_run::GoalRunRoute;
use crate::local_codex_chat::task_execution::{
    run_task, TaskExecutionOutcome, TaskExecutionRequest,
};

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
                session_id: "session:task:authenticated-single",
                project_root: &root,
                route: &route,
                prompt: "Create a UTF-8 file named nucleus-single-task-smoke.txt containing exactly the text nucleus task smoke ok followed by a newline. Do nothing else.",
                idioms_enabled: true,
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
    let snapshot_backend = tempfile::tempdir().expect("snapshot backend");
    let snapshot_store =
        TaskReviewSnapshotStore::new(snapshot_backend.path()).expect("snapshot store");
    redirect_project_root(&fixture.state, workspace.path());
    let plan = admitted_plan(&fixture.state, &fixture.mandate, "execute:live-two");
    let execution = execute_goal_run(
        &fixture.state,
        Some(&snapshot_store),
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
