use nucleus_engine::EngineTaskAgentWorkUnitSourceRecord;
use nucleus_local_store::{LocalStoreError, LocalStoreResult};

const FORBIDDEN_SUMMARY_TERMS: [&str; 5] = [
    "raw stdout",
    "raw stderr",
    "terminal stream",
    "provider payload",
    "secret",
];

pub(super) fn validate_source_record(
    record: &EngineTaskAgentWorkUnitSourceRecord,
) -> LocalStoreResult<()> {
    if record.source_id.0.trim().is_empty() {
        return invalid_record("task-agent source id is empty");
    }
    if record.source_cursor.0.trim().is_empty() {
        return invalid_record("task-agent source cursor is empty");
    }
    if record.summary.trim().is_empty() {
        return invalid_record("task-agent source summary is empty");
    }
    let lower_summary = record.summary.to_ascii_lowercase();
    for term in FORBIDDEN_SUMMARY_TERMS {
        if lower_summary.contains(term) {
            return invalid_record(format!(
                "task-agent source summary contains forbidden term: {term}"
            ));
        }
    }
    Ok(())
}

fn invalid_record<T>(reason: impl Into<String>) -> LocalStoreResult<T> {
    Err(LocalStoreError::InvalidRecord {
        reason: reason.into(),
    })
}
