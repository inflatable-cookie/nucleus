//! Goal execution source-window tests, split from the execution_tests god
//! file; behavior unchanged.

use super::*;

use crate::local_codex_chat::goal_run::tests::fixture;
use crate::local_codex_chat::task_execution::TaskExecutionOutcome;
use crate::read_diff_summary_records;
use nucleus_engine::{
    EngineDiffPathChangeKind, EngineTaskAgentWorkUnitReviewStatus,
    EngineTaskAgentWorkUnitRuntimeStatus,
};

#[test]
fn serial_tasks_receive_non_overlapping_source_windows() {
    let fixture = fixture(true);
    let snapshots = snapshot_runtime(&fixture.state);
    std::fs::write(
        snapshots.workspace.path().join("preexisting.txt"),
        "stable\n",
    )
    .expect("preexisting");
    std::fs::write(snapshots.workspace.path().join("modified.txt"), "before\n")
        .expect("modified fixture");
    std::fs::write(snapshots.workspace.path().join("deleted.txt"), "delete\n")
        .expect("deleted fixture");
    let plan = admitted_plan(&fixture.state, &fixture.mandate, "execute:windows");
    let mut calls = 0;
    let execution = execute_goal_run_with(
        &fixture.state,
        Some(&snapshots.store),
        GoalRunExecutionRequest {
            plan_id: plan.plan_id,
            expected_plan_revision: plan.revision_id,
        },
        &mut |_, on_started| {
            calls += 1;
            let linkage = linkage(calls);
            on_started(&linkage)?;
            std::fs::write(
                snapshots.workspace.path().join(format!("task-{calls}.txt")),
                format!("task {calls}\n"),
            )
            .map_err(|error| error.to_string())?;
            if calls == 1 {
                std::fs::write(snapshots.workspace.path().join("modified.txt"), "after\n")
                    .map_err(|error| error.to_string())?;
                std::fs::remove_file(snapshots.workspace.path().join("deleted.txt"))
                    .map_err(|error| error.to_string())?;
                std::fs::write(snapshots.workspace.path().join("binary.bin"), b"a\0b")
                    .map_err(|error| error.to_string())?;
            }
            Ok(TaskExecutionOutcome::Completed(linkage))
        },
    )
    .expect("serial windows");

    assert_eq!(execution.status, GoalRunExecutionStatus::Completed);
    let mut diffs = read_diff_summary_records(&fixture.state).expect("diffs");
    diffs.sort_by(|left, right| left.diff_id.0.cmp(&right.diff_id.0));
    assert_eq!(diffs.len(), 2);
    assert_eq!(
        diffs[0].changed_paths,
        vec!["binary.bin", "deleted.txt", "modified.txt", "task-1.txt"]
    );
    assert_eq!(diffs[1].changed_paths, vec!["task-2.txt"]);
    assert_eq!(diffs[0].counts.added, 1);
    assert_eq!(diffs[0].counts.modified, 1);
    assert_eq!(diffs[0].counts.deleted, 1);
    assert_eq!(diffs[0].counts.metadata_only, 1);
    assert!(diffs[0]
        .path_changes
        .iter()
        .any(|change| change.kind == EngineDiffPathChangeKind::MetadataOnly));
    assert_eq!(diffs[1].counts.added, 1);
    assert_eq!(
        diffs[1].path_changes[0].kind,
        EngineDiffPathChangeKind::Added
    );
    assert!(diffs.iter().all(|diff| !diff
        .changed_paths
        .iter()
        .any(|path| path == "preexisting.txt")));
}

#[test]
fn target_capture_failure_never_becomes_review_ready() {
    let fixture = fixture(true);
    let snapshots = snapshot_runtime(&fixture.state);
    let plan = admitted_plan(&fixture.state, &fixture.mandate, "execute:target-failure");
    let execution = execute_goal_run_with(
        &fixture.state,
        Some(&snapshots.store),
        GoalRunExecutionRequest {
            plan_id: plan.plan_id,
            expected_plan_revision: plan.revision_id,
        },
        &mut |_, on_started| {
            let linkage = linkage(1);
            on_started(&linkage)?;
            for index in 0..=crate::project_file_policy::MAX_ADMITTED_PROJECT_FILES {
                std::fs::write(
                    snapshots.workspace.path().join(format!("{index:04}.txt")),
                    "",
                )
                .map_err(|error| error.to_string())?;
            }
            Ok(TaskExecutionOutcome::Completed(linkage))
        },
    )
    .expect("target recovery");

    assert_eq!(execution.status, GoalRunExecutionStatus::RecoveryRequired);
    assert_eq!(execution.task_executions[0].status, "recovery_required");
    assert!(execution.task_executions[0].target_checkpoint_id.is_none());
    assert!(execution.task_executions[0].diff_summary_id.is_none());
    assert!(read_diff_summary_records(&fixture.state)
        .expect("diffs")
        .is_empty());
    let latest = latest_source(&fixture.state, &execution.task_executions[0].work_item_id)
        .expect("latest source")
        .expect("source");
    assert!(matches!(
        latest.runtime,
        EngineTaskAgentWorkUnitRuntimeStatus::RecoveryRequired(_)
    ));
    assert_eq!(latest.review, EngineTaskAgentWorkUnitReviewStatus::NotReady);
}
