use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use super::{
    task_workflow_drilldown, TaskWorkflowDrilldownInput, TaskWorkflowGapArea,
    TaskWorkflowNextStepInput, TaskWorkflowNextStepSource, TaskWorkflowReadinessInput,
    TaskWorkflowTaskInput, TaskWorkflowWorkProgressInput,
};

#[test]
fn task_workflow_drilldown_sanitizes_refs_and_reports_no_effects() {
    let drilldown = task_workflow_drilldown(TaskWorkflowDrilldownInput {
        project_id: ProjectId("project:1".to_owned()),
        task_id: TaskId("task:1".to_owned()),
        task: Some(TaskWorkflowTaskInput {
            title: "  Title  ".to_owned(),
            activity: "ready".to_owned(),
            assignment: "unassigned".to_owned(),
            action_type: "execute".to_owned(),
        }),
        readiness: Some(TaskWorkflowReadinessInput {
            lane: "ready".to_owned(),
            rationale_refs: vec!["ref:b".to_owned(), "ref:a".to_owned(), "ref:a".to_owned()],
        }),
        timeline_entry_refs: vec!["timeline:2".to_owned(), "timeline:1".to_owned()],
        work_progress: vec![TaskWorkflowWorkProgressInput {
            work_item_ref: "work:1".to_owned(),
            runtime_status: "running".to_owned(),
            review_status: "not_ready".to_owned(),
            source_ref: "source:2".to_owned(),
            source_count: 2,
            session_ref: Some("session:1".to_owned()),
            turn_refs: vec!["turn:1".to_owned()],
            receipt_refs: vec!["receipt:1".to_owned()],
            checkpoint_refs: vec!["checkpoint:1".to_owned()],
            diff_summary_refs: vec!["diff:1".to_owned()],
            timeline_entry_refs: vec!["timeline:1".to_owned()],
            validation_refs: vec!["validation:1".to_owned()],
            artifact_refs: vec!["artifact:1".to_owned()],
            issue_refs: vec!["issue:1".to_owned()],
        }],
        runtime_receipt_refs: vec!["receipt:1".to_owned()],
        command_evidence_refs: vec!["command:evidence:1".to_owned()],
        task_completion_refs: vec!["completion:1".to_owned()],
        review_refs: vec!["review:1".to_owned()],
        scm_handoff_refs: vec!["scm:1".to_owned()],
        next_step: Some(TaskWorkflowNextStepInput {
            source: TaskWorkflowNextStepSource::Task,
            next_ref: Some("task:1".to_owned()),
            summary: "Continue selected task".to_owned(),
            rationale_refs: vec!["ref:a".to_owned()],
        }),
    });

    assert_eq!(drilldown.task.expect("task").title, "Title");
    assert_eq!(
        drilldown.readiness.expect("readiness").rationale_refs,
        vec!["ref:a", "ref:b"]
    );
    assert_eq!(drilldown.source_counts.work_items, 1);
    assert!(drilldown.gaps.is_empty());
    assert!(!drilldown.no_effects.task_mutation_performed);
    assert!(!drilldown.no_effects.provider_execution_performed);
    assert!(!drilldown.no_effects.scm_or_forge_mutation_performed);
}

#[test]
fn task_workflow_drilldown_reports_missing_sources_as_gaps() {
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

    assert_eq!(drilldown.source_counts.task_records, 0);
    assert!(drilldown
        .gaps
        .iter()
        .any(|gap| gap.area == TaskWorkflowGapArea::Task));
    assert!(drilldown
        .gaps
        .iter()
        .any(|gap| gap.area == TaskWorkflowGapArea::Next));
    assert_eq!(
        drilldown.next.source,
        TaskWorkflowNextStepSource::BlockedByMissingPathway
    );
}
