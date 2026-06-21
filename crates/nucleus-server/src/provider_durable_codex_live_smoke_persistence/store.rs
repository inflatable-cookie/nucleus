use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreRecord, LocalStoreResult, RevisionExpectation,
};

use crate::codex_supervision::{
    codex_live_executor_outcome_record, persist_codex_live_executor_outcome,
    CodexAppServerLiveExecutorOutcomePersistenceInput,
};
use crate::provider_retention_policy::{provider_retention_policy, ProviderRetentionPolicyStatus};
use crate::state::ServerStateService;

use super::helpers::{json_error, json_payload};
use super::record_builder::{evidence_record, live_outcome_input, retention_input};
use super::types::{
    DurableCodexLiveSmokeEvidencePersistenceInput, DurableCodexLiveSmokeEvidenceRecord,
    DurableCodexLiveSmokeOutcomeSummary,
};
use super::validation::validate_input;
use super::DURABLE_CODEX_LIVE_SMOKE_EVIDENCE_PREFIX;

/// Persist durable live-smoke evidence and read-only outcome refs.
pub fn persist_durable_codex_live_smoke_evidence<B>(
    state: &ServerStateService<B>,
    input: DurableCodexLiveSmokeEvidencePersistenceInput,
) -> LocalStoreResult<DurableCodexLiveSmokeEvidenceRecord>
where
    B: LocalStoreBackend,
{
    validate_input(&input)?;

    let duplicate_write = input
        .existing_write_attempt_ids
        .contains(&input.run.boundary.write_attempt_id);
    if duplicate_write {
        return Ok(evidence_record(
            input,
            None,
            None,
            true,
            ProviderRetentionPolicyStatus::Blocked,
        ));
    }

    let retention = provider_retention_policy(retention_input(&input));
    if retention.status != ProviderRetentionPolicyStatus::AcceptedReferenceOnly {
        return Ok(evidence_record(input, None, None, false, retention.status));
    }

    let outcome_input = input
        .live_outcome
        .clone()
        .unwrap_or_else(|| live_outcome_input(&input.run));
    let outcome = codex_live_executor_outcome_record(outcome_input);
    let outcome_summary = DurableCodexLiveSmokeOutcomeSummary::from(&outcome);
    let live_persistence = persist_codex_live_executor_outcome(
        state,
        CodexAppServerLiveExecutorOutcomePersistenceInput { outcome },
    )?;
    let record = evidence_record(
        input,
        Some(live_persistence),
        Some(outcome_summary),
        false,
        retention.status,
    );

    state.artifact_metadata().put(
        LocalStoreRecord {
            id: PersistenceRecordId(record.evidence_id.clone()),
            domain: PersistenceDomain::ArtifactMetadata,
            kind: PersistenceRecordKind::ArtifactMetadata,
            revision_id: RevisionId(format!("rev:{}", record.evidence_id)),
            payload: json_payload(serde_json::to_vec(&record).map_err(json_error)?),
        },
        RevisionExpectation::MustNotExist,
    )?;

    Ok(record)
}

/// Read durable live-smoke evidence records.
pub fn read_durable_codex_live_smoke_evidence_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<DurableCodexLiveSmokeEvidenceRecord>>
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
                .starts_with(DURABLE_CODEX_LIVE_SMOKE_EVIDENCE_PREFIX)
        })
        .map(|record| {
            serde_json::from_slice::<DurableCodexLiveSmokeEvidenceRecord>(&record.payload.bytes)
                .map_err(json_error)
        })
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| left.evidence_id.cmp(&right.evidence_id));
    Ok(records)
}
