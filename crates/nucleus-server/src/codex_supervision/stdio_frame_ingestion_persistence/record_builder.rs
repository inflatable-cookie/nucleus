use nucleus_engine::EngineRuntimeReceiptRecordId;
use nucleus_orchestration::OrchestrationEventStoreRecord;

use super::super::stdio_frames::CodexAppServerStdioFrameSourceRecord;
use super::types::CodexAppServerStdioFrameIngestionPersistenceRecord;
use super::INGESTION_RECORD_PREFIX;

pub(super) fn persistence_record_from_parts(
    frame: &CodexAppServerStdioFrameSourceRecord,
    receipt_id: &EngineRuntimeReceiptRecordId,
    event: &Option<OrchestrationEventStoreRecord>,
) -> CodexAppServerStdioFrameIngestionPersistenceRecord {
    CodexAppServerStdioFrameIngestionPersistenceRecord {
        ingestion_id: ingestion_id(frame),
        frame_source_id: frame.frame_source_id.0.clone(),
        runtime_instance_id: frame.runtime_instance_id.clone(),
        session_refs: vec![frame.runtime_instance_id.clone()],
        sequence: frame.sequence,
        direction: frame.direction.clone(),
        decode_status: frame.decode_status.clone(),
        decode_receipt_ref: receipt_id.0.clone(),
        frame_size_bytes: None,
        payload_line_count: None,
        receipt_id: receipt_id.clone(),
        observation_event_id: event.as_ref().map(|event| event.event_id.clone()),
        evidence_refs: vec![frame.evidence_ref.clone()],
        raw_stream_retained: false,
        raw_payload_retained: false,
        task_mutation_permitted: false,
    }
}

fn ingestion_id(frame: &CodexAppServerStdioFrameSourceRecord) -> String {
    format!("{}{}", INGESTION_RECORD_PREFIX, frame.frame_source_id.0)
}
