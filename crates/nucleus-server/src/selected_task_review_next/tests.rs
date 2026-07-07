use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::{
    selected_task_review_next, task_workflow_drilldown, SelectedTaskReviewNextCategory,
    SelectedTaskReviewNextGapArea, SelectedTaskReviewState, TaskWorkflowDrilldown,
    TaskWorkflowDrilldownInput, TaskWorkflowNextStepInput, TaskWorkflowNextStepSource,
    TaskWorkflowReadinessInput, TaskWorkflowTaskInput, TaskWorkflowWorkProgressInput,
};

#[test]
fn review_next_surfaces_awaiting_review_without_effects() {
    let review_next = selected_task_review_next(&base_drilldown(vec![completed_item(
        "work:1",
        "awaiting_review",
    )]));

    assert_eq!(
        review_next.review.state,
        SelectedTaskReviewState::AwaitingReview
    );
    assert_eq!(
        review_next.next.category,
        SelectedTaskReviewNextCategory::ReviewEvidence
    );
    assert_eq!(review_next.next.next_ref.as_deref(), Some("work:1"));
    assert_eq!(review_next.source_counts.reviewable_work_items, 1);
    assert_eq!(
        review_next.evidence.checkpoint_refs,
        vec!["checkpoint:work:1"]
    );
    assert!(!review_next.no_effects.task_mutation_performed);
    assert!(!review_next.no_effects.provider_execution_performed);
    assert!(!review_next.no_effects.scm_or_forge_mutation_performed);
    assert!(!review_next.no_effects.accepted_memory_apply_performed);
    assert!(!review_next.no_effects.planning_apply_performed);
    assert!(!review_next.no_effects.ui_effect_performed);
}

#[test]
fn review_next_routes_needs_changes_to_rework() {
    let review_next = selected_task_review_next(&base_drilldown(vec![completed_item(
        "work:1",
        "needs_changes",
    )]));

    assert_eq!(
        review_next.review.state,
        SelectedTaskReviewState::NeedsChanges
    );
    assert_eq!(
        review_next.next.category,
        SelectedTaskReviewNextCategory::Rework
    );
    assert_eq!(review_next.review.work_item_refs, vec!["work:1"]);
}

#[test]
fn review_next_keeps_accepted_review_separate_from_task_completion() {
    let mut drilldown = base_drilldown(vec![completed_item("work:1", "accepted")]);
    drilldown.scm_handoff.handoff_refs = vec!["scm:handoff:1".to_owned()];

    let review_next = selected_task_review_next(&drilldown);

    assert_eq!(review_next.review.state, SelectedTaskReviewState::Accepted);
    assert_eq!(
        review_next.next.category,
        SelectedTaskReviewNextCategory::ScmHandoff
    );
    assert!(!review_next.no_effects.task_mutation_performed);
}

#[test]
fn review_next_reports_missing_sources_as_gaps() {
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

    let review_next = selected_task_review_next(&drilldown);

    assert_eq!(review_next.review.state, SelectedTaskReviewState::NotReady);
    assert_eq!(
        review_next.next.category,
        SelectedTaskReviewNextCategory::PlanningAmbiguity
    );
    assert!(review_next
        .gaps
        .iter()
        .any(|gap| gap.area == SelectedTaskReviewNextGapArea::Task));
    assert!(review_next
        .gaps
        .iter()
        .any(|gap| gap.area == SelectedTaskReviewNextGapArea::NextPathway));
}

fn base_drilldown(work_progress: Vec<TaskWorkflowWorkProgressInput>) -> TaskWorkflowDrilldown {
    task_workflow_drilldown(TaskWorkflowDrilldownInput {
        project_id: ProjectId("project:1".to_owned()),
        task_id: TaskId("task:1".to_owned()),
        task: Some(TaskWorkflowTaskInput {
            title: "Selected task".to_owned(),
            activity: "active".to_owned(),
            assignment: "agent".to_owned(),
            action_type: "execute".to_owned(),
        }),
        readiness: Some(TaskWorkflowReadinessInput {
            lane: "agent_delegation_ready".to_owned(),
            rationale_refs: vec!["readiness:1".to_owned()],
        }),
        timeline_entry_refs: vec!["timeline:task:1".to_owned()],
        work_progress,
        runtime_receipt_refs: vec!["receipt:task:1".to_owned()],
        command_evidence_refs: Vec::new(),
        task_completion_refs: vec!["completion:task:1".to_owned()],
        review_refs: Vec::new(),
        scm_handoff_refs: Vec::new(),
        next_step: Some(TaskWorkflowNextStepInput {
            source: TaskWorkflowNextStepSource::Review,
            next_ref: Some("review:task:1".to_owned()),
            summary: "Review selected task evidence".to_owned(),
            rationale_refs: vec!["completion:task:1".to_owned()],
        }),
    })
}

fn completed_item(work_item_ref: &str, review_status: &str) -> TaskWorkflowWorkProgressInput {
    TaskWorkflowWorkProgressInput {
        work_item_ref: work_item_ref.to_owned(),
        runtime_status: "completed".to_owned(),
        review_status: review_status.to_owned(),
        source_ref: format!("source:{work_item_ref}"),
        source_count: 1,
        session_ref: Some(format!("session:{work_item_ref}")),
        turn_refs: vec![format!("turn:{work_item_ref}")],
        receipt_refs: vec![format!("receipt:{work_item_ref}")],
        checkpoint_refs: vec![format!("checkpoint:{work_item_ref}")],
        diff_summary_refs: vec![format!("diff:{work_item_ref}")],
        timeline_entry_refs: vec![format!("timeline:{work_item_ref}")],
        validation_refs: vec![format!("validation:{work_item_ref}")],
        artifact_refs: Vec::new(),
        issue_refs: Vec::new(),
    }
}
