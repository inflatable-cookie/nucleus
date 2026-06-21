use nucleus_local_store::{LocalStoreError, LocalStoreResult};

use super::super::stdio_frame_ingestion_persistence::CodexAppServerStdioFrameIngestionPersistenceRecord;

pub(super) fn validate_ingestion_for_decode_outcome(
    ingestion: &CodexAppServerStdioFrameIngestionPersistenceRecord,
) -> LocalStoreResult<()> {
    if ingestion.frame_source_id.trim().is_empty()
        || ingestion.runtime_instance_id.trim().is_empty()
        || ingestion.evidence_refs.is_empty()
    {
        return invalid("decode outcome requires frame source, runtime, and evidence refs");
    }
    if ingestion.raw_stream_retained
        || ingestion.raw_payload_retained
        || ingestion.task_mutation_permitted
    {
        return invalid("decode outcome cannot derive from raw or task-mutating ingestion");
    }

    Ok(())
}

pub(super) fn invalid<T>(reason: impl Into<String>) -> LocalStoreResult<T> {
    Err(LocalStoreError::InvalidRecord {
        reason: reason.into(),
    })
}

pub(super) fn json_error(error: impl ToString) -> LocalStoreError {
    LocalStoreError::InvalidRecord {
        reason: error.to_string(),
    }
}
