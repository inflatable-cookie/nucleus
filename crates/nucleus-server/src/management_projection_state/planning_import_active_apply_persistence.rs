use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};

use crate::ServerStateService;

use super::planning_import_active_apply_admission::{
    admit_planning_projection_import_active_apply,
    PlanningProjectionImportActiveApplyAdmissionRecord,
    PlanningProjectionImportActiveApplyAdmissionRequest,
    PlanningProjectionImportActiveApplyAdmissionStatus,
};

const ACTIVE_APPLY_ADMISSION_PREFIX: &str = "planning-import-active-apply-admission:";

pub fn persist_planning_projection_import_active_apply_admission<B>(
    state: &ServerStateService<B>,
    request: PlanningProjectionImportActiveApplyAdmissionRequest,
) -> LocalStoreResult<PlanningProjectionImportActiveApplyAdmissionRecord>
where
    B: LocalStoreBackend,
{
    let record_id = active_apply_admission_record_id(&request.admission_id);
    if let Some(existing) = state
        .planning()
        .get(&PersistenceRecordId(record_id.clone()))?
    {
        let mut record = decode_active_apply_admission_record(&existing.payload.bytes)?;
        record.status = PlanningProjectionImportActiveApplyAdmissionStatus::DuplicateNoop;
        record.duplicate_admission_detected = true;
        record.apply_admitted = false;
        return Ok(record);
    }

    let mut record = admit_planning_projection_import_active_apply(request);
    record.admission_id = record_id;

    if record.status == PlanningProjectionImportActiveApplyAdmissionStatus::AdmittedStopped {
        write_active_apply_admission_record(state, &record)?;
    }

    Ok(record)
}

pub fn read_planning_projection_import_active_apply_admission_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<PlanningProjectionImportActiveApplyAdmissionRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .planning()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(ACTIVE_APPLY_ADMISSION_PREFIX))
        .map(|record| decode_active_apply_admission_record(&record.payload.bytes))
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| left.admission_id.cmp(&right.admission_id));
    Ok(records)
}

fn write_active_apply_admission_record<B>(
    state: &ServerStateService<B>,
    record: &PlanningProjectionImportActiveApplyAdmissionRecord,
) -> LocalStoreResult<LocalStoreRecord>
where
    B: LocalStoreBackend,
{
    state.planning().put(
        LocalStoreRecord {
            id: PersistenceRecordId(record.admission_id.clone()),
            domain: PersistenceDomain::Planning,
            kind: PersistenceRecordKind::PlanningImportActiveApplyAdmission,
            revision_id: RevisionId(format!("rev:{}", record.admission_id)),
            payload: LocalStoreRecordPayload {
                media_type: Some("application/json".to_owned()),
                bytes: serde_json::to_vec(record).map_err(json_error)?,
            },
        },
        RevisionExpectation::MustNotExist,
    )
}

fn decode_active_apply_admission_record(
    bytes: &[u8],
) -> LocalStoreResult<PlanningProjectionImportActiveApplyAdmissionRecord> {
    serde_json::from_slice(bytes).map_err(json_error)
}

fn active_apply_admission_record_id(admission_id: &str) -> String {
    let admission_id = admission_id.trim();
    if admission_id.starts_with(ACTIVE_APPLY_ADMISSION_PREFIX) {
        admission_id.to_owned()
    } else {
        format!("{ACTIVE_APPLY_ADMISSION_PREFIX}{admission_id}")
    }
}

fn json_error(error: impl ToString) -> LocalStoreError {
    LocalStoreError::InvalidRecord {
        reason: error.to_string(),
    }
}
