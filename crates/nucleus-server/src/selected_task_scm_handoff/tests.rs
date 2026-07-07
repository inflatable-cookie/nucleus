use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::{
    selected_task_scm_handoff_readiness, task_workflow_drilldown,
    SelectedTaskScmHandoffNextCategory, SelectedTaskScmHandoffState,
    SelectedTaskScmHandoffTargetShape, TaskWorkflowDrilldown, TaskWorkflowDrilldownInput,
    TaskWorkflowNextStepInput, TaskWorkflowNextStepSource, TaskWorkflowReadinessInput,
    TaskWorkflowTaskInput, TaskWorkflowWorkProgressInput,
};

#[test]
fn handoff_readiness_reports_missing_handoff_refs() {
    let readiness = selected_task_scm_handoff_readiness(&base_drilldown(Vec::new()));

    assert_eq!(
        readiness.readiness.state,
        SelectedTaskScmHandoffState::Missing
    );
    assert_eq!(
        readiness.next.category,
        SelectedTaskScmHandoffNextCategory::PlanningAmbiguity
    );
    assert_eq!(readiness.source_counts.scm_handoff_refs, 0);
    assert!(!readiness.no_effects.scm_mutation_performed);
    assert!(!readiness.no_effects.forge_mutation_performed);
    assert!(!readiness.no_effects.credential_resolution_performed);
}

#[test]
fn handoff_readiness_blocks_when_required_evidence_is_missing() {
    let mut drilldown = base_drilldown(vec!["scm-session:1", "change:commit:abc"]);
    drilldown.work_progress.work_items.clear();

    let readiness = selected_task_scm_handoff_readiness(&drilldown);

    assert_eq!(
        readiness.readiness.state,
        SelectedTaskScmHandoffState::Blocked
    );
    assert!(readiness.source_counts.gap_count > 0);
    assert_eq!(
        readiness.next.category,
        SelectedTaskScmHandoffNextCategory::InspectEvidence
    );
}

#[test]
fn handoff_readiness_accepts_git_like_evidence_without_git_assumptions() {
    let readiness = selected_task_scm_handoff_readiness(&base_drilldown(vec![
        "scm-session:git:1",
        "change:commit:abc",
        "prep:forge-review:1",
        "target:pull-request:ready",
    ]));

    assert_eq!(
        readiness.readiness.state,
        SelectedTaskScmHandoffState::PrepReady
    );
    assert_eq!(
        readiness.target.shape,
        SelectedTaskScmHandoffTargetShape::ForgeReview
    );
    assert_eq!(
        readiness.next.category,
        SelectedTaskScmHandoffNextCategory::ReviewPreparation
    );
    assert_eq!(readiness.source_counts.provider_change_refs, 1);
}

#[test]
fn handoff_readiness_accepts_convergence_like_publication_refs() {
    let readiness = selected_task_scm_handoff_readiness(&base_drilldown(vec![
        "scm-session:convergence:1",
        "change:snapshot:abc",
        "prep:provider-publication:1",
        "publication-pending:gate:1",
    ]));

    assert_eq!(
        readiness.readiness.state,
        SelectedTaskScmHandoffState::PublicationPending
    );
    assert_eq!(
        readiness.target.shape,
        SelectedTaskScmHandoffTargetShape::ProviderPublication
    );
    assert_eq!(
        readiness.next.category,
        SelectedTaskScmHandoffNextCategory::PublishHandoff
    );
}

#[test]
fn handoff_readiness_routes_superseded_refs_to_repair() {
    let readiness = selected_task_scm_handoff_readiness(&base_drilldown(vec![
        "scm-session:1",
        "change:snapshot:old",
        "repair:superseded-change-ref:1",
    ]));

    assert_eq!(
        readiness.readiness.state,
        SelectedTaskScmHandoffState::RepairRequired
    );
    assert_eq!(
        readiness.next.category,
        SelectedTaskScmHandoffNextCategory::Repair
    );
    assert_eq!(readiness.source_counts.repair_refs, 1);
}

fn base_drilldown(scm_handoff_refs: Vec<&str>) -> TaskWorkflowDrilldown {
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
        work_progress: vec![completed_item("work:1")],
        runtime_receipt_refs: vec!["receipt:task:1".to_owned()],
        command_evidence_refs: Vec::new(),
        task_completion_refs: vec!["completion:task:1".to_owned()],
        review_refs: vec!["review:accepted:1".to_owned()],
        scm_handoff_refs: scm_handoff_refs
            .into_iter()
            .map(ToOwned::to_owned)
            .collect(),
        next_step: Some(TaskWorkflowNextStepInput {
            source: TaskWorkflowNextStepSource::ScmHandoff,
            next_ref: Some("scm:handoff:1".to_owned()),
            summary: "Prepare SCM handoff".to_owned(),
            rationale_refs: vec!["review:accepted:1".to_owned()],
        }),
    })
}

fn completed_item(work_item_ref: &str) -> TaskWorkflowWorkProgressInput {
    TaskWorkflowWorkProgressInput {
        work_item_ref: work_item_ref.to_owned(),
        runtime_status: "completed".to_owned(),
        review_status: "accepted".to_owned(),
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
