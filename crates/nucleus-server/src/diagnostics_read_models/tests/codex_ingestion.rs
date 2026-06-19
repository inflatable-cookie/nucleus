use super::*;
use crate::{
    CodexTaskRuntimeObservationLink, CodexTaskRuntimeObservationLinkStatus,
    CodexTaskRuntimeRequestId,
};

#[test]
fn codex_ingestion_diagnostics_are_read_only_and_actionable() {
    let links = vec![
        CodexTaskRuntimeObservationLink {
            link_id: "link:accepted".to_owned(),
            request_id: CodexTaskRuntimeRequestId("request:1".to_owned()),
            task_id: TaskId("task:1".to_owned()),
            work_item_id: EngineTaskWorkItemId("work:1".to_owned()),
            source_id: "source:accepted".to_owned(),
            binding_id: "binding:codex".to_owned(),
            event_store_event_id: Some("event:codex-observation:1".to_owned()),
            receipt_id: None,
            evidence_refs: vec![
                "source:accepted".to_owned(),
                "event:codex-observation:1".to_owned(),
            ],
            status: CodexTaskRuntimeObservationLinkStatus::Linked,
            permits_task_state_mutation: false,
            summary: "linked observation".to_owned(),
        },
        CodexTaskRuntimeObservationLink {
            link_id: "link:duplicate".to_owned(),
            request_id: CodexTaskRuntimeRequestId("request:1".to_owned()),
            task_id: TaskId("task:1".to_owned()),
            work_item_id: EngineTaskWorkItemId("work:1".to_owned()),
            source_id: "source:duplicate".to_owned(),
            binding_id: "binding:codex".to_owned(),
            event_store_event_id: None,
            receipt_id: None,
            evidence_refs: vec!["source:duplicate".to_owned()],
            status: CodexTaskRuntimeObservationLinkStatus::NotLinked(
                "observation status is Duplicate".to_owned(),
            ),
            permits_task_state_mutation: false,
            summary: "duplicate observation".to_owned(),
        },
    ];

    let diagnostics = codex_ingestion_diagnostics(&links);
    let json = serde_json::to_string(&diagnostics).expect("serialize diagnostics");

    assert!(!diagnostics.client_can_mutate_observations);
    assert!(!diagnostics.provider_execution_available);
    assert_eq!(diagnostics.source_status, "records");
    assert_eq!(diagnostics.observations[0].status, "linked");
    assert_eq!(diagnostics.observations[0].next_action, "none");
    assert_eq!(diagnostics.observations[1].status, "not_linked");
    assert_eq!(diagnostics.observations[1].next_action, "ignore_duplicate");
    assert!(!diagnostics.observations[0].permits_task_state_mutation);
    assert!(!json.contains("raw_provider_payload"));
    assert!(!json.contains("terminal_stream"));
}
