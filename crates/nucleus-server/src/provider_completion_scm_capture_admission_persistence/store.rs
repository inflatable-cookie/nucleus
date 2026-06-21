use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreRecord, LocalStoreResult, RevisionExpectation,
};

use super::helpers::{json_error, json_payload};
use super::record_builder::{blockers, persisted_admission_id, persistence_record};
use super::types::{
    CompletionScmCaptureAdmissionPersistenceInput, CompletionScmCaptureAdmissionPersistenceRecord,
    CompletionScmCaptureAdmissionPersistenceStatus,
};
use super::COMPLETION_SCM_CAPTURE_ADMISSION_PREFIX;
use crate::ServerStateService;

pub fn persist_completion_scm_capture_admission<B>(
    state: &ServerStateService<B>,
    input: CompletionScmCaptureAdmissionPersistenceInput,
) -> LocalStoreResult<CompletionScmCaptureAdmissionPersistenceRecord>
where
    B: LocalStoreBackend,
{
    let persisted_admission_id = persisted_admission_id(&input.admission.admission_id);
    if input
        .existing_admission_ids
        .contains(&persisted_admission_id)
    {
        return Ok(persistence_record(
            input,
            persisted_admission_id,
            CompletionScmCaptureAdmissionPersistenceStatus::DuplicateNoop,
            Vec::new(),
            true,
        ));
    }

    let blockers = blockers(&input);
    let status = if blockers.is_empty() {
        CompletionScmCaptureAdmissionPersistenceStatus::Persisted
    } else {
        CompletionScmCaptureAdmissionPersistenceStatus::Blocked
    };
    let record = persistence_record(input, persisted_admission_id, status, blockers, false);

    if record.status == CompletionScmCaptureAdmissionPersistenceStatus::Persisted {
        state.artifact_metadata().put(
            LocalStoreRecord {
                id: PersistenceRecordId(record.persisted_admission_id.clone()),
                domain: PersistenceDomain::ArtifactMetadata,
                kind: PersistenceRecordKind::ArtifactMetadata,
                revision_id: RevisionId(format!("rev:{}", record.persisted_admission_id)),
                payload: json_payload(serde_json::to_vec(&record).map_err(json_error)?),
            },
            RevisionExpectation::MustNotExist,
        )?;
    }

    Ok(record)
}

pub fn read_completion_scm_capture_admissions<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<CompletionScmCaptureAdmissionPersistenceRecord>>
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
                .starts_with(COMPLETION_SCM_CAPTURE_ADMISSION_PREFIX)
        })
        .map(|record| {
            serde_json::from_slice::<CompletionScmCaptureAdmissionPersistenceRecord>(
                &record.payload.bytes,
            )
            .map_err(json_error)
        })
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| {
        left.persisted_admission_id
            .cmp(&right.persisted_admission_id)
    });
    Ok(records)
}
