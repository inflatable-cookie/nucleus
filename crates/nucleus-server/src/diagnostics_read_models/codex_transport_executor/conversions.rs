use nucleus_engine::{EngineRuntimeReceiptRecord, EngineRuntimeReceiptStatus};

use super::helpers::{
    authority_next_action, authority_status, decode_outcome_next_action, envelope_next_action,
    envelope_status, receipt_next_action, session_repair_required,
};
use super::types::{
    CodexDecodeOutcomeDiagnosticDto, CodexStdioFrameIngestionDiagnosticDto,
    CodexTransportExecutionDiagnosticDto, CodexTransportExecutorAuthorityDiagnosticDto,
    CodexTransportExecutorEnvelopeDiagnosticDto, CodexTransportReceiptDiagnosticDto,
    CodexTransportSessionDiagnosticDto,
};
use crate::{
    CodexAppServerDecodeOutcomePersistenceRecord,
    CodexAppServerStdioFrameIngestionPersistenceRecord,
    CodexAppServerTransportExecutorAuthorityRecord,
    CodexAppServerTurnStartStdioExecutionEnvelopeRecord,
    CodexAppServerTurnStartTransportExecutionPersistenceRecord, ProviderSessionBindingRecord,
};

impl From<&ProviderSessionBindingRecord> for CodexTransportSessionDiagnosticDto {
    fn from(record: &ProviderSessionBindingRecord) -> Self {
        let repair_required = session_repair_required(&record.repair_state);
        Self {
            binding_id: record.binding_id.0.clone(),
            provider_instance_id: record.provider_instance_id.clone(),
            provider_service_id: record.provider_service_id.clone(),
            runtime_session_ref: record.runtime_session_ref.clone(),
            provider_session_ref: record.provider_session_ref.clone(),
            provider_thread_ref: record.provider_thread_ref.clone(),
            lifecycle_state: format!("{:?}", record.lifecycle_state),
            evidence_refs: record.evidence_refs.clone(),
            repair_state: format!("{:?}", record.repair_state),
            repair_required,
            provider_write_permitted: record.provider_write_permitted,
            raw_provider_material_retained: record.raw_provider_material_retained,
            task_mutation_permitted: record.task_mutation_permitted,
            next_action: if repair_required {
                "repair_provider_session_binding"
            } else {
                "inspect_session_frame_receipts"
            }
            .to_owned(),
        }
    }
}

impl From<&CodexAppServerTransportExecutorAuthorityRecord>
    for CodexTransportExecutorAuthorityDiagnosticDto
{
    fn from(record: &CodexAppServerTransportExecutorAuthorityRecord) -> Self {
        Self {
            authority_id: record.authority_id.0.clone(),
            provider_instance_id: record.provider_instance_id.clone(),
            preflight_id: record.preflight_id.clone(),
            write_attempt_id: record.write_attempt_id.clone(),
            status: authority_status(&record.status),
            blockers: record
                .blockers
                .iter()
                .map(|blocker| format!("{blocker:?}"))
                .collect(),
            evidence_refs: record.evidence_refs.clone(),
            task_mutation_permitted: record.task_mutation_permitted,
            next_action: authority_next_action(&record.status),
        }
    }
}

impl From<&CodexAppServerTurnStartStdioExecutionEnvelopeRecord>
    for CodexTransportExecutorEnvelopeDiagnosticDto
{
    fn from(record: &CodexAppServerTurnStartStdioExecutionEnvelopeRecord) -> Self {
        Self {
            envelope_id: record.envelope_id.0.clone(),
            request_id: record.request_id.clone(),
            send_command_id: record.send_command_id.clone(),
            write_attempt_id: record.write_attempt_id.clone(),
            status: envelope_status(&record.status),
            blockers: record
                .blockers
                .iter()
                .map(|blocker| format!("{blocker:?}"))
                .collect(),
            receipt_id: record.receipt_id.clone(),
            event_id: record.event_id.0.clone(),
            evidence_refs: record.evidence_refs.clone(),
            raw_payload_retained: record.raw_payload_retained,
            raw_stream_retained: record.raw_stream_retained,
            task_mutation_permitted: record.task_mutation_permitted,
            next_action: envelope_next_action(&record.status),
        }
    }
}

impl From<&CodexAppServerTurnStartTransportExecutionPersistenceRecord>
    for CodexTransportExecutionDiagnosticDto
{
    fn from(record: &CodexAppServerTurnStartTransportExecutionPersistenceRecord) -> Self {
        Self {
            execution_id: record.execution_id.clone(),
            write_attempt_id: record.write_attempt_id.clone(),
            idempotency_key: record.idempotency_key.clone(),
            receipt_id: record.receipt_id.0.clone(),
            event_id: record.event_id.as_ref().map(|event_id| event_id.0.clone()),
            replay_policy: "inspect_only".to_owned(),
            provider_write_executed: record.provider_write_executed,
            raw_payload_persisted: record.raw_payload_persisted,
            raw_stream_persisted: record.raw_stream_persisted,
            task_mutation_permitted: record.task_mutation_permitted,
            next_action: "inspect_receipt_and_frame_evidence".to_owned(),
        }
    }
}

impl From<&CodexAppServerStdioFrameIngestionPersistenceRecord>
    for CodexStdioFrameIngestionDiagnosticDto
{
    fn from(record: &CodexAppServerStdioFrameIngestionPersistenceRecord) -> Self {
        Self {
            ingestion_id: record.ingestion_id.clone(),
            frame_source_id: record.frame_source_id.clone(),
            runtime_instance_id: record.runtime_instance_id.clone(),
            sequence: record.sequence,
            decode_status: format!("{:?}", record.decode_status),
            receipt_id: record.receipt_id.0.clone(),
            observation_event_id: record
                .observation_event_id
                .as_ref()
                .map(|event_id| event_id.0.clone()),
            evidence_refs: record.evidence_refs.clone(),
            raw_payload_retained: record.raw_payload_retained,
            raw_stream_retained: record.raw_stream_retained,
            task_mutation_permitted: record.task_mutation_permitted,
            next_action: if record.observation_event_id.is_some() {
                "inspect_observation_event"
            } else {
                "inspect_decode_receipt"
            }
            .to_owned(),
        }
    }
}

impl From<&CodexAppServerDecodeOutcomePersistenceRecord> for CodexDecodeOutcomeDiagnosticDto {
    fn from(record: &CodexAppServerDecodeOutcomePersistenceRecord) -> Self {
        Self {
            outcome_id: record.outcome_id.clone(),
            frame_source_id: record.frame_source_id.clone(),
            runtime_instance_id: record.runtime_instance_id.clone(),
            sequence: record.sequence,
            decode_status: format!("{:?}", record.decode_status),
            decoded_method: record.decoded_method.clone(),
            supported: record.supported,
            parse_failure: record.parse_failure.clone(),
            unsupported_reason: record.unsupported_reason.clone(),
            observation_event_ref: record.observation_event_ref.clone(),
            evidence_refs: record.evidence_refs.clone(),
            shape_summary: record.shape_summary.clone(),
            raw_json_rpc_payload_retained: record.raw_json_rpc_payload_retained,
            raw_provider_payload_retained: record.raw_provider_payload_retained,
            provider_io_executed: record.provider_io_executed,
            task_mutation_permitted: record.task_mutation_permitted,
            next_action: decode_outcome_next_action(record),
        }
    }
}

impl From<&EngineRuntimeReceiptRecord> for CodexTransportReceiptDiagnosticDto {
    fn from(record: &EngineRuntimeReceiptRecord) -> Self {
        Self {
            receipt_id: record.receipt_id.0.clone(),
            status: format!("{:?}", record.status),
            family: format!("{:?}", record.family),
            command_ref: record
                .command_ref
                .as_ref()
                .map(|value| format!("{value:?}")),
            effect_ref: record.effect_ref.as_ref().map(|value| format!("{value:?}")),
            evidence_refs: record
                .evidence_refs
                .iter()
                .map(|value| format!("{value:?}"))
                .collect(),
            artifact_refs: record
                .artifact_refs
                .iter()
                .map(|value| format!("{value:?}"))
                .collect(),
            summary: record.summary.clone(),
            recovery_required: record.status == EngineRuntimeReceiptStatus::RecoveryRequired,
            provider_material_exposed: false,
            client_can_replay_effect: false,
            next_action: receipt_next_action(&record.status),
        }
    }
}
