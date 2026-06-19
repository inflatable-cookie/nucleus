use crate::{
    codex_transport_executor_diagnostics, CodexAppServerStdioDecodeStatus,
    CodexAppServerStdioFrameDirection, CodexAppServerStdioFrameIngestionPersistenceRecord,
    CodexAppServerTransportExecutorAuthorityBlocker, CodexAppServerTransportExecutorAuthorityId,
    CodexAppServerTransportExecutorAuthorityRecord, CodexAppServerTransportExecutorAuthorityStatus,
    CodexAppServerTurnStartTransportExecutionPersistenceRecord,
    CodexAppServerTurnStartTransportExecutionReplayPolicy,
};
use nucleus_engine::EngineRuntimeReceiptRecordId;
use nucleus_orchestration::OrchestrationEventId;

#[test]
fn codex_transport_executor_diagnostics_are_read_only_and_sanitized() {
    let diagnostics = codex_transport_executor_diagnostics(
        &[authority()],
        &[],
        &[execution()],
        &[frame_ingestion()],
    );

    assert_eq!(diagnostics.source_status, "records");
    assert_eq!(diagnostics.authorities.len(), 1);
    assert_eq!(diagnostics.executions.len(), 1);
    assert_eq!(diagnostics.frames.len(), 1);
    assert_eq!(diagnostics.authorities[0].status, "blocked");
    assert!(diagnostics.authorities[0]
        .blockers
        .iter()
        .any(|blocker| blocker.contains("OperatorConfirmationMissing")));
    assert_eq!(
        diagnostics.executions[0].next_action,
        "inspect_receipt_and_frame_evidence"
    );
    assert_eq!(
        diagnostics.frames[0].decode_status,
        "Decoded { method: \"turn/completed\" }"
    );
    assert!(!diagnostics.client_can_execute_provider_write);
    assert!(!diagnostics.client_can_answer_callbacks);
    assert!(!diagnostics.client_can_cancel_provider);
    assert!(!diagnostics.client_can_mutate_tasks);
    assert!(!diagnostics.provider_material_exposed);
    assert!(!diagnostics.raw_streams_exposed);
    assert!(!diagnostics.authorities[0].task_mutation_permitted);
    assert!(!diagnostics.executions[0].provider_write_executed);
    assert!(!diagnostics.frames[0].raw_stream_retained);
    assert!(!diagnostics.frames[0].task_mutation_permitted);

    let json = serde_json::to_string(&diagnostics).expect("json");
    for forbidden in [
        "raw_provider_payload",
        "raw_stdio_stream",
        "credential",
        "secret",
    ] {
        assert!(
            !json.contains(forbidden),
            "transport diagnostics leaked {forbidden}"
        );
    }
}

fn authority() -> CodexAppServerTransportExecutorAuthorityRecord {
    CodexAppServerTransportExecutorAuthorityRecord {
        authority_id: CodexAppServerTransportExecutorAuthorityId("authority:1".to_owned()),
        execution_host_id: crate::EngineHostId("host:local".to_owned()),
        provider_instance_id: "codex:local-default".to_owned(),
        service_id: None,
        preflight_id: "preflight:1".to_owned(),
        write_attempt_id: "write-attempt:1".to_owned(),
        status: CodexAppServerTransportExecutorAuthorityStatus::Blocked,
        blockers: vec![
            CodexAppServerTransportExecutorAuthorityBlocker::OperatorConfirmationMissing,
        ],
        evidence_refs: vec!["evidence:authority".to_owned()],
        provider_write_executed: false,
        raw_payload_retained: false,
        raw_stream_retained: false,
        task_mutation_permitted: false,
    }
}

fn execution() -> CodexAppServerTurnStartTransportExecutionPersistenceRecord {
    CodexAppServerTurnStartTransportExecutionPersistenceRecord {
        execution_id: "transport-execution:1".to_owned(),
        write_attempt_id: "write-attempt:1".to_owned(),
        idempotency_key: "codex-turn-start:1".to_owned(),
        receipt_id: EngineRuntimeReceiptRecordId("receipt:execution:1".to_owned()),
        event_id: Some(OrchestrationEventId("event:execution:1".to_owned())),
        replay_policy: CodexAppServerTurnStartTransportExecutionReplayPolicy::InspectOnly,
        provider_write_executed: false,
        raw_payload_persisted: false,
        raw_stream_persisted: false,
        task_mutation_permitted: false,
    }
}

fn frame_ingestion() -> CodexAppServerStdioFrameIngestionPersistenceRecord {
    CodexAppServerStdioFrameIngestionPersistenceRecord {
        ingestion_id: "codex-stdio-frame-ingestion:1".to_owned(),
        frame_source_id: "codex-frame-source:1".to_owned(),
        runtime_instance_id: "codex-runtime:1".to_owned(),
        sequence: 1,
        direction: CodexAppServerStdioFrameDirection::ProviderStdout,
        decode_status: CodexAppServerStdioDecodeStatus::Decoded {
            method: "turn/completed".to_owned(),
        },
        receipt_id: EngineRuntimeReceiptRecordId("receipt:frame:1".to_owned()),
        observation_event_id: Some(OrchestrationEventId("event:frame:1".to_owned())),
        evidence_refs: vec!["evidence:frame".to_owned()],
        raw_stream_retained: false,
        raw_payload_retained: false,
        task_mutation_permitted: false,
    }
}
