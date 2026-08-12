//! Task workflow tests, split from the task_workflow god file; behavior
//! unchanged.

use super::types::{TaskWorkflowInput, TaskWorkflowReceiptStatus};
use super::{dynamic_tool_spec, execute};
use crate::local_codex_chat::goal_run::tests::fixture;
use crate::local_codex_chat::mandates::{
    create_workflow_mandate, WorkflowMandateAdmission, WorkflowMandateScope,
};
use crate::local_codex_chat::persistence::operator_message_id;
use crate::local_codex_chat::task_inspection::active_task;
use crate::local_codex_chat::goal_run::{admit_goal_run, GoalRunAdmissionRequest, GoalRunOutcome};
use serde_json::json;

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
