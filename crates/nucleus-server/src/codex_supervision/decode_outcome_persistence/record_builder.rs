use super::super::stdio_frame_ingestion_persistence::CodexAppServerStdioFrameIngestionPersistenceRecord;
use super::super::stdio_frames::CodexAppServerStdioDecodeStatus;
use super::types::CodexAppServerDecodeOutcomePersistenceRecord;
use super::DECODE_OUTCOME_PREFIX;

pub(super) fn decode_outcome_from_ingestion(
    ingestion: &CodexAppServerStdioFrameIngestionPersistenceRecord,
) -> CodexAppServerDecodeOutcomePersistenceRecord {
    let (decoded_method, supported, parse_failure, unsupported_reason, shape_summary) =
        match &ingestion.decode_status {
            CodexAppServerStdioDecodeStatus::Decoded { method } => (
                Some(method.clone()),
                true,
                None,
                None,
                format!("decoded method: {method}"),
            ),
            CodexAppServerStdioDecodeStatus::Malformed { reason } => (
                None,
                false,
                Some(reason.clone()),
                None,
                "malformed frame".to_owned(),
            ),
            CodexAppServerStdioDecodeStatus::Unsupported { method, reason } => (
                method.clone(),
                false,
                None,
                Some(reason.clone()),
                match method {
                    Some(method) => format!("unsupported method: {method}"),
                    None => "unsupported frame".to_owned(),
                },
            ),
            CodexAppServerStdioDecodeStatus::RecoveryRequired { reason } => (
                None,
                false,
                None,
                Some(reason.clone()),
                "recovery required".to_owned(),
            ),
        };

    CodexAppServerDecodeOutcomePersistenceRecord {
        outcome_id: format!("{}{}", DECODE_OUTCOME_PREFIX, ingestion.frame_source_id),
        frame_source_id: ingestion.frame_source_id.clone(),
        runtime_instance_id: ingestion.runtime_instance_id.clone(),
        sequence: ingestion.sequence,
        decode_status: ingestion.decode_status.clone(),
        decoded_method,
        supported,
        parse_failure,
        unsupported_reason,
        observation_event_ref: ingestion
            .observation_event_id
            .as_ref()
            .map(|event_id| event_id.0.clone()),
        evidence_refs: ingestion.evidence_refs.clone(),
        shape_summary,
        raw_json_rpc_payload_retained: false,
        raw_provider_payload_retained: false,
        provider_io_executed: false,
        task_mutation_permitted: false,
    }
}
