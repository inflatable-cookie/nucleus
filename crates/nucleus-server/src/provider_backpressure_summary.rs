//! Provider backpressure summary records.
//!
//! These records summarize high-volume provider streams with bounded metadata.
//! They do not retain raw stream material or grant task/client mutation
//! authority.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use serde::{Deserialize, Serialize};

use crate::state::ServerStateService;

const PROVIDER_BACKPRESSURE_SUMMARY_PREFIX: &str = "provider-backpressure-summary:";
const MAX_SUMMARY_EVIDENCE_REFS: usize = 8;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderBackpressureSummaryInput {
    pub stream_ref: String,
    pub provider_instance_id: String,
    pub frame_count: u64,
    pub byte_count: u64,
    pub dropped_frame_ranges: Vec<String>,
    pub compacted_frame_ranges: Vec<String>,
    pub lag_millis: u64,
    pub pressure_state: ProviderBackpressureState,
    pub retained_artifact_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub raw_stream_retention_requested: bool,
    pub task_mutation_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderBackpressureState {
    Normal,
    Elevated,
    Saturated,
    Dropping,
    RepairRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderBackpressureSummaryRecord {
    pub summary_id: String,
    pub stream_ref: String,
    pub provider_instance_id: String,
    pub frame_count: u64,
    pub byte_count: u64,
    pub dropped_frame_ranges: Vec<String>,
    pub compacted_frame_ranges: Vec<String>,
    pub lag_millis: u64,
    pub pressure_state: ProviderBackpressureState,
    pub retained_artifact_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub diagnostics_state: String,
    pub summary_bounded: bool,
    pub raw_stream_retained: bool,
    pub task_mutation_permitted: bool,
}

pub fn persist_provider_backpressure_summary<B>(
    state: &ServerStateService<B>,
    input: ProviderBackpressureSummaryInput,
) -> LocalStoreResult<ProviderBackpressureSummaryRecord>
where
    B: LocalStoreBackend,
{
    validate_input(&input)?;
    let record = summary_record_from_input(input);

    state.artifact_metadata().put(
        LocalStoreRecord {
            id: PersistenceRecordId(record.summary_id.clone()),
            domain: PersistenceDomain::ArtifactMetadata,
            kind: PersistenceRecordKind::ArtifactMetadata,
            revision_id: RevisionId(format!("rev:{}", record.summary_id)),
            payload: json_payload(serde_json::to_vec(&record).map_err(json_error)?),
        },
        RevisionExpectation::MustNotExist,
    )?;

    Ok(record)
}

pub fn read_provider_backpressure_summary_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<ProviderBackpressureSummaryRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| {
            record
                .id
                .0
                .starts_with(PROVIDER_BACKPRESSURE_SUMMARY_PREFIX)
        })
        .map(|record| {
            serde_json::from_slice::<ProviderBackpressureSummaryRecord>(&record.payload.bytes)
                .map_err(json_error)
        })
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| left.summary_id.cmp(&right.summary_id));
    Ok(records)
}

fn validate_input(input: &ProviderBackpressureSummaryInput) -> LocalStoreResult<()> {
    if input.stream_ref.trim().is_empty()
        || input.provider_instance_id.trim().is_empty()
        || input.evidence_refs.is_empty()
    {
        return invalid(
            "provider backpressure summary requires stream, provider, and evidence refs",
        );
    }
    if input
        .evidence_refs
        .iter()
        .chain(input.retained_artifact_refs.iter())
        .chain(input.dropped_frame_ranges.iter())
        .chain(input.compacted_frame_ranges.iter())
        .any(|value| value.trim().is_empty())
    {
        return invalid("provider backpressure summary refs cannot be empty");
    }
    if input.raw_stream_retention_requested || input.task_mutation_requested {
        return invalid(
            "provider backpressure summary cannot request raw stream retention or task mutation",
        );
    }

    Ok(())
}

fn summary_record_from_input(
    input: ProviderBackpressureSummaryInput,
) -> ProviderBackpressureSummaryRecord {
    let evidence_refs = bounded_refs(unique_sorted(input.evidence_refs));
    let diagnostics_state = diagnostics_state(&input.pressure_state);

    ProviderBackpressureSummaryRecord {
        summary_id: format!(
            "{}{}:{}",
            PROVIDER_BACKPRESSURE_SUMMARY_PREFIX, input.provider_instance_id, input.stream_ref
        ),
        stream_ref: input.stream_ref,
        provider_instance_id: input.provider_instance_id,
        frame_count: input.frame_count,
        byte_count: input.byte_count,
        dropped_frame_ranges: input.dropped_frame_ranges,
        compacted_frame_ranges: input.compacted_frame_ranges,
        lag_millis: input.lag_millis,
        pressure_state: input.pressure_state,
        retained_artifact_refs: unique_sorted(input.retained_artifact_refs),
        evidence_refs,
        diagnostics_state,
        summary_bounded: true,
        raw_stream_retained: false,
        task_mutation_permitted: false,
    }
}

fn diagnostics_state(state: &ProviderBackpressureState) -> String {
    match state {
        ProviderBackpressureState::Normal => "healthy".to_owned(),
        ProviderBackpressureState::Elevated => "watch".to_owned(),
        ProviderBackpressureState::Saturated | ProviderBackpressureState::Dropping => {
            "degraded".to_owned()
        }
        ProviderBackpressureState::RepairRequired => "repair_required".to_owned(),
    }
}

fn bounded_refs(mut refs: Vec<String>) -> Vec<String> {
    refs.truncate(MAX_SUMMARY_EVIDENCE_REFS);
    refs
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

fn json_payload(bytes: Vec<u8>) -> LocalStoreRecordPayload {
    LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes,
    }
}

fn invalid<T>(reason: impl Into<String>) -> LocalStoreResult<T> {
    Err(LocalStoreError::InvalidRecord {
        reason: reason.into(),
    })
}

fn json_error(error: impl ToString) -> LocalStoreError {
    LocalStoreError::InvalidRecord {
        reason: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ServerStateService;
    use nucleus_local_store::SqliteBackend;

    #[test]
    fn provider_backpressure_summary_survives_reopen_and_feeds_diagnostics() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let db = temp_dir.path().join("nucleus.sqlite");
        let state = ServerStateService::new(SqliteBackend::new(db.clone()));
        let persisted = persist_provider_backpressure_summary(&state, input()).expect("persist");

        let reopened = ServerStateService::new(SqliteBackend::new(db));
        let records = read_provider_backpressure_summary_records(&reopened).expect("read");

        assert_eq!(records, vec![persisted]);
        assert_eq!(records[0].diagnostics_state, "degraded");
        assert!(!records[0].raw_stream_retained);
    }

    #[test]
    fn provider_backpressure_summary_bounds_high_volume_refs() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let mut input = input();
        input.evidence_refs = (0..20).map(|index| format!("evidence:{index}")).collect();

        let record = persist_provider_backpressure_summary(&state, input).expect("persist");

        assert_eq!(record.evidence_refs.len(), MAX_SUMMARY_EVIDENCE_REFS);
        assert!(record.summary_bounded);
    }

    #[test]
    fn provider_backpressure_summary_rejects_raw_stream_retention() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let mut input = input();
        input.raw_stream_retention_requested = true;

        let error = persist_provider_backpressure_summary(&state, input).expect_err("blocked");

        assert!(matches!(error, LocalStoreError::InvalidRecord { .. }));
        assert!(read_provider_backpressure_summary_records(&state)
            .expect("read")
            .is_empty());
    }

    fn input() -> ProviderBackpressureSummaryInput {
        ProviderBackpressureSummaryInput {
            stream_ref: "stream:codex:1".to_owned(),
            provider_instance_id: "codex:local-default".to_owned(),
            frame_count: 50_000,
            byte_count: 2_000_000,
            dropped_frame_ranges: vec!["1000..1200".to_owned()],
            compacted_frame_ranges: vec!["0..999".to_owned()],
            lag_millis: 1_500,
            pressure_state: ProviderBackpressureState::Saturated,
            retained_artifact_refs: vec!["artifact:summary:1".to_owned()],
            evidence_refs: vec!["evidence:backpressure:1".to_owned()],
            raw_stream_retention_requested: false,
            task_mutation_requested: false,
        }
    }
}
