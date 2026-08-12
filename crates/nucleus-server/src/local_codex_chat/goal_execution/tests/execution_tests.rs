//! Goal execution run-loop tests, split from the tests_split god file;
//! behavior unchanged.

use super::*;

use crate::local_codex_chat::goal_run::tests::fixture;
use crate::local_codex_chat::mandates::{read_workflow_mandate, WorkflowMandateStatus};
use crate::local_codex_chat::task_execution::TaskExecutionOutcome;
use crate::local_codex_chat::task_inspection::active_task;
use crate::runtime_receipt_state::read_runtime_receipts;
use crate::task_agent_work_unit_state::read_task_agent_work_unit_source_records;
use crate::{read_checkpoint_records, read_diff_summary_records};
use nucleus_engine::{
    EngineTaskAgentWorkUnitReviewStatus,
    EngineTaskAgentWorkUnitRuntimeStatus,
};

#[test]
fn rework_prompt_includes_durable_note_and_refs_without_patch_content() {
    let fixture = fixture(true);
    let mut plan = admitted_plan(&fixture.state, &fixture.mandate, "prompt:rework");
    let plan_task = &mut plan.ordered_tasks[0];
    plan_task.rework_decision_ref = Some("review:decision:1".to_owned());
    plan_task.rework_reason = Some("Keep the heading and fix the example.".to_owned());
    plan_task.reviewed_work_item_refs = vec!["work:previous".to_owned()];
    plan_task.reviewed_evidence_refs = vec!["diff:previous".to_owned()];
    let task =
        active_task(&fixture.state, &plan.project_id, &plan_task.task_id).expect("active task");

    let prompt = task_prompt(&plan, 0, &task);

    assert!(prompt.contains("Keep the heading and fix the example."));
    assert!(prompt.contains("review:decision:1"));
    assert!(prompt.contains("work:previous"));
    assert!(prompt.contains("diff:previous"));
    assert!(!prompt.contains("@@"));
}

#[test]
fn two_task_goal_executes_serially_and_stops_at_reviewable_results() {
    let fixture = fixture(true);
    let snapshots = snapshot_runtime(&fixture.state);
    let plan = admitted_plan(&fixture.state, &fixture.mandate, "execute:two");
    let mut calls = 0;
    let execution = execute_goal_run_with(
        &fixture.state,
        Some(&snapshots.store),
        GoalRunExecutionRequest {
            plan_id: plan.plan_id.clone(),
            expected_plan_revision: plan.revision_id.clone(),
        },
        &mut |_, on_started| {
            calls += 1;
            let persisted = read_execution(&fixture.state, &plan.plan_id)
                .expect("execution lookup")
                .expect("persisted execution");
            if calls == 1 {
                assert!(!persisted.provider_execution_started);
            }
            assert_eq!(persisted.task_executions.len(), calls);
            assert!(persisted.task_executions[calls - 1]
                .baseline_checkpoint_id
                .is_some());
            assert_eq!(
                read_checkpoint_records(&fixture.state)
                    .expect("baseline checkpoints")
                    .len(),
                calls * 2 - 1
            );
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
    assert!(execution.task_executions.iter().all(|task| {
        task.baseline_checkpoint_id.is_some()
            && task.target_checkpoint_id.is_some()
            && task.diff_summary_id.is_some()
    }));
    assert_eq!(
        read_checkpoint_records(&fixture.state)
            .expect("all checkpoints")
            .len(),
        4
    );
    assert_eq!(
        read_diff_summary_records(&fixture.state)
            .expect("all diffs")
            .len(),
        2
    );
    for task in &execution.task_executions {
        let latest = latest_source(&fixture.state, &task.work_item_id)
            .expect("latest source")
            .expect("work source");
        assert_eq!(latest.refs.checkpoint_ids.len(), 2);
        assert_eq!(latest.refs.diff_summary_ids.len(), 1);
        assert_eq!(
            latest.review,
            EngineTaskAgentWorkUnitReviewStatus::AwaitingReview
        );
    }
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
        8
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
    let snapshots = snapshot_runtime(&fixture.state);
    let plan = admitted_plan(&fixture.state, &fixture.mandate, "execute:failure");
    let mut calls = 0;
    let execution = execute_goal_run_with(
        &fixture.state,
        Some(&snapshots.store),
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
        4
    );
}

#[test]
fn interactive_wait_is_recorded_then_closed_as_recovery_required() {
    let fixture = fixture(true);
    let snapshots = snapshot_runtime(&fixture.state);
    let plan = admitted_plan(&fixture.state, &fixture.mandate, "execute:wait");
    let execution = execute_goal_run_with(
        &fixture.state,
        Some(&snapshots.store),
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
    let sources = read_task_agent_work_unit_source_records(&fixture.state).expect("work sources");
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
    let snapshots = snapshot_runtime(&fixture.state);
    let plan = admitted_plan(&fixture.state, &fixture.mandate, "execute:revoke");
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
    let snapshots = snapshot_runtime(&fixture.state);
    let plan = admitted_plan(&fixture.state, &fixture.mandate, "execute:idem");
    let request = GoalRunExecutionRequest {
        plan_id: plan.plan_id,
        expected_plan_revision: plan.revision_id,
    };
    let first = execute_goal_run_with(
        &fixture.state,
        Some(&snapshots.store),
        request.clone(),
        &mut |_, on_started| {
            let linkage = linkage(1);
            on_started(&linkage)?;
            Ok(TaskExecutionOutcome::Failed {
                linkage: Some(linkage),
                reason: "stop".to_owned(),
            })
        },
    )
    .expect("first execution");
    let mut replay_calls = 0;
    let repeated = execute_goal_run_with(
        &fixture.state,
        Some(&snapshots.store),
        request,
        &mut |_, _| {
            replay_calls += 1;
            Err("must not replay".to_owned())
        },
    )
    .expect("repeat execution");

    assert_eq!(replay_calls, 0);
    assert_eq!(repeated, first);
}

#[test]
fn missing_snapshot_backend_fails_before_provider_start() {
    let fixture = fixture(true);
    let workspace = tempfile::tempdir().expect("workspace");
    redirect_project_root(&fixture.state, workspace.path());
    let plan = admitted_plan(&fixture.state, &fixture.mandate, "execute:no-snapshots");
    let mut calls = 0;
    let execution = execute_goal_run_with(
        &fixture.state,
        None,
        GoalRunExecutionRequest {
            plan_id: plan.plan_id,
            expected_plan_revision: plan.revision_id,
        },
        &mut |_, _| {
            calls += 1;
            Err("provider must not start".to_owned())
        },
    )
    .expect("fail closed");

    assert_eq!(calls, 0);
    assert!(!execution.provider_execution_started);
    assert_eq!(execution.status, GoalRunExecutionStatus::RecoveryRequired);
    assert_eq!(execution.task_executions[0].status, "recovery_required");
    assert!(read_checkpoint_records(&fixture.state)
        .expect("checkpoints")
        .is_empty());
    let sources = read_task_agent_work_unit_source_records(&fixture.state).expect("work sources");
    assert!(sources.iter().any(|source| matches!(
        source.runtime,
        EngineTaskAgentWorkUnitRuntimeStatus::RecoveryRequired(_)
    )));
}
