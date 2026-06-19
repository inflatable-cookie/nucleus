use super::*;

#[test]
fn task_agent_diagnostics_expose_work_units_without_runtime_authority() {
    let source = EngineTaskAgentWorkUnitSourceRecord {
        source_id: EngineTaskAgentWorkUnitSourceId("source:work:1".to_owned()),
        source_cursor: EngineTaskAgentWorkUnitSourceCursor("cursor:1".to_owned()),
        work_item_id: EngineTaskWorkItemId("work:1".to_owned()),
        project_id: ProjectId("project:1".to_owned()),
        task_id: TaskId("task:1".to_owned()),
        command_id: "command:delegate".to_owned(),
        actor_ref: "actor:operator".to_owned(),
        adapter_id: "adapter:codex".to_owned(),
        provider_instance_id: "codex:local".to_owned(),
        idempotency_key: "click-1".to_owned(),
        task_revision: None,
        runtime: EngineTaskAgentWorkUnitRuntimeStatus::Scheduled,
        review: EngineTaskAgentWorkUnitReviewStatus::NotReady,
        refs: EngineTaskWorkItemRefs {
            session_id: Some(nucleus_agent_protocol::AgentSessionId(
                "session:codex:1".to_owned(),
            )),
            receipt_ids: vec![EngineRuntimeReceiptRecordId("receipt:1".to_owned())],
            checkpoint_ids: vec![EngineCheckpointRecordId("checkpoint:1".to_owned())],
            diff_summary_ids: vec![EngineDiffSummaryRecordId("diff:1".to_owned())],
            validation_refs: vec!["validation:1".to_owned()],
            artifact_refs: vec!["artifact:summary".to_owned()],
            ..EngineTaskWorkItemRefs::default()
        },
        previous_source_id: None,
        summary: "provider execution deferred".to_owned(),
    };

    let diagnostics = task_agent_diagnostics(&[source]);
    let json = serde_json::to_string(&diagnostics).expect("serialize task-agent diagnostics");

    assert!(!diagnostics.client_can_mutate_work_units);
    assert!(!diagnostics.provider_execution_available);
    assert_eq!(diagnostics.source_status, "records");
    assert_eq!(diagnostics.work_units[0].runtime, "scheduled");
    assert_eq!(diagnostics.work_units[0].review, "not_ready");
    assert_eq!(
        diagnostics.work_units[0].session_id,
        Some("session:codex:1".to_owned())
    );
    assert_eq!(
        diagnostics.work_units[0].receipt_ids,
        vec!["receipt:1".to_owned()]
    );
    assert_eq!(
        diagnostics.work_units[0].checkpoint_ids,
        vec!["checkpoint:1".to_owned()]
    );
    assert_eq!(
        diagnostics.work_units[0].diff_summary_ids,
        vec!["diff:1".to_owned()]
    );
    assert!(!json.contains("raw_stdout"));
    assert!(!json.contains("provider payload"));
}
