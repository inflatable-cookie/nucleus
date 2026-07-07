use nucleus_core::RevisionId;
use nucleus_local_store::SqliteBackend;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::{
    persist_selected_task_review_decision, read_selected_task_review_decisions,
    selected_task_review_decision_admission, selected_task_review_next, task_workflow_drilldown,
    SelectedTaskReviewDecisionAction, SelectedTaskReviewDecisionAdmissionInput,
    SelectedTaskReviewDecisionIntent, SelectedTaskReviewDecisionOutcome,
    SelectedTaskReviewDecisionPersistenceBlocker, SelectedTaskReviewDecisionPersistenceInput,
    SelectedTaskReviewDecisionPersistenceStatus, ServerStateService, TaskWorkflowDrilldown,
    TaskWorkflowDrilldownInput, TaskWorkflowNextStepInput, TaskWorkflowNextStepSource,
    TaskWorkflowReadinessInput, TaskWorkflowTaskInput, TaskWorkflowWorkProgressInput,
};

#[test]
fn selected_task_review_decision_persistence_survives_reopen() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let db = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(db.clone()));

    let record =
        persist_selected_task_review_decision(&state, persistence_input("awaiting_review"))
            .expect("persist decision");

    let reopened = ServerStateService::new(SqliteBackend::new(db));
    let records = read_selected_task_review_decisions(&reopened).expect("read persisted decisions");

    assert_eq!(records, vec![record]);
    assert_eq!(
        records[0].outcome,
        SelectedTaskReviewDecisionOutcome::Accepted
    );
    assert_eq!(records[0].work_item_refs, vec!["work:1"]);
    assert_eq!(
        records[0].receipt_refs,
        vec!["receipt:task:1", "receipt:work:1"]
    );
    assert_eq!(
        records[0].timeline_refs,
        vec![
            "timeline:selected-task-review-decision:task:1",
            "timeline:task:1",
            "timeline:work:1"
        ]
    );
    assert!(!records[0].task_lifecycle_mutation_performed);
    assert!(!records[0].provider_execution_performed);
    assert!(!records[0].scm_or_forge_mutation_performed);
    assert!(!records[0].raw_provider_material_retained);
}

#[test]
fn selected_task_review_decision_duplicate_is_noop_without_write() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let mut input = persistence_input("awaiting_review");
    input
        .existing_decision_ids
        .push(input.admission.decision_id.clone());

    let record = persist_selected_task_review_decision(&state, input).expect("duplicate decision");

    assert_eq!(
        record.status,
        SelectedTaskReviewDecisionPersistenceStatus::DuplicateNoop
    );
    assert!(record.duplicate_decision_detected);
    assert!(read_selected_task_review_decisions(&state)
        .expect("read persisted decisions")
        .is_empty());
}

#[test]
fn selected_task_review_decision_persistence_blocks_external_effects() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let mut input = persistence_input("awaiting_review");
    input.raw_provider_material_present = true;
    input.raw_command_output_present = true;
    input.task_lifecycle_mutation_requested = true;
    input.provider_execution_requested = true;
    input.scm_or_forge_mutation_requested = true;
    input.memory_or_planning_apply_requested = true;
    input.ui_effect_requested = true;

    let record = persist_selected_task_review_decision(&state, input).expect("blocked decision");

    assert_eq!(
        record.status,
        SelectedTaskReviewDecisionPersistenceStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&SelectedTaskReviewDecisionPersistenceBlocker::RawProviderMaterialPresent));
    assert!(record
        .blockers
        .contains(&SelectedTaskReviewDecisionPersistenceBlocker::TaskLifecycleMutationRequested));
    assert!(record
        .blockers
        .contains(&SelectedTaskReviewDecisionPersistenceBlocker::ScmOrForgeMutationRequested));
    assert!(!record.task_lifecycle_mutation_performed);
    assert!(!record.provider_execution_performed);
    assert!(!record.scm_or_forge_mutation_performed);
    assert!(read_selected_task_review_decisions(&state)
        .expect("read persisted decisions")
        .is_empty());
}

#[test]
fn selected_task_review_decision_persistence_blocks_non_admitted_decision() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let input = persistence_input("accepted");

    let record = persist_selected_task_review_decision(&state, input).expect("blocked decision");

    assert_eq!(
        record.status,
        SelectedTaskReviewDecisionPersistenceStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&SelectedTaskReviewDecisionPersistenceBlocker::AdmissionNotAdmitted));
    assert!(!record.review_mutation_performed);
}

fn persistence_input(review_status: &str) -> SelectedTaskReviewDecisionPersistenceInput {
    let review_next = selected_task_review_next(&drilldown(review_status));
    let admission =
        selected_task_review_decision_admission(SelectedTaskReviewDecisionAdmissionInput {
            review_next: review_next.clone(),
            intent: SelectedTaskReviewDecisionIntent {
                action: SelectedTaskReviewDecisionAction::AcceptEvidence,
                expected_revision: Some(RevisionId("rev:review:1".to_owned())),
                operator_ref: "operator:test".to_owned(),
                reviewed_evidence_refs: vec!["checkpoint:work:1".to_owned()],
                idempotency_key: "key:1".to_owned(),
                reason: Some("reviewed".to_owned()),
            },
            current_revision: Some(RevisionId("rev:review:1".to_owned())),
            existing_decision_ids: Vec::new(),
        });

    SelectedTaskReviewDecisionPersistenceInput {
        admission,
        review_next,
        existing_decision_ids: Vec::new(),
        raw_provider_material_present: false,
        raw_command_output_present: false,
        task_lifecycle_mutation_requested: false,
        provider_execution_requested: false,
        scm_or_forge_mutation_requested: false,
        memory_or_planning_apply_requested: false,
        ui_effect_requested: false,
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
