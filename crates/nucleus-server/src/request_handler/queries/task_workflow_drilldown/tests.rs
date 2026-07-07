use nucleus_core::RevisionId;
use nucleus_engine::{
    EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId,
    EngineRuntimeReceiptRef, EngineRuntimeReceiptStatus, EngineTaskAgentWorkUnitReviewStatus,
    EngineTaskAgentWorkUnitRuntimeStatus, EngineTaskAgentWorkUnitSourceCursor,
    EngineTaskAgentWorkUnitSourceId, EngineTaskAgentWorkUnitSourceRecord, EngineTaskWorkItemId,
    EngineTaskWorkItemRefs,
};
use nucleus_local_store::{RevisionExpectation, SqliteBackend};
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use super::*;
use crate::project_seed::{seed_local_project, LocalProjectSeed};
use crate::runtime_receipt_state::write_runtime_receipt;
use crate::task_seed::{seed_local_task, LocalTaskSeed};
use crate::{
    persist_selected_task_review_decision, selected_task_review_decision_admission,
    selected_task_review_next, SelectedTaskReviewDecisionAction,
    SelectedTaskReviewDecisionAdmissionInput, SelectedTaskReviewDecisionIntent,
    SelectedTaskReviewDecisionPersistenceInput,
};

#[test]
fn task_workflow_drilldown_query_composes_selected_task_refs() {
    let (_temp_dir, handler) = handler();
    seed_project_task(&handler);
    persist_work_source(
        &handler,
        "project:nucleus-local",
        "task:nucleus-local:bootstrap",
        "work:item:bootstrap",
        "receipt:bootstrap",
        EngineTaskAgentWorkUnitReviewStatus::NotReady,
    );
    persist_receipt(&handler, "receipt:bootstrap", "command:evidence:bootstrap");

    let result = task_workflow_drilldown_query(
        &handler,
        TaskWorkflowDrilldownQuery {
            project_id: ProjectId("project:nucleus-local".to_owned()),
            task_id: TaskId("task:nucleus-local:bootstrap".to_owned()),
        },
    )
    .expect("drilldown");

    let ServerQueryResult::TaskWorkflowDrilldown(drilldown) = result else {
        panic!("expected drilldown result");
    };
    assert_eq!(
        drilldown.task.expect("task").title,
        "Review Nucleus task workflow"
    );
    assert_eq!(drilldown.work_progress.work_items.len(), 1);
    assert_eq!(
        drilldown.runtime.runtime_receipt_refs,
        vec!["receipt:bootstrap"]
    );
    assert_eq!(
        drilldown.runtime.command_evidence_refs,
        vec!["command:evidence:bootstrap"]
    );
    assert!(drilldown.review.review_refs.is_empty());
    assert!(!drilldown.no_effects.provider_execution_performed);
    assert!(!drilldown.no_effects.task_mutation_performed);
}

#[test]
fn task_workflow_drilldown_query_keeps_missing_task_empty() {
    let (_temp_dir, handler) = handler();
    seed_project_task(&handler);
    persist_work_source(
        &handler,
        "project:nucleus-local",
        "task:nucleus-local:bootstrap",
        "work:item:bootstrap",
        "receipt:bootstrap",
        EngineTaskAgentWorkUnitReviewStatus::NotReady,
    );

    let result = task_workflow_drilldown_query(
        &handler,
        TaskWorkflowDrilldownQuery {
            project_id: ProjectId("project:nucleus-local".to_owned()),
            task_id: TaskId("task:missing".to_owned()),
        },
    )
    .expect("drilldown");

    let ServerQueryResult::TaskWorkflowDrilldown(drilldown) = result else {
        panic!("expected drilldown result");
    };
    assert!(drilldown.task.is_none());
    assert_eq!(drilldown.work_progress.work_items.len(), 0);
    assert_eq!(drilldown.runtime.runtime_receipt_refs.len(), 0);
}

#[test]
fn task_workflow_drilldown_query_filters_cross_project_and_cross_task_records() {
    let (_temp_dir, handler) = handler();
    seed_project_task(&handler);
    persist_work_source(
        &handler,
        "project:nucleus-local",
        "task:nucleus-local:bootstrap",
        "work:item:included",
        "receipt:included",
        EngineTaskAgentWorkUnitReviewStatus::NotReady,
    );
    persist_work_source(
        &handler,
        "project:nucleus-local",
        "task:other",
        "work:item:other-task",
        "receipt:other-task",
        EngineTaskAgentWorkUnitReviewStatus::NotReady,
    );
    persist_work_source(
        &handler,
        "project:other",
        "task:nucleus-local:bootstrap",
        "work:item:other-project",
        "receipt:other-project",
        EngineTaskAgentWorkUnitReviewStatus::NotReady,
    );

    let result = task_workflow_drilldown_query(
        &handler,
        TaskWorkflowDrilldownQuery {
            project_id: ProjectId("project:nucleus-local".to_owned()),
            task_id: TaskId("task:nucleus-local:bootstrap".to_owned()),
        },
    )
    .expect("drilldown");

    let ServerQueryResult::TaskWorkflowDrilldown(drilldown) = result else {
        panic!("expected drilldown result");
    };
    assert_eq!(
        drilldown
            .work_progress
            .work_items
            .iter()
            .map(|item| item.work_item_ref.as_str())
            .collect::<Vec<_>>(),
        vec!["work:item:included"]
    );
    assert!(drilldown.review.review_refs.is_empty());
}

#[test]
fn task_workflow_drilldown_query_refreshes_from_selected_task_review_decision_records() {
    let (_temp_dir, handler) = handler();
    seed_project_task(&handler);
    persist_reviewable_work_source(
        &handler,
        "project:nucleus-local",
        "task:nucleus-local:bootstrap",
        "work:item:bootstrap",
        "receipt:bootstrap",
    );
    persist_receipt(&handler, "receipt:bootstrap", "command:evidence:bootstrap");

    let first = task_workflow_drilldown_query(
        &handler,
        TaskWorkflowDrilldownQuery {
            project_id: ProjectId("project:nucleus-local".to_owned()),
            task_id: TaskId("task:nucleus-local:bootstrap".to_owned()),
        },
    )
    .expect("first drilldown");
    let ServerQueryResult::TaskWorkflowDrilldown(drilldown) = first else {
        panic!("expected drilldown result");
    };
    let review_next = selected_task_review_next(&drilldown);
    let admission =
        selected_task_review_decision_admission(SelectedTaskReviewDecisionAdmissionInput {
            review_next: review_next.clone(),
            intent: SelectedTaskReviewDecisionIntent {
                action: SelectedTaskReviewDecisionAction::AcceptEvidence,
                expected_revision: Some(RevisionId("rev:review:1".to_owned())),
                operator_ref: "operator:test".to_owned(),
                reviewed_evidence_refs: vec!["receipt:bootstrap".to_owned()],
                idempotency_key: "review:key:1".to_owned(),
                reason: Some("accepted evidence".to_owned()),
            },
            current_revision: Some(RevisionId("rev:review:1".to_owned())),
            existing_decision_ids: Vec::new(),
        });
    let record = persist_selected_task_review_decision(
        handler.state(),
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
        },
    )
    .expect("persist selected-task review decision");

    let refreshed = task_workflow_drilldown_query(
        &handler,
        TaskWorkflowDrilldownQuery {
            project_id: ProjectId("project:nucleus-local".to_owned()),
            task_id: TaskId("task:nucleus-local:bootstrap".to_owned()),
        },
    )
    .expect("refreshed drilldown");

    let ServerQueryResult::TaskWorkflowDrilldown(drilldown) = refreshed else {
        panic!("expected drilldown result");
    };
    assert_eq!(
        drilldown.work_progress.work_items[0].review_status,
        "accepted"
    );
    assert!(drilldown.review.review_refs.contains(&record.decision_id));
    assert!(drilldown.timeline.entry_refs.contains(&format!(
        "timeline:selected-task-review-decision:{}",
        "task:nucleus-local:bootstrap"
    )));
    assert!(!drilldown.no_effects.task_mutation_performed);
    assert!(!drilldown.no_effects.provider_execution_performed);
    assert!(!drilldown.no_effects.scm_or_forge_mutation_performed);
}

fn handler() -> (
    tempfile::TempDir,
    crate::request_handler::LocalControlRequestHandler<SqliteBackend>,
) {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let backend = SqliteBackend::new(temp_dir.path().join("state.sqlite"));
    let handler = crate::request_handler::LocalControlRequestHandler::new(backend, None);
    (temp_dir, handler)
}

fn seed_project_task(handler: &crate::request_handler::LocalControlRequestHandler<SqliteBackend>) {
    seed_local_project(handler.state(), LocalProjectSeed::nucleus_local()).expect("project");
    seed_local_task(handler.state(), LocalTaskSeed::nucleus_local_bootstrap()).expect("task");
}

fn persist_work_source(
    handler: &crate::request_handler::LocalControlRequestHandler<SqliteBackend>,
    project_id: &str,
    task_id: &str,
    work_item_id: &str,
    receipt_id: &str,
    review: EngineTaskAgentWorkUnitReviewStatus,
) {
    let record = EngineTaskAgentWorkUnitSourceRecord {
        source_id: EngineTaskAgentWorkUnitSourceId(format!("source:{work_item_id}")),
        source_cursor: EngineTaskAgentWorkUnitSourceCursor(format!("cursor:{work_item_id}")),
        work_item_id: EngineTaskWorkItemId(work_item_id.to_owned()),
        project_id: ProjectId(project_id.to_owned()),
        task_id: TaskId(task_id.to_owned()),
        command_id: format!("command:{work_item_id}"),
        actor_ref: "operator:test".to_owned(),
        adapter_id: "adapter:codex".to_owned(),
        provider_instance_id: "provider:codex:local".to_owned(),
        idempotency_key: format!("idem:{work_item_id}"),
        task_revision: Some(RevisionId(format!("rev:{task_id}"))),
        runtime: EngineTaskAgentWorkUnitRuntimeStatus::Scheduled,
        review,
        refs: EngineTaskWorkItemRefs {
            receipt_ids: vec![EngineRuntimeReceiptRecordId(receipt_id.to_owned())],
            timeline_entry_ids: vec![nucleus_engine::EngineTaskTimelineEntryId(format!(
                "timeline:{work_item_id}"
            ))],
            ..EngineTaskWorkItemRefs::default()
        },
        previous_source_id: None,
        summary: "sanitized work summary".to_owned(),
    };
    crate::task_agent_work_unit_state::write_task_agent_work_unit_source_record(
        handler.state(),
        record,
        RevisionId(format!("rev:{work_item_id}")),
        RevisionExpectation::MustNotExist,
    )
    .expect("write task-agent source");
}

fn persist_reviewable_work_source(
    handler: &crate::request_handler::LocalControlRequestHandler<SqliteBackend>,
    project_id: &str,
    task_id: &str,
    work_item_id: &str,
    receipt_id: &str,
) {
    let scheduled = work_source_record(
        project_id,
        task_id,
        work_item_id,
        receipt_id,
        "0001-scheduled",
        EngineTaskAgentWorkUnitRuntimeStatus::Scheduled,
        EngineTaskAgentWorkUnitReviewStatus::NotReady,
        None,
    );
    crate::task_agent_work_unit_state::write_task_agent_work_unit_source_record(
        handler.state(),
        scheduled.clone(),
        RevisionId(format!("rev:{work_item_id}:scheduled")),
        RevisionExpectation::MustNotExist,
    )
    .expect("write scheduled source");

    let running = work_source_record(
        project_id,
        task_id,
        work_item_id,
        receipt_id,
        "0002-running",
        EngineTaskAgentWorkUnitRuntimeStatus::Running,
        EngineTaskAgentWorkUnitReviewStatus::NotReady,
        Some(scheduled.source_id.clone()),
    );
    crate::task_agent_work_unit_state::write_task_agent_work_unit_source_record(
        handler.state(),
        running.clone(),
        RevisionId(format!("rev:{work_item_id}:running")),
        RevisionExpectation::MustNotExist,
    )
    .expect("write running source");

    let awaiting = work_source_record(
        project_id,
        task_id,
        work_item_id,
        receipt_id,
        "0003-awaiting",
        EngineTaskAgentWorkUnitRuntimeStatus::Completed,
        EngineTaskAgentWorkUnitReviewStatus::AwaitingReview,
        Some(running.source_id.clone()),
    );
    crate::task_agent_work_unit_state::write_task_agent_work_unit_source_record(
        handler.state(),
        awaiting,
        RevisionId(format!("rev:{work_item_id}:awaiting")),
        RevisionExpectation::MustNotExist,
    )
    .expect("write awaiting review source");
}

fn work_source_record(
    project_id: &str,
    task_id: &str,
    work_item_id: &str,
    receipt_id: &str,
    source_suffix: &str,
    runtime: EngineTaskAgentWorkUnitRuntimeStatus,
    review: EngineTaskAgentWorkUnitReviewStatus,
    previous_source_id: Option<EngineTaskAgentWorkUnitSourceId>,
) -> EngineTaskAgentWorkUnitSourceRecord {
    EngineTaskAgentWorkUnitSourceRecord {
        source_id: EngineTaskAgentWorkUnitSourceId(format!(
            "source:{work_item_id}:{source_suffix}"
        )),
        source_cursor: EngineTaskAgentWorkUnitSourceCursor(format!(
            "cursor:{work_item_id}:{source_suffix}"
        )),
        work_item_id: EngineTaskWorkItemId(work_item_id.to_owned()),
        project_id: ProjectId(project_id.to_owned()),
        task_id: TaskId(task_id.to_owned()),
        command_id: format!("command:{work_item_id}"),
        actor_ref: "operator:test".to_owned(),
        adapter_id: "adapter:codex".to_owned(),
        provider_instance_id: "provider:codex:local".to_owned(),
        idempotency_key: format!("idem:{work_item_id}:{source_suffix}"),
        task_revision: Some(RevisionId(format!("rev:{task_id}"))),
        runtime,
        review,
        refs: EngineTaskWorkItemRefs {
            receipt_ids: vec![EngineRuntimeReceiptRecordId(receipt_id.to_owned())],
            timeline_entry_ids: vec![nucleus_engine::EngineTaskTimelineEntryId(format!(
                "timeline:{work_item_id}:{source_suffix}"
            ))],
            checkpoint_ids: vec![nucleus_engine::EngineCheckpointRecordId(format!(
                "checkpoint:{work_item_id}"
            ))],
            diff_summary_ids: vec![nucleus_engine::EngineDiffSummaryRecordId(format!(
                "diff:{work_item_id}"
            ))],
            validation_refs: vec![format!("validation:{work_item_id}")],
            ..EngineTaskWorkItemRefs::default()
        },
        previous_source_id,
        summary: "sanitized work summary".to_owned(),
    }
}

fn persist_receipt(
    handler: &crate::request_handler::LocalControlRequestHandler<SqliteBackend>,
    receipt_id: &str,
    evidence_id: &str,
) {
    write_runtime_receipt(
        handler.state(),
        &EngineRuntimeReceiptRecord {
            receipt_id: EngineRuntimeReceiptRecordId(receipt_id.to_owned()),
            family: EngineRuntimeReceiptEffectFamily::CommandExecution,
            status: EngineRuntimeReceiptStatus::Completed,
            command_ref: None,
            effect_ref: None,
            evidence_refs: vec![EngineRuntimeReceiptRef::CommandEvidenceId(
                evidence_id.to_owned(),
            )],
            artifact_refs: Vec::new(),
            summary: Some("receipt summary".to_owned()),
        },
        RevisionId(format!("rev:{receipt_id}")),
        RevisionExpectation::MustNotExist,
    )
    .expect("write receipt");
}
