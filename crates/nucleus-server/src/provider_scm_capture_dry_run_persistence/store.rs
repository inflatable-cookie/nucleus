use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreRecord, LocalStoreResult, RevisionExpectation,
};

use super::{
    helpers::{json_error, json_payload},
    record_builder::{blockers, persisted_dry_run_plan_id, persistence_record},
    types::{
        ScmCaptureDryRunPersistenceInput, ScmCaptureDryRunPersistenceRecord,
        ScmCaptureDryRunPersistenceStatus,
    },
    SCM_CAPTURE_DRY_RUN_PREFIX,
};
use crate::ServerStateService;

pub fn persist_scm_capture_dry_run_plan<B>(
    state: &ServerStateService<B>,
    input: ScmCaptureDryRunPersistenceInput,
) -> LocalStoreResult<ScmCaptureDryRunPersistenceRecord>
where
    B: LocalStoreBackend,
{
    let persisted_dry_run_plan_id =
        persisted_dry_run_plan_id(&input.plan_item.dry_run_plan_item_id);
    if input
        .existing_dry_run_plan_ids
        .contains(&persisted_dry_run_plan_id)
    {
        return Ok(persistence_record(
            input,
            persisted_dry_run_plan_id,
            ScmCaptureDryRunPersistenceStatus::DuplicateNoop,
            Vec::new(),
            true,
        ));
    }

    let blockers = blockers(&input);
    let status = if blockers.is_empty() {
        ScmCaptureDryRunPersistenceStatus::Persisted
    } else {
        ScmCaptureDryRunPersistenceStatus::Blocked
    };
    let record = persistence_record(input, persisted_dry_run_plan_id, status, blockers, false);

    if record.status == ScmCaptureDryRunPersistenceStatus::Persisted {
        state.artifact_metadata().put(
            LocalStoreRecord {
                id: PersistenceRecordId(record.persisted_dry_run_plan_id.clone()),
                domain: PersistenceDomain::ArtifactMetadata,
                kind: PersistenceRecordKind::ArtifactMetadata,
                revision_id: RevisionId(format!("rev:{}", record.persisted_dry_run_plan_id)),
                payload: json_payload(serde_json::to_vec(&record).map_err(json_error)?),
            },
            RevisionExpectation::MustNotExist,
        )?;
    }

    Ok(record)
}

pub fn read_scm_capture_dry_run_plans<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<ScmCaptureDryRunPersistenceRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(SCM_CAPTURE_DRY_RUN_PREFIX))
        .map(|record| {
            serde_json::from_slice::<ScmCaptureDryRunPersistenceRecord>(&record.payload.bytes)
                .map_err(json_error)
        })
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| {
        left.persisted_dry_run_plan_id
            .cmp(&right.persisted_dry_run_plan_id)
    });
    Ok(records)
}
