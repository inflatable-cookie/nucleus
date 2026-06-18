use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;
use nucleus_tasks::{TaskActionType, TaskId};

use super::*;
use crate::{
    EngineTaskAgentWorkUnitProjectionIssue, EngineTaskWorkItemAssignment, EngineTaskWorkItemId,
    EngineTaskWorkItemRecord, EngineTaskWorkItemRefs, EngineTaskWorkItemReviewState,
    EngineTaskWorkItemRuntimeState,
};

#[test]
fn task_agent_work_unit_admission_creates_source_record_without_provider_execution() {
    let work_item = work_item("work-item:task:1:click-1");

    let admission = admit_task_agent_work_unit(
        "command:delegate",
        "actor:operator",
        "click-1",
        Some(RevisionId("rev:task:1".to_owned())),
        &work_item,
    );

    assert!(admission.provider_execution_deferred);
    assert_eq!(
        admission.source_record.source_id.0,
        "task-agent-source:work-item:task:1:click-1:click-1"
    );
    assert_eq!(admission.source_record.task_id, TaskId("task:1".to_owned()));
    assert_eq!(
        admission.source_record.runtime,
        EngineTaskAgentWorkUnitRuntimeStatus::Scheduled
    );
    assert_eq!(
        admission.source_record.review,
        EngineTaskAgentWorkUnitReviewStatus::NotReady
    );
    assert_eq!(admission.source_record.adapter_id, "adapter:codex");
    assert_eq!(admission.source_record.provider_instance_id, "codex:local");
}

#[test]
fn task_agent_work_unit_projection_rebuilds_latest_state_deterministically() {
    let work_item = work_item("work-item:task:1:click-1");
    let mut first = admit_task_agent_work_unit(
        "command:delegate",
        "actor:operator",
        "click-1",
        None,
        &work_item,
    )
    .source_record;
    first.source_cursor = EngineTaskAgentWorkUnitSourceCursor("cursor:001".to_owned());

    let mut second = first.clone();
    second.source_id = EngineTaskAgentWorkUnitSourceId("source:running".to_owned());
    second.source_cursor = EngineTaskAgentWorkUnitSourceCursor("cursor:002".to_owned());
    second.runtime = EngineTaskAgentWorkUnitRuntimeStatus::Running;
    second.previous_source_id = Some(first.source_id.clone());
    second.summary = "runtime accepted by scheduler".to_owned();

    let projections = project_task_agent_work_units(&[second.clone(), first.clone()]);

    assert_eq!(projections.len(), 1);
    assert_eq!(projections[0].source_count, 2);
    assert_eq!(
        projections[0].runtime,
        EngineTaskAgentWorkUnitRuntimeStatus::Running
    );
    assert_eq!(projections[0].last_cursor.0, "cursor:002");
    assert!(projections[0].issues.is_empty());
}

#[test]
fn task_agent_work_unit_projection_surfaces_repair_issues_without_payloads() {
    let work_item = EngineTaskWorkItemRecord {
        assignment: EngineTaskWorkItemAssignment::Unassigned,
        summary: Some("contains raw stdout".to_owned()),
        ..work_item("work-item:task:1:broken")
    };
    let record = admit_task_agent_work_unit("command:delegate", "", "click-1", None, &work_item)
        .source_record;

    let projections = project_task_agent_work_units(&[record]);

    assert!(projections[0]
        .issues
        .contains(&EngineTaskAgentWorkUnitProjectionIssue::EmptyActorRef));
    assert!(projections[0]
        .issues
        .contains(&EngineTaskAgentWorkUnitProjectionIssue::EmptyAdapterRef));
    assert!(projections[0]
        .issues
        .contains(&EngineTaskAgentWorkUnitProjectionIssue::EmptyProviderInstanceRef));
}

#[test]
fn task_agent_work_unit_diagnostics_are_read_only_and_source_backed() {
    let source = admit_task_agent_work_unit(
        "command:delegate",
        "actor:operator",
        "click-1",
        None,
        &work_item("work-item:task:1:click-1"),
    )
    .source_record;

    let diagnostics = task_agent_work_unit_diagnostics(&[source]);

    assert_eq!(diagnostics.source_status, "records");
    assert_eq!(diagnostics.source_count, 1);
    assert!(!diagnostics.provider_execution_available);
    assert_eq!(diagnostics.projections.len(), 1);
}

fn work_item(work_item_id: &str) -> EngineTaskWorkItemRecord {
    EngineTaskWorkItemRecord {
        work_item_id: EngineTaskWorkItemId(work_item_id.to_owned()),
        task_id: TaskId("task:1".to_owned()),
        project_id: ProjectId("project:1".to_owned()),
        title: "Run task".to_owned(),
        intent: TaskActionType::Plan,
        assignment: EngineTaskWorkItemAssignment::AdapterInstance {
            adapter_id: "adapter:codex".to_owned(),
            provider_instance_id: "codex:local".to_owned(),
        },
        runtime: EngineTaskWorkItemRuntimeState::Scheduled,
        review: EngineTaskWorkItemReviewState::NotReady,
        refs: EngineTaskWorkItemRefs::default(),
        summary: Some("runtime execution deferred".to_owned()),
    }
}
