use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};

use crate::ServerStateService;

use super::{
    ProviderLiveReadApprovedSmokeEvidencePersistenceBlocker,
    ProviderLiveReadApprovedSmokeEvidencePersistenceInput,
    ProviderLiveReadApprovedSmokeEvidencePersistenceRecord,
    ProviderLiveReadApprovedSmokeEvidencePersistenceSet,
    ProviderLiveReadApprovedSmokeEvidencePersistenceStatus,
    ProviderLiveReadApprovedSmokeEvidenceRecord, ProviderLiveReadApprovedSmokeEvidenceStatus,
};

const APPROVED_SMOKE_EVIDENCE_PREFIX: &str =
    "provider-live-read-approved-smoke-evidence-persistence:";

pub fn persist_provider_live_read_approved_smoke_evidence_records<B>(
    state: &ServerStateService<B>,
    input: ProviderLiveReadApprovedSmokeEvidencePersistenceInput,
) -> LocalStoreResult<ProviderLiveReadApprovedSmokeEvidencePersistenceSet>
where
    B: LocalStoreBackend,
{
    let mut records = input
        .evidence_records
        .iter()
        .map(|evidence| persistence_record(&input, evidence))
        .collect::<Vec<_>>();
    records.sort_by(|left, right| left.persisted_evidence_id.cmp(&right.persisted_evidence_id));

    for record in records.iter().filter(|record| {
        record.persistence_status
            == ProviderLiveReadApprovedSmokeEvidencePersistenceStatus::Persisted
            && !record.duplicate_evidence_detected
    }) {
        write_persisted_evidence_record(state, record)?;
    }

    Ok(ProviderLiveReadApprovedSmokeEvidencePersistenceSet {
        persistence_set_id: "provider-live-read-approved-smoke-evidence-persistence".to_owned(),
        records,
        provider_write_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    })
}

pub fn read_provider_live_read_approved_smoke_evidence_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<ProviderLiveReadApprovedSmokeEvidencePersistenceRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(APPROVED_SMOKE_EVIDENCE_PREFIX))
        .map(|record| decode_persisted_evidence_record(&record.payload.bytes))
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| left.persisted_evidence_id.cmp(&right.persisted_evidence_id));
    Ok(records)
}

fn persistence_record(
    input: &ProviderLiveReadApprovedSmokeEvidencePersistenceInput,
    evidence: &ProviderLiveReadApprovedSmokeEvidenceRecord,
) -> ProviderLiveReadApprovedSmokeEvidencePersistenceRecord {
    let persisted_evidence_id = persisted_evidence_id(&evidence.evidence_id);
    let duplicate = input
        .existing_persisted_evidence_ids
        .contains(&persisted_evidence_id);
    let blockers = if duplicate {
        Vec::new()
    } else {
        persistence_blockers(input, evidence)
    };
    let persistence_status = if duplicate {
        ProviderLiveReadApprovedSmokeEvidencePersistenceStatus::DuplicateNoop
    } else if blockers.is_empty() {
        ProviderLiveReadApprovedSmokeEvidencePersistenceStatus::Persisted
    } else {
        ProviderLiveReadApprovedSmokeEvidencePersistenceStatus::Blocked
    };

    let mut evidence_refs = input.persistence_evidence_refs.clone();
    if let Some(evidence_ref) = evidence.evidence_ref.clone() {
        evidence_refs.push(evidence_ref);
    }
    evidence_refs.sort();
    evidence_refs.dedup();

    ProviderLiveReadApprovedSmokeEvidencePersistenceRecord {
        persisted_evidence_id,
        evidence_id: evidence.evidence_id.clone(),
        evidence_ref: evidence.evidence_ref.clone(),
        command_smoke_request_id: evidence.command_smoke_request_id.clone(),
        handoff_id: evidence.handoff_id.clone(),
        output_record_id: evidence.output_record_id.clone(),
        receipt_id: evidence.receipt_id.clone(),
        name_with_owner: evidence.name_with_owner.clone(),
        evidence_status: evidence.status.clone(),
        evidence_blockers: evidence.blockers.clone(),
        persistence_status,
        persistence_blockers: blockers,
        duplicate_evidence_detected: duplicate || evidence.duplicate_evidence_detected,
        evidence_refs,
        provider_network_call_performed: evidence.provider_network_call_performed,
        smoke_evidence_persisted: persistence_status
            == ProviderLiveReadApprovedSmokeEvidencePersistenceStatus::Persisted,
        provider_write_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

fn persistence_blockers(
    input: &ProviderLiveReadApprovedSmokeEvidencePersistenceInput,
    evidence: &ProviderLiveReadApprovedSmokeEvidenceRecord,
) -> Vec<ProviderLiveReadApprovedSmokeEvidencePersistenceBlocker> {
    let mut blockers = Vec::new();

    if evidence.status != ProviderLiveReadApprovedSmokeEvidenceStatus::Promoted {
        blockers.push(ProviderLiveReadApprovedSmokeEvidencePersistenceBlocker::EvidenceNotPromoted);
    }
    if input.persistence_evidence_refs.is_empty() {
        blockers.push(
            ProviderLiveReadApprovedSmokeEvidencePersistenceBlocker::MissingPersistenceEvidenceRef,
        );
    }
    if input.provider_write_executed || evidence.provider_write_executed {
        blockers
            .push(ProviderLiveReadApprovedSmokeEvidencePersistenceBlocker::ProviderWriteExecuted);
    }
    if input.callback_effect_executed || evidence.callback_effect_executed {
        blockers
            .push(ProviderLiveReadApprovedSmokeEvidencePersistenceBlocker::CallbackEffectExecuted);
    }
    if input.interruption_effect_executed || evidence.interruption_effect_executed {
        blockers.push(
            ProviderLiveReadApprovedSmokeEvidencePersistenceBlocker::InterruptionEffectExecuted,
        );
    }
    if input.recovery_effect_executed || evidence.recovery_effect_executed {
        blockers
            .push(ProviderLiveReadApprovedSmokeEvidencePersistenceBlocker::RecoveryEffectExecuted);
    }
    if input.task_mutation_executed || evidence.task_mutation_executed {
        blockers
            .push(ProviderLiveReadApprovedSmokeEvidencePersistenceBlocker::TaskMutationExecuted);
    }
    if input.raw_provider_payload_retained || evidence.raw_provider_payload_retained {
        blockers.push(
            ProviderLiveReadApprovedSmokeEvidencePersistenceBlocker::RawProviderPayloadRetained,
        );
    }

    blockers
}

fn write_persisted_evidence_record<B>(
    state: &ServerStateService<B>,
    record: &ProviderLiveReadApprovedSmokeEvidencePersistenceRecord,
) -> LocalStoreResult<LocalStoreRecord>
where
    B: LocalStoreBackend,
{
    state.artifact_metadata().put(
        LocalStoreRecord {
            id: PersistenceRecordId(record.persisted_evidence_id.clone()),
            domain: PersistenceDomain::ArtifactMetadata,
            kind: PersistenceRecordKind::ArtifactMetadata,
            revision_id: RevisionId(format!("rev:{}", record.persisted_evidence_id)),
            payload: json_payload(serde_json::to_vec(record).map_err(json_error)?),
        },
        RevisionExpectation::MustNotExist,
    )
}

fn decode_persisted_evidence_record(
    bytes: &[u8],
) -> LocalStoreResult<ProviderLiveReadApprovedSmokeEvidencePersistenceRecord> {
    serde_json::from_slice::<ProviderLiveReadApprovedSmokeEvidencePersistenceRecord>(bytes)
        .map_err(json_error)
}

fn persisted_evidence_id(evidence_id: &str) -> String {
    format!("{APPROVED_SMOKE_EVIDENCE_PREFIX}{evidence_id}")
}

fn json_payload(bytes: Vec<u8>) -> LocalStoreRecordPayload {
    LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes,
    }
}

fn json_error(error: impl ToString) -> LocalStoreError {
    LocalStoreError::InvalidRecord {
        reason: error.to_string(),
    }
}
