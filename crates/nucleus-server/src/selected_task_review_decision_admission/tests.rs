use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::{
    selected_task_review_decision_admission, selected_task_review_next, task_workflow_drilldown,
    SelectedTaskReviewDecisionAction, SelectedTaskReviewDecisionAdmissionInput,
    SelectedTaskReviewDecisionAdmissionRefusalKind, SelectedTaskReviewDecisionAdmissionStatus,
    SelectedTaskReviewDecisionIntent, SelectedTaskReviewDecisionOutcome, TaskWorkflowDrilldown,
    TaskWorkflowDrilldownInput, TaskWorkflowNextStepInput, TaskWorkflowNextStepSource,
    TaskWorkflowReadinessInput, TaskWorkflowTaskInput, TaskWorkflowWorkProgressInput,
};

#[test]
fn admits_accept_decision_for_awaiting_review_evidence_without_effects() {
    let admission = selected_task_review_decision_admission(input(
        "awaiting_review",
        SelectedTaskReviewDecisionAction::AcceptEvidence,
        Some("rev:review:1"),
        Some("rev:review:1"),
        vec!["checkpoint:work:1"],
        "reviewed and accepted",
        Vec::new(),
    ));

    assert_eq!(
        admission.status,
        SelectedTaskReviewDecisionAdmissionStatus::Admitted
    );
    assert_eq!(
        admission.command.as_ref().map(|command| command.outcome),
        Some(SelectedTaskReviewDecisionOutcome::Accepted)
    );
    assert_eq!(admission.evidence_refs, vec!["checkpoint:work:1"]);
    assert!(!admission.no_effects.review_mutation_performed);
    assert!(!admission.no_effects.task_mutation_performed);
    assert!(!admission.no_effects.provider_execution_performed);
    assert!(!admission.no_effects.scm_or_forge_mutation_performed);
    assert!(!admission.no_effects.agent_scheduling_performed);
}

#[test]
fn requires_reason_for_request_changes() {
    let admission = selected_task_review_decision_admission(input(
        "awaiting_review",
        SelectedTaskReviewDecisionAction::RequestChanges,
        Some("rev:review:1"),
        Some("rev:review:1"),
        vec!["checkpoint:work:1"],
        " ",
        Vec::new(),
    ));

    assert_eq!(
        admission.status,
        SelectedTaskReviewDecisionAdmissionStatus::Blocked
    );
    assert_eq!(
        admission.refusal.as_ref().map(|refusal| refusal.kind),
        Some(SelectedTaskReviewDecisionAdmissionRefusalKind::ReasonRequired)
    );
    assert!(admission.command.is_none());
}

#[test]
fn refuses_missing_reviewed_evidence_refs() {
    let admission = selected_task_review_decision_admission(input(
        "awaiting_review",
        SelectedTaskReviewDecisionAction::AcceptEvidence,
        Some("rev:review:1"),
        Some("rev:review:1"),
        Vec::new(),
        "",
        Vec::new(),
    ));

    assert_eq!(
        admission.status,
        SelectedTaskReviewDecisionAdmissionStatus::MissingEvidence
    );
    assert_eq!(
        admission.refusal.as_ref().map(|refusal| refusal.kind),
        Some(SelectedTaskReviewDecisionAdmissionRefusalKind::MissingReviewedEvidence)
    );
}

#[test]
fn refuses_unknown_reviewed_evidence_refs() {
    let admission = selected_task_review_decision_admission(input(
        "awaiting_review",
        SelectedTaskReviewDecisionAction::AcceptEvidence,
        Some("rev:review:1"),
        Some("rev:review:1"),
        vec!["external:raw"],
        "",
        Vec::new(),
    ));

    assert_eq!(
        admission.status,
        SelectedTaskReviewDecisionAdmissionStatus::MissingEvidence
    );
    assert_eq!(
        admission.refusal.as_ref().map(|refusal| refusal.kind),
        Some(SelectedTaskReviewDecisionAdmissionRefusalKind::UnknownReviewedEvidence)
    );
}

#[test]
fn marks_stale_when_expected_revision_mismatches_current_revision() {
    let admission = selected_task_review_decision_admission(input(
        "awaiting_review",
        SelectedTaskReviewDecisionAction::AcceptEvidence,
        Some("rev:review:old"),
        Some("rev:review:1"),
        vec!["checkpoint:work:1"],
        "",
        Vec::new(),
    ));

    assert_eq!(
        admission.status,
        SelectedTaskReviewDecisionAdmissionStatus::Stale
    );
    assert_eq!(
        admission.refusal.as_ref().map(|refusal| refusal.kind),
        Some(SelectedTaskReviewDecisionAdmissionRefusalKind::StaleRevision)
    );
}

#[test]
fn marks_duplicate_from_idempotency_key() {
    let admission = selected_task_review_decision_admission(input(
        "awaiting_review",
        SelectedTaskReviewDecisionAction::AcceptEvidence,
        Some("rev:review:1"),
        Some("rev:review:1"),
        vec!["checkpoint:work:1"],
        "",
        vec!["selected-task-review-decision:task:1:key:1"],
    ));

    assert_eq!(
        admission.status,
        SelectedTaskReviewDecisionAdmissionStatus::Duplicate
    );
    assert_eq!(
        admission.refusal.as_ref().map(|refusal| refusal.kind),
        Some(SelectedTaskReviewDecisionAdmissionRefusalKind::DuplicateDecision)
    );
}

#[test]
fn reports_noop_when_decision_is_already_represented() {
    let admission = selected_task_review_decision_admission(input(
        "accepted",
        SelectedTaskReviewDecisionAction::AcceptEvidence,
        Some("rev:review:1"),
        Some("rev:review:1"),
        vec!["checkpoint:work:1"],
        "",
        Vec::new(),
    ));

    assert_eq!(
        admission.status,
        SelectedTaskReviewDecisionAdmissionStatus::NoOp
    );
    assert_eq!(
        admission.refusal.as_ref().map(|refusal| refusal.kind),
        Some(SelectedTaskReviewDecisionAdmissionRefusalKind::DecisionAlreadyRepresented)
    );
}

fn input(
    review_status: &str,
    action: SelectedTaskReviewDecisionAction,
    expected_revision: Option<&str>,
    current_revision: Option<&str>,
    reviewed_evidence_refs: Vec<&str>,
    reason: &str,
    existing_decision_ids: Vec<&str>,
) -> SelectedTaskReviewDecisionAdmissionInput {
    SelectedTaskReviewDecisionAdmissionInput {
        review_next: selected_task_review_next(&drilldown(review_status)),
        intent: SelectedTaskReviewDecisionIntent {
            action,
            expected_revision: expected_revision.map(|revision| RevisionId(revision.to_owned())),
            operator_ref: "operator:test".to_owned(),
            reviewed_evidence_refs: reviewed_evidence_refs
                .into_iter()
                .map(str::to_owned)
                .collect(),
            idempotency_key: "key:1".to_owned(),
            reason: Some(reason.to_owned()),
        },
        current_revision: current_revision.map(|revision| RevisionId(revision.to_owned())),
        existing_decision_ids: existing_decision_ids
            .into_iter()
            .map(str::to_owned)
            .collect(),
    }
}

fn drilldown(review_status: &str) -> TaskWorkflowDrilldown {
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
        work_progress: vec![TaskWorkflowWorkProgressInput {
            work_item_ref: "work:1".to_owned(),
            runtime_status: "completed".to_owned(),
            review_status: review_status.to_owned(),
            source_ref: "source:work:1".to_owned(),
            source_count: 1,
            session_ref: Some("session:work:1".to_owned()),
            turn_refs: vec!["turn:work:1".to_owned()],
            receipt_refs: vec!["receipt:work:1".to_owned()],
            checkpoint_refs: vec!["checkpoint:work:1".to_owned()],
            diff_summary_refs: vec!["diff:work:1".to_owned()],
            timeline_entry_refs: vec!["timeline:work:1".to_owned()],
            validation_refs: vec!["validation:work:1".to_owned()],
            artifact_refs: Vec::new(),
            issue_refs: Vec::new(),
        }],
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
