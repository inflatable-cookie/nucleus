use nucleus_local_store::{LocalStoreError, LocalStoreRecordPayload};

pub(super) fn json_payload(bytes: Vec<u8>) -> LocalStoreRecordPayload {
    LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes,
    }
}

pub(super) fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

pub(super) fn invalid<T>(reason: impl Into<String>) -> Result<T, LocalStoreError> {
    Err(LocalStoreError::InvalidRecord {
        reason: reason.into(),
    })
}

pub(super) fn json_error(error: impl ToString) -> LocalStoreError {
    LocalStoreError::InvalidRecord {
        reason: error.to_string(),
    }
}
