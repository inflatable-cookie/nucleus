use nucleus_engine::EngineRuntimeReceiptRecordId;
use nucleus_orchestration::OrchestrationEventId;
use nucleus_server::{
    CodexAppServerTransportExecutorAuthorityId, CodexAppServerTransportExecutorAuthorityRecord,
    CodexAppServerTransportExecutorAuthorityStatus,
    CodexAppServerTurnStartStdioExecutionEnvelopeId,
    CodexAppServerTurnStartStdioExecutionEnvelopeRecord,
    CodexAppServerTurnStartStdioExecutionEnvelopeStatus, CodexAppServerTurnStartStdioPayloadRef,
    CodexAppServerTurnStartTransportExecutionPersistenceRecord,
    CodexAppServerTurnStartTransportExecutionReplayPolicy, EngineHostId, ProviderServiceId,
    ProviderTransportWriteTarget,
};

pub(super) fn authority() -> CodexAppServerTransportExecutorAuthorityRecord {
    CodexAppServerTransportExecutorAuthorityRecord {
        authority_id: CodexAppServerTransportExecutorAuthorityId("authority:nucleusd".to_owned()),
        execution_host_id: EngineHostId("host:local".to_owned()),
        provider_instance_id: "codex:local-default".to_owned(),
        service_id: Some(ProviderServiceId("provider-service:codex".to_owned())),
        preflight_id: "preflight:nucleusd".to_owned(),
        write_attempt_id: "write-attempt:nucleusd".to_owned(),
        status: CodexAppServerTransportExecutorAuthorityStatus::ReadyForExecutionHandoff,
        blockers: Vec::new(),
        evidence_refs: vec!["evidence:nucleusd-authority".to_owned()],
        provider_write_executed: false,
        raw_payload_retained: false,
        raw_stream_retained: false,
        task_mutation_permitted: false,
    }
}

pub(super) fn envelope() -> CodexAppServerTurnStartStdioExecutionEnvelopeRecord {
    CodexAppServerTurnStartStdioExecutionEnvelopeRecord {
        envelope_id: CodexAppServerTurnStartStdioExecutionEnvelopeId(
            "stdio-envelope:nucleusd".to_owned(),
        ),
        request_id: "turn-start-request:nucleusd".to_owned(),
        method: "turn/start".to_owned(),
        provider_instance_id: "codex:local-default".to_owned(),
        service_id: Some(ProviderServiceId("provider-service:codex".to_owned())),
        send_command_id: "send-command:nucleusd".to_owned(),
        preflight_id: "preflight:nucleusd".to_owned(),
        write_attempt_id: "write-attempt:nucleusd".to_owned(),
        receipt_id: "receipt:live-send:nucleusd".to_owned(),
        event_id: OrchestrationEventId("event:live-send:nucleusd".to_owned()),
        authority_id: "authority:nucleusd".to_owned(),
        idempotency_key: "codex-turn-start:nucleusd".to_owned(),
        payload_ref: CodexAppServerTurnStartStdioPayloadRef {
            payload_ref: "payload-ref:nucleusd".to_owned(),
            summary: "turn/start payload ref".to_owned(),
            raw_payload_retained: false,
        },
        target: ProviderTransportWriteTarget::Stdio {
            endpoint_label: "stdio://codex-app-server".to_owned(),
        },
        status: CodexAppServerTurnStartStdioExecutionEnvelopeStatus::ReadyForExecutorHandoff,
        blockers: Vec::new(),
        evidence_refs: vec!["evidence:nucleusd-envelope".to_owned()],
        provider_write_executed: false,
        raw_payload_retained: false,
        raw_stream_retained: false,
        callback_response_permitted: false,
        cancellation_permitted: false,
        task_mutation_permitted: false,
    }
}

pub(super) fn execution() -> CodexAppServerTurnStartTransportExecutionPersistenceRecord {
    CodexAppServerTurnStartTransportExecutionPersistenceRecord {
        execution_id: "execution:nucleusd".to_owned(),
        write_attempt_id: "write-attempt:nucleusd".to_owned(),
        idempotency_key: "codex-turn-start:nucleusd".to_owned(),
        receipt_id: EngineRuntimeReceiptRecordId("receipt:execution:nucleusd".to_owned()),
        event_id: Some(OrchestrationEventId("event:execution:nucleusd".to_owned())),
        replay_policy: CodexAppServerTurnStartTransportExecutionReplayPolicy::InspectOnly,
        provider_write_executed: false,
        raw_payload_persisted: false,
        raw_stream_persisted: false,
        task_mutation_permitted: false,
    }
}
