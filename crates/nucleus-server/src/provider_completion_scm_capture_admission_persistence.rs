//! Persistence for completion SCM capture-admission records.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use serde::{Deserialize, Serialize};

use crate::{
    CompletionScmCaptureAdmissionBlocker, CompletionScmCaptureAdmissionRecord,
    CompletionScmCaptureAdmissionStatus, ServerStateService,
};

const COMPLETION_SCM_CAPTURE_ADMISSION_PREFIX: &str = "completion-scm-capture-admission:";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompletionScmCaptureAdmissionPersistenceInput {
    pub admission: CompletionScmCaptureAdmissionRecord,
    pub existing_admission_ids: Vec<String>,
    pub raw_material_present: bool,
    pub scm_capture_requested: bool,
    pub scm_publish_requested: bool,
    pub forge_change_request_requested: bool,
    pub forge_merge_requested: bool,
    pub provider_write_requested: bool,
    pub callback_response_requested: bool,
    pub interruption_requested: bool,
    pub recovery_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CompletionScmCaptureAdmissionPersistenceRecord {
    pub persisted_admission_id: String,
    pub admission_id: String,
    pub request_id: String,
    pub readiness_id: String,
    pub candidate_id: String,
    pub task_id: String,
    pub work_item_id: Option<String>,
    pub completion_id: Option<String>,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub admission_status: CompletionScmCaptureAdmissionStatus,
    pub status: CompletionScmCaptureAdmissionPersistenceStatus,
    pub blockers: Vec<CompletionScmCaptureAdmissionPersistenceBlocker>,
    pub admission_blockers: Vec<CompletionScmCaptureAdmissionBlocker>,
    pub duplicate_admission_detected: bool,
    pub scm_capture_permitted: bool,
    pub scm_publish_permitted: bool,
    pub forge_change_request_permitted: bool,
    pub forge_merge_permitted: bool,
    pub provider_write_permitted: bool,
    pub callback_response_permitted: bool,
    pub interruption_permitted: bool,
    pub recovery_permitted: bool,
    pub raw_material_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletionScmCaptureAdmissionPersistenceStatus {
    Persisted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletionScmCaptureAdmissionPersistenceBlocker {
    MissingEvidenceRef,
    RawMaterialPresent,
    ScmCaptureRequested,
    ScmPublishRequested,
    ForgeChangeRequestRequested,
    ForgeMergeRequested,
    ProviderWriteRequested,
    CallbackResponseRequested,
    InterruptionRequested,
    RecoveryRequested,
}

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

pub fn completion_scm_capture_diagnostics_from_persisted_admissions(
    records: Vec<CompletionScmCaptureAdmissionPersistenceRecord>,
) -> crate::CompletionScmCaptureAdmissionDiagnosticsRecord {
    let admissions = records.into_iter().map(admission_from_record).collect();
    crate::completion_scm_capture_admission_diagnostics(
        crate::CompletionScmCaptureAdmissionDiagnosticsInput { admissions },
    )
}

fn admission_from_record(
    record: CompletionScmCaptureAdmissionPersistenceRecord,
) -> CompletionScmCaptureAdmissionRecord {
    CompletionScmCaptureAdmissionRecord {
        admission_id: record.admission_id,
        request_id: record.request_id,
        readiness_id: record.readiness_id,
        candidate_id: record.candidate_id,
        task_id: record.task_id,
        work_item_id: record.work_item_id,
        completion_id: record.completion_id,
        operator_ref: record.operator_ref,
        evidence_refs: record.evidence_refs,
        status: record.admission_status.clone(),
        blockers: record.admission_blockers,
        capture_admitted: record.admission_status == CompletionScmCaptureAdmissionStatus::Admitted,
        scm_capture_executed: false,
        scm_publish_executed: false,
        forge_change_request_created: false,
        forge_merge_executed: false,
        provider_write_executed: false,
        callback_response_executed: false,
        interruption_executed: false,
        recovery_executed: false,
        raw_material_exposed: false,
    }
}

fn persistence_record(
    input: CompletionScmCaptureAdmissionPersistenceInput,
    persisted_admission_id: String,
    status: CompletionScmCaptureAdmissionPersistenceStatus,
    blockers: Vec<CompletionScmCaptureAdmissionPersistenceBlocker>,
    duplicate_admission_detected: bool,
) -> CompletionScmCaptureAdmissionPersistenceRecord {
    CompletionScmCaptureAdmissionPersistenceRecord {
        persisted_admission_id,
        admission_id: input.admission.admission_id,
        request_id: input.admission.request_id,
        readiness_id: input.admission.readiness_id,
        candidate_id: input.admission.candidate_id,
        task_id: input.admission.task_id,
        work_item_id: input.admission.work_item_id,
        completion_id: input.admission.completion_id,
        operator_ref: input.admission.operator_ref,
        evidence_refs: unique_sorted(input.admission.evidence_refs),
        admission_status: input.admission.status,
        status,
        blockers,
        admission_blockers: input.admission.blockers,
        duplicate_admission_detected,
        scm_capture_permitted: false,
        scm_publish_permitted: false,
        forge_change_request_permitted: false,
        forge_merge_permitted: false,
        provider_write_permitted: false,
        callback_response_permitted: false,
        interruption_permitted: false,
        recovery_permitted: false,
        raw_material_retained: false,
    }
}

fn blockers(
    input: &CompletionScmCaptureAdmissionPersistenceInput,
) -> Vec<CompletionScmCaptureAdmissionPersistenceBlocker> {
    let mut blockers = Vec::new();
    if input.admission.evidence_refs.is_empty() {
        blockers.push(CompletionScmCaptureAdmissionPersistenceBlocker::MissingEvidenceRef);
    }
    if input.raw_material_present {
        blockers.push(CompletionScmCaptureAdmissionPersistenceBlocker::RawMaterialPresent);
    }
    if input.scm_capture_requested || input.admission.scm_capture_executed {
        blockers.push(CompletionScmCaptureAdmissionPersistenceBlocker::ScmCaptureRequested);
    }
    if input.scm_publish_requested || input.admission.scm_publish_executed {
        blockers.push(CompletionScmCaptureAdmissionPersistenceBlocker::ScmPublishRequested);
    }
    if input.forge_change_request_requested || input.admission.forge_change_request_created {
        blockers.push(CompletionScmCaptureAdmissionPersistenceBlocker::ForgeChangeRequestRequested);
    }
    if input.forge_merge_requested || input.admission.forge_merge_executed {
        blockers.push(CompletionScmCaptureAdmissionPersistenceBlocker::ForgeMergeRequested);
    }
    if input.provider_write_requested || input.admission.provider_write_executed {
        blockers.push(CompletionScmCaptureAdmissionPersistenceBlocker::ProviderWriteRequested);
    }
    if input.callback_response_requested || input.admission.callback_response_executed {
        blockers.push(CompletionScmCaptureAdmissionPersistenceBlocker::CallbackResponseRequested);
    }
    if input.interruption_requested || input.admission.interruption_executed {
        blockers.push(CompletionScmCaptureAdmissionPersistenceBlocker::InterruptionRequested);
    }
    if input.recovery_requested || input.admission.recovery_executed {
        blockers.push(CompletionScmCaptureAdmissionPersistenceBlocker::RecoveryRequested);
    }
    blockers
}

fn persisted_admission_id(admission_id: &str) -> String {
    format!("{COMPLETION_SCM_CAPTURE_ADMISSION_PREFIX}{admission_id}")
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

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_local_store::SqliteBackend;

    #[test]
    fn completion_scm_capture_admission_persistence_round_trips_sanitized_record() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let db = temp_dir.path().join("nucleus.sqlite");
        let state = ServerStateService::new(SqliteBackend::new(db.clone()));

        let record =
            persist_completion_scm_capture_admission(&state, input(admission())).expect("persist");

        let reopened = ServerStateService::new(SqliteBackend::new(db));
        let records = read_completion_scm_capture_admissions(&reopened).expect("read");

        assert_eq!(records, vec![record]);
        assert_eq!(records[0].candidate_id, "candidate:1");
        assert!(!records[0].scm_capture_permitted);
        assert!(!records[0].raw_material_retained);
    }

    #[test]
    fn completion_scm_capture_admission_state_api_reads_records_in_stable_order() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));

        persist_completion_scm_capture_admission(&state, input(admission_with_id("b")))
            .expect("persist b");
        persist_completion_scm_capture_admission(&state, input(admission_with_id("a")))
            .expect("persist a");

        let records = read_completion_scm_capture_admissions(&state).expect("read");

        assert_eq!(records[0].admission_id, "admission:a");
        assert_eq!(records[1].admission_id, "admission:b");
    }

    #[test]
    fn completion_scm_capture_duplicate_blocked_preserves_blocked_evidence() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
        let mut blocked = admission();
        blocked.status = CompletionScmCaptureAdmissionStatus::Blocked;
        blocked
            .blockers
            .push(CompletionScmCaptureAdmissionBlocker::ReadinessUnsupported);

        let record =
            persist_completion_scm_capture_admission(&state, input(blocked)).expect("persist");
        let duplicate = persist_completion_scm_capture_admission(
            &state,
            CompletionScmCaptureAdmissionPersistenceInput {
                existing_admission_ids: vec![record.persisted_admission_id.clone()],
                ..input(admission())
            },
        )
        .expect("duplicate");

        assert_eq!(
            record.status,
            CompletionScmCaptureAdmissionPersistenceStatus::Persisted
        );
        assert_eq!(
            record.admission_status,
            CompletionScmCaptureAdmissionStatus::Blocked
        );
        assert_eq!(
            duplicate.status,
            CompletionScmCaptureAdmissionPersistenceStatus::DuplicateNoop
        );
        assert!(duplicate.duplicate_admission_detected);
    }

    #[test]
    fn completion_scm_capture_duplicate_blocked_blocks_raw_or_external_effect_requests() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
        let mut input = input(admission());
        input.raw_material_present = true;
        input.scm_capture_requested = true;
        input.forge_change_request_requested = true;

        let record = persist_completion_scm_capture_admission(&state, input).expect("blocked");

        assert_eq!(
            record.status,
            CompletionScmCaptureAdmissionPersistenceStatus::Blocked
        );
        assert!(record
            .blockers
            .contains(&CompletionScmCaptureAdmissionPersistenceBlocker::RawMaterialPresent));
        assert!(record.blockers.contains(
            &CompletionScmCaptureAdmissionPersistenceBlocker::ForgeChangeRequestRequested
        ));
        assert!(!record.scm_capture_permitted);
        assert!(!record.raw_material_retained);
    }

    #[test]
    fn completion_scm_capture_diagnostics_source_summarizes_persisted_admissions() {
        let diagnostics = completion_scm_capture_diagnostics_from_persisted_admissions(vec![
            persisted(CompletionScmCaptureAdmissionStatus::Admitted, Vec::new()),
            persisted(
                CompletionScmCaptureAdmissionStatus::Blocked,
                vec![CompletionScmCaptureAdmissionBlocker::ReadinessUnsupported],
            ),
        ]);

        assert_eq!(diagnostics.admission_count, 2);
        assert_eq!(diagnostics.admitted_count, 1);
        assert_eq!(diagnostics.blocked_count, 1);
        assert_eq!(diagnostics.blocker_count, 1);
        assert!(!diagnostics.scm_capture_executed);
    }

    fn input(
        admission: CompletionScmCaptureAdmissionRecord,
    ) -> CompletionScmCaptureAdmissionPersistenceInput {
        CompletionScmCaptureAdmissionPersistenceInput {
            admission,
            existing_admission_ids: Vec::new(),
            raw_material_present: false,
            scm_capture_requested: false,
            scm_publish_requested: false,
            forge_change_request_requested: false,
            forge_merge_requested: false,
            provider_write_requested: false,
            callback_response_requested: false,
            interruption_requested: false,
            recovery_requested: false,
        }
    }

    fn admission() -> CompletionScmCaptureAdmissionRecord {
        admission_with_id("1")
    }

    fn admission_with_id(id: &str) -> CompletionScmCaptureAdmissionRecord {
        CompletionScmCaptureAdmissionRecord {
            admission_id: format!("admission:{id}"),
            request_id: format!("request:{id}"),
            readiness_id: format!("readiness:{id}"),
            candidate_id: "candidate:1".to_owned(),
            task_id: "task:1".to_owned(),
            work_item_id: Some("work:1".to_owned()),
            completion_id: Some("completion:1".to_owned()),
            operator_ref: "operator:tom".to_owned(),
            evidence_refs: vec!["evidence:capture".to_owned()],
            status: CompletionScmCaptureAdmissionStatus::Admitted,
            blockers: Vec::new(),
            capture_admitted: true,
            scm_capture_executed: false,
            scm_publish_executed: false,
            forge_change_request_created: false,
            forge_merge_executed: false,
            provider_write_executed: false,
            callback_response_executed: false,
            interruption_executed: false,
            recovery_executed: false,
            raw_material_exposed: false,
        }
    }

    fn persisted(
        admission_status: CompletionScmCaptureAdmissionStatus,
        admission_blockers: Vec<CompletionScmCaptureAdmissionBlocker>,
    ) -> CompletionScmCaptureAdmissionPersistenceRecord {
        CompletionScmCaptureAdmissionPersistenceRecord {
            persisted_admission_id: "persisted:1".to_owned(),
            admission_id: "admission:1".to_owned(),
            request_id: "request:1".to_owned(),
            readiness_id: "readiness:1".to_owned(),
            candidate_id: "candidate:1".to_owned(),
            task_id: "task:1".to_owned(),
            work_item_id: Some("work:1".to_owned()),
            completion_id: Some("completion:1".to_owned()),
            operator_ref: "operator:tom".to_owned(),
            evidence_refs: vec!["evidence:capture".to_owned()],
            admission_status,
            status: CompletionScmCaptureAdmissionPersistenceStatus::Persisted,
            blockers: Vec::new(),
            admission_blockers,
            duplicate_admission_detected: false,
            scm_capture_permitted: false,
            scm_publish_permitted: false,
            forge_change_request_permitted: false,
            forge_merge_permitted: false,
            provider_write_permitted: false,
            callback_response_permitted: false,
            interruption_permitted: false,
            recovery_permitted: false,
            raw_material_retained: false,
        }
    }
}
