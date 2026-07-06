use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use super::{selected_task_action_readiness, SelectedTaskActionFamily, SelectedTaskActionStatus};
use crate::{
    task_workflow_drilldown, TaskWorkflowDrilldown, TaskWorkflowDrilldownInput,
    TaskWorkflowNextStepInput, TaskWorkflowNextStepSource, TaskWorkflowReadinessInput,
    TaskWorkflowTaskInput, TaskWorkflowWorkProgressInput,
};

#[test]
fn readiness_allows_start_and_delegation_for_delegation_ready_task() {
    let drilldown = base_drilldown(
        "ready",
        Some("agent_delegation_ready"),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    );

    let readiness = selected_task_action_readiness(&drilldown);

    assert_action(
        &readiness,
        SelectedTaskActionFamily::StartSelectedTask,
        SelectedTaskActionStatus::Allowed,
    );
    assert_action(
        &readiness,
        SelectedTaskActionFamily::PrepareDelegation,
        SelectedTaskActionStatus::Allowed,
    );
    assert_action(
        &readiness,
        SelectedTaskActionFamily::InspectRuntimeEvidence,
        SelectedTaskActionStatus::NotApplicable,
    );
    assert!(!readiness.no_effects.task_mutation_performed);
    assert!(!readiness.no_effects.provider_execution_performed);
    assert!(!readiness.no_effects.scm_or_forge_mutation_performed);
}

#[test]
fn readiness_routes_active_work_to_runtime_inspection() {
    let drilldown = base_drilldown(
        "active",
        Some("agent_delegation_ready"),
        vec![TaskWorkflowWorkProgressInput {
            work_item_ref: "work:1".to_owned(),
            runtime_status: "running".to_owned(),
            review_status: "not_ready".to_owned(),
            source_ref: "source:1".to_owned(),
            source_count: 1,
            session_ref: Some("session:1".to_owned()),
            turn_refs: vec!["turn:1".to_owned()],
            receipt_refs: vec!["receipt:1".to_owned()],
            checkpoint_refs: Vec::new(),
            diff_summary_refs: Vec::new(),
            timeline_entry_refs: vec!["timeline:1".to_owned()],
            validation_refs: Vec::new(),
            artifact_refs: Vec::new(),
            issue_refs: Vec::new(),
        }],
        Vec::new(),
        Vec::new(),
    );

    let readiness = selected_task_action_readiness(&drilldown);

    assert_action(
        &readiness,
        SelectedTaskActionFamily::InspectRuntimeEvidence,
        SelectedTaskActionStatus::Allowed,
    );
    assert_action(
        &readiness,
        SelectedTaskActionFamily::StartSelectedTask,
        SelectedTaskActionStatus::DifferentLane,
    );
    assert_eq!(readiness.source_counts.active_work_items, 1);
}

#[test]
fn readiness_allows_review_and_handoff_after_completion_evidence() {
    let drilldown = base_drilldown(
        "ready",
        Some("ready"),
        Vec::new(),
        vec!["completion:1".to_owned()],
        vec!["review:1".to_owned()],
    );

    let readiness = selected_task_action_readiness(&drilldown);

    assert_action(
        &readiness,
        SelectedTaskActionFamily::CompleteSelectedTask,
        SelectedTaskActionStatus::Allowed,
    );
    assert_action(
        &readiness,
        SelectedTaskActionFamily::ReviewWorkEvidence,
        SelectedTaskActionStatus::Allowed,
    );
    assert_action(
        &readiness,
        SelectedTaskActionFamily::PrepareScmHandoff,
        SelectedTaskActionStatus::Allowed,
    );
    assert_eq!(readiness.source_counts.completion_refs, 1);
    assert_eq!(readiness.source_counts.review_refs, 1);
}

#[test]
fn readiness_blocks_missing_task_without_mutation() {
    let drilldown = task_workflow_drilldown(TaskWorkflowDrilldownInput {
        project_id: ProjectId("project:1".to_owned()),
        task_id: TaskId("task:missing".to_owned()),
        task: None,
        readiness: None,
        timeline_entry_refs: Vec::new(),
        work_progress: Vec::new(),
        runtime_receipt_refs: Vec::new(),
        command_evidence_refs: Vec::new(),
        task_completion_refs: Vec::new(),
        review_refs: Vec::new(),
        scm_handoff_refs: Vec::new(),
        next_step: None,
    });

    let readiness = selected_task_action_readiness(&drilldown);

    assert_eq!(readiness.source_counts.task_records, 0);
    assert_eq!(readiness.blockers.len(), 9);
    assert!(readiness
        .actions
        .iter()
        .all(|action| action.status == SelectedTaskActionStatus::Blocked));
    assert!(!readiness.no_effects.agent_scheduling_performed);
}

fn base_drilldown(
    activity: &str,
    readiness_lane: Option<&str>,
    work_progress: Vec<TaskWorkflowWorkProgressInput>,
    completion_refs: Vec<String>,
    review_refs: Vec<String>,
) -> TaskWorkflowDrilldown {
    task_workflow_drilldown(TaskWorkflowDrilldownInput {
        project_id: ProjectId("project:1".to_owned()),
        task_id: TaskId("task:1".to_owned()),
        task: Some(TaskWorkflowTaskInput {
            title: "Selected task".to_owned(),
            activity: activity.to_owned(),
            assignment: "unassigned".to_owned(),
            action_type: "execute".to_owned(),
        }),
        readiness: readiness_lane.map(|lane| TaskWorkflowReadinessInput {
            lane: lane.to_owned(),
            rationale_refs: vec!["readiness:1".to_owned()],
        }),
        timeline_entry_refs: vec!["timeline:1".to_owned()],
        work_progress,
        runtime_receipt_refs: Vec::new(),
        command_evidence_refs: Vec::new(),
        task_completion_refs: completion_refs,
        review_refs,
        scm_handoff_refs: Vec::new(),
        next_step: Some(TaskWorkflowNextStepInput {
            source: TaskWorkflowNextStepSource::Task,
            next_ref: Some("task:1".to_owned()),
            summary: "Continue selected task".to_owned(),
            rationale_refs: vec!["readiness:1".to_owned()],
        }),
    })
}

fn assert_action(
    readiness: &super::SelectedTaskActionReadiness,
    family: SelectedTaskActionFamily,
    status: SelectedTaskActionStatus,
) {
    let action = readiness
        .actions
        .iter()
        .find(|action| action.family == family)
        .expect("action");
    assert_eq!(action.status, status, "{family:?}");
}
