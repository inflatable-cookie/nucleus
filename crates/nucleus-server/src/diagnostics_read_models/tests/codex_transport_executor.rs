use crate::{
    codex_transport_executor_diagnostics, CodexAppServerDecodeOutcomePersistenceRecord,
    CodexAppServerStdioDecodeStatus, CodexAppServerStdioFrameDirection,
    CodexAppServerStdioFrameIngestionPersistenceRecord,
    CodexAppServerTransportExecutorAuthorityBlocker, CodexAppServerTransportExecutorAuthorityId,
    CodexAppServerTransportExecutorAuthorityRecord, CodexAppServerTransportExecutorAuthorityStatus,
    CodexAppServerTurnStartTransportExecutionPersistenceRecord,
    CodexAppServerTurnStartTransportExecutionReplayPolicy, ProviderSessionBindingId,
    ProviderSessionBindingRecord, ProviderSessionLifecycleState, ProviderSessionRepairState,
};
use nucleus_engine::{
    EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId,
    EngineRuntimeReceiptRef, EngineRuntimeReceiptStatus,
};
use nucleus_orchestration::OrchestrationEventId;

#[test]
fn codex_transport_executor_diagnostics_are_read_only_and_sanitized() {
    let diagnostics = codex_transport_executor_diagnostics(
        &[session()],
        &[authority()],
        &[],
        &[execution()],
        &[frame_ingestion()],
        &[decode_outcome()],
        &[receipt()],
    );

    assert_eq!(diagnostics.source_status, "records");
    assert_eq!(diagnostics.sessions.len(), 1);
    assert_eq!(diagnostics.authorities.len(), 1);
    assert_eq!(diagnostics.executions.len(), 1);
    assert_eq!(diagnostics.frames.len(), 1);
    assert_eq!(diagnostics.decode_outcomes.len(), 1);
    assert_eq!(diagnostics.transport_receipts.len(), 1);
    assert_eq!(diagnostics.session_count, 1);
    assert_eq!(diagnostics.frame_count, 1);
    assert_eq!(diagnostics.decode_outcome_count, 1);
    assert_eq!(diagnostics.receipt_count, 1);
    assert_eq!(diagnostics.repair_required_count, 2);
    assert!(diagnostics.sessions[0].repair_required);
    assert_eq!(
        diagnostics.sessions[0].next_action,
        "repair_provider_session_binding"
    );
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
    assert_eq!(
        diagnostics.decode_outcomes[0].decoded_method,
        Some("turn/completed".to_owned())
    );
    assert!(diagnostics.decode_outcomes[0].supported);
    assert_eq!(
        diagnostics.transport_receipts[0].next_action,
        "inspect_recovery_requirement"
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
    assert!(!diagnostics.sessions[0].provider_write_permitted);
    assert!(!diagnostics.decode_outcomes[0].provider_io_executed);
    assert!(!diagnostics.transport_receipts[0].client_can_replay_effect);
    assert!(!diagnostics.frames[0].task_mutation_permitted);

    let json = serde_json::to_string(&diagnostics).expect("json");
    for forbidden in [
        "raw_stdio_stream",
        "\"jsonrpc\":\"2.0\"",
        "credential-value",
        "secret-value",
    ] {
        assert!(
            !json.contains(forbidden),
            "transport diagnostics leaked {forbidden}"
        );
    }
}

#[test]
fn transport_receipt_read_model_exposes_persisted_refs_without_authority() {
    let diagnostics = codex_transport_executor_diagnostics(
        &[session()],
        &[],
        &[],
        &[],
        &[frame_ingestion()],
        &[decode_outcome()],
        &[receipt()],
    );

    assert_eq!(
        diagnostics.frames[0].evidence_refs,
        vec!["evidence:frame".to_owned()]
    );
    assert_eq!(
        diagnostics.decode_outcomes[0].observation_event_ref,
        Some("event:frame:1".to_owned())
    );
    assert_eq!(
        diagnostics.transport_receipts[0].evidence_refs,
        vec!["Custom(\"evidence:frame\")".to_owned()]
    );
    assert!(diagnostics.transport_receipts[0].recovery_required);
    assert!(!diagnostics.transport_receipts[0].provider_material_exposed);
    assert!(!diagnostics.sessions[0].raw_provider_material_retained);
    assert!(!diagnostics.decode_outcomes[0].raw_json_rpc_payload_retained);
}

fn session() -> ProviderSessionBindingRecord {
    ProviderSessionBindingRecord {
        binding_id: ProviderSessionBindingId("provider-session-binding:1".to_owned()),
        provider_instance_id: "codex:local-default".to_owned(),
        provider_service_id: "provider-service:codex".to_owned(),
        runtime_session_ref: "runtime-session:codex:1".to_owned(),
        provider_session_ref: Some("provider-session:codex:1".to_owned()),
        provider_thread_ref: Some("provider-thread:codex:1".to_owned()),
        lifecycle_state: ProviderSessionLifecycleState::Recovering,
        evidence_refs: vec!["evidence:session".to_owned()],
        repair_state: ProviderSessionRepairState::NeedsRuntimeRecovery {
            evidence_ref: "evidence:recovery".to_owned(),
        },
        provider_write_permitted: false,
        raw_provider_material_retained: false,
        secret_material_retained: false,
        live_handle_retained: false,
        task_mutation_permitted: false,
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
        session_refs: vec!["codex-runtime:1".to_owned()],
        sequence: 1,
        direction: CodexAppServerStdioFrameDirection::ProviderStdout,
        decode_status: CodexAppServerStdioDecodeStatus::Decoded {
            method: "turn/completed".to_owned(),
        },
        decode_receipt_ref: "receipt:frame:1".to_owned(),
        frame_size_bytes: None,
        payload_line_count: None,
        receipt_id: EngineRuntimeReceiptRecordId("receipt:frame:1".to_owned()),
        observation_event_id: Some(OrchestrationEventId("event:frame:1".to_owned())),
        evidence_refs: vec!["evidence:frame".to_owned()],
        raw_stream_retained: false,
        raw_payload_retained: false,
        task_mutation_permitted: false,
    }
}

fn decode_outcome() -> CodexAppServerDecodeOutcomePersistenceRecord {
    CodexAppServerDecodeOutcomePersistenceRecord {
        outcome_id: "codex-stdio-decode-outcome:1".to_owned(),
        frame_source_id: "codex-frame-source:1".to_owned(),
        runtime_instance_id: "codex-runtime:1".to_owned(),
        sequence: 1,
        decode_status: CodexAppServerStdioDecodeStatus::Decoded {
            method: "turn/completed".to_owned(),
        },
        decoded_method: Some("turn/completed".to_owned()),
        supported: true,
        parse_failure: None,
        unsupported_reason: None,
        observation_event_ref: Some("event:frame:1".to_owned()),
        evidence_refs: vec!["evidence:frame".to_owned()],
        shape_summary: "decoded method: turn/completed".to_owned(),
        raw_json_rpc_payload_retained: false,
        raw_provider_payload_retained: false,
        provider_io_executed: false,
        task_mutation_permitted: false,
    }
}

fn receipt() -> EngineRuntimeReceiptRecord {
    EngineRuntimeReceiptRecord {
        receipt_id: EngineRuntimeReceiptRecordId("receipt:frame:1".to_owned()),
        family: EngineRuntimeReceiptEffectFamily::HarnessProvider,
        status: EngineRuntimeReceiptStatus::RecoveryRequired,
        command_ref: None,
        effect_ref: Some(EngineRuntimeReceiptRef::Custom(
            "codex-runtime:1".to_owned(),
        )),
        evidence_refs: vec![EngineRuntimeReceiptRef::Custom("evidence:frame".to_owned())],
        artifact_refs: Vec::new(),
        summary: Some("requires recovery".to_owned()),
    }
}
