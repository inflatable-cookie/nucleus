use nucleus_agent_protocol::{AgentSessionId, AgentTurnId};
use nucleus_core::RevisionId;
use nucleus_engine::{
    EngineCheckpointRecordId, EngineDiffSummaryRecordId, EngineRuntimeReceiptRecordId,
    EngineTaskAgentWorkUnitReviewStatus, EngineTaskAgentWorkUnitRuntimeStatus,
    EngineTaskAgentWorkUnitSourceCursor, EngineTaskAgentWorkUnitSourceId,
    EngineTaskAgentWorkUnitSourceRecord, EngineTaskTimelineEntryId, EngineTaskWorkItemId,
    EngineTaskWorkItemRefs,
};
use nucleus_local_store::SqliteBackend;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::state::ServerStateService;

pub(super) fn state() -> (
    tempfile::TempDir,
    ServerStateService<nucleus_local_store::SqliteBackend>,
) {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
    (temp_dir, ServerStateService::new(backend))
}

pub(super) fn source_record(source_id: &str, cursor: &str) -> EngineTaskAgentWorkUnitSourceRecord {
    EngineTaskAgentWorkUnitSourceRecord {
        source_id: EngineTaskAgentWorkUnitSourceId(source_id.to_owned()),
        source_cursor: EngineTaskAgentWorkUnitSourceCursor(cursor.to_owned()),
        work_item_id: EngineTaskWorkItemId("work:item:1".to_owned()),
        project_id: ProjectId("project:1".to_owned()),
        task_id: TaskId("task:1".to_owned()),
        command_id: "command:1".to_owned(),
        actor_ref: "operator:tom".to_owned(),
        adapter_id: "adapter:codex".to_owned(),
        provider_instance_id: "provider:codex:local".to_owned(),
        idempotency_key: "idem:1".to_owned(),
        task_revision: Some(RevisionId("task:rev:1".to_owned())),
        runtime: EngineTaskAgentWorkUnitRuntimeStatus::Scheduled,
        review: EngineTaskAgentWorkUnitReviewStatus::NotReady,
        refs: source_refs(),
        previous_source_id: None,
        summary: "work unit is running with sanitized progress".to_owned(),
    }
}

pub(super) fn transitioned_source_record(
    previous: &EngineTaskAgentWorkUnitSourceRecord,
    source_id: &str,
    cursor: &str,
    runtime: EngineTaskAgentWorkUnitRuntimeStatus,
    review: EngineTaskAgentWorkUnitReviewStatus,
) -> EngineTaskAgentWorkUnitSourceRecord {
    EngineTaskAgentWorkUnitSourceRecord {
        source_id: EngineTaskAgentWorkUnitSourceId(source_id.to_owned()),
        source_cursor: EngineTaskAgentWorkUnitSourceCursor(cursor.to_owned()),
        runtime,
        review,
        previous_source_id: Some(previous.source_id.clone()),
        summary: "work unit transition is sanitized".to_owned(),
        ..previous.clone()
    }
}

fn source_refs() -> EngineTaskWorkItemRefs {
    EngineTaskWorkItemRefs {
        session_id: Some(AgentSessionId("session:1".to_owned())),
        turn_ids: vec![AgentTurnId("turn:1".to_owned())],
        receipt_ids: vec![EngineRuntimeReceiptRecordId("receipt:1".to_owned())],
        checkpoint_ids: vec![EngineCheckpointRecordId("checkpoint:1".to_owned())],
        diff_summary_ids: vec![EngineDiffSummaryRecordId("diff:1".to_owned())],
        timeline_entry_ids: vec![EngineTaskTimelineEntryId("timeline:1".to_owned())],
        validation_refs: vec!["validation:cargo-test".to_owned()],
        artifact_refs: vec!["artifact:diff-summary".to_owned()],
    }
}
