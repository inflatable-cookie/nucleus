use crate::{
    codex_subscription_diagnostics, CodexAppServerStdioWriteState, CodexAppServerStdioWriteStateId,
    CodexAppServerStdioWriteStateRecord, CodexAppServerSubscriptionState,
    CodexAppServerSubscriptionStateId, CodexAppServerSubscriptionStateRecord,
};

#[test]
fn codex_subscription_diagnostics_are_read_only_and_sanitized() {
    let diagnostics = codex_subscription_diagnostics(
        &[CodexAppServerStdioWriteStateRecord {
            write_id: CodexAppServerStdioWriteStateId("write:1".to_owned()),
            command_id: "send:1".to_owned(),
            envelope_id: "envelope:1".to_owned(),
            request_id: "request:1".to_owned(),
            method: "turn/start".to_owned(),
            state: CodexAppServerStdioWriteState::Written,
            evidence_refs: vec!["evidence:write".to_owned()],
            raw_payload_retained: false,
            raw_stream_retained: false,
        }],
        &[CodexAppServerSubscriptionStateRecord {
            subscription_id: CodexAppServerSubscriptionStateId("subscription:1".to_owned()),
            command_id: "send:1".to_owned(),
            envelope_id: "envelope:1".to_owned(),
            request_id: "request:1".to_owned(),
            state: CodexAppServerSubscriptionState::Open,
            evidence_refs: vec!["evidence:subscription".to_owned()],
            raw_stream_retained: false,
            callback_response_permitted: false,
            cancellation_permitted: false,
            task_mutation_permitted: false,
        }],
    );
    let json = serde_json::to_string(&diagnostics).expect("serialize diagnostics");

    assert_eq!(diagnostics.source_status, "records");
    assert!(!diagnostics.client_can_write_provider);
    assert!(!diagnostics.client_can_answer_callbacks);
    assert!(!diagnostics.client_can_cancel_provider);
    assert!(!diagnostics.client_can_mutate_tasks);
    assert_eq!(
        diagnostics.writes[0].next_action,
        "await_subscription_events"
    );
    assert_eq!(
        diagnostics.subscriptions[0].next_action,
        "ingest_provider_events"
    );
    assert!(!diagnostics.writes[0].raw_payload_retained);
    assert!(!diagnostics.subscriptions[0].raw_stream_retained);
    assert!(!json.contains("raw_provider_payload"));
    assert!(!json.contains("terminal_stream"));
}
