//! Persistence for explicit live evidence task-completion decisions.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use serde::{Deserialize, Serialize};

use crate::{
    LiveEvidenceTaskCompletionAdmissionRecord, LiveEvidenceTaskCompletionAdmissionStatus,
    ServerStateService,
};

const LIVE_EVIDENCE_TASK_COMPLETION_PREFIX: &str = "live-evidence-task-completion:";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveEvidenceTaskCompletionPersistenceInput {
    pub admission: LiveEvidenceTaskCompletionAdmissionRecord,
    pub existing_completion_ids: Vec<String>,
    pub raw_provider_material_present: bool,
    pub raw_stream_present: bool,
    pub provider_write_requested: bool,
    pub callback_response_requested: bool,
    pub cancellation_requested: bool,
    pub resume_requested: bool,
    pub scm_mutation_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LiveEvidenceTaskCompletionRecord {
    pub completion_id: String,
    pub admission_id: String,
    pub review_decision_id: String,
    pub task_id: String,
    pub work_item_id: String,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub status: LiveEvidenceTaskCompletionPersistenceStatus,
    pub blockers: Vec<LiveEvidenceTaskCompletionPersistenceBlocker>,
    pub duplicate_completion_detected: bool,
    pub task_completed: bool,
    pub provider_write_permitted: bool,
    pub callback_response_permitted: bool,
    pub cancellation_permitted: bool,
    pub resume_permitted: bool,
    pub scm_mutation_permitted: bool,
    pub raw_provider_material_retained: bool,
    pub raw_stream_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveEvidenceTaskCompletionPersistenceStatus {
    Persisted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveEvidenceTaskCompletionPersistenceBlocker {
    AdmissionNotAccepted,
    MissingEvidenceRef,
    RawProviderMaterialPresent,
    RawStreamPresent,
    ProviderWriteRequested,
    CallbackResponseRequested,
    CancellationRequested,
    ResumeRequested,
    ScmMutationRequested,
}

pub fn persist_live_evidence_task_completion<B>(
    state: &ServerStateService<B>,
    input: LiveEvidenceTaskCompletionPersistenceInput,
) -> LocalStoreResult<LiveEvidenceTaskCompletionRecord>
where
    B: LocalStoreBackend,
{
    let completion_id = completion_id(&input.admission);
    if input.existing_completion_ids.contains(&completion_id) {
        return Ok(completion_record(
            input,
            completion_id,
            LiveEvidenceTaskCompletionPersistenceStatus::DuplicateNoop,
            Vec::new(),
            true,
        ));
    }

    let blockers = blockers(&input);
    if !blockers.is_empty() {
        return Ok(completion_record(
            input,
            completion_id,
            LiveEvidenceTaskCompletionPersistenceStatus::Blocked,
            blockers,
            false,
        ));
    }

    let record = completion_record(
        input,
        completion_id,
        LiveEvidenceTaskCompletionPersistenceStatus::Persisted,
        Vec::new(),
        false,
    );
    state.artifact_metadata().put(
        LocalStoreRecord {
            id: PersistenceRecordId(record.completion_id.clone()),
            domain: PersistenceDomain::ArtifactMetadata,
            kind: PersistenceRecordKind::ArtifactMetadata,
            revision_id: RevisionId(format!("rev:{}", record.completion_id)),
            payload: json_payload(serde_json::to_vec(&record).map_err(json_error)?),
        },
        RevisionExpectation::MustNotExist,
    )?;

    Ok(record)
}

pub fn read_live_evidence_task_completions<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<LiveEvidenceTaskCompletionRecord>>
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
                .starts_with(LIVE_EVIDENCE_TASK_COMPLETION_PREFIX)
        })
        .map(|record| {
            serde_json::from_slice::<LiveEvidenceTaskCompletionRecord>(&record.payload.bytes)
                .map_err(json_error)
        })
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| left.completion_id.cmp(&right.completion_id));
    Ok(records)
}

fn completion_record(
    input: LiveEvidenceTaskCompletionPersistenceInput,
    completion_id: String,
    status: LiveEvidenceTaskCompletionPersistenceStatus,
    blockers: Vec<LiveEvidenceTaskCompletionPersistenceBlocker>,
    duplicate_completion_detected: bool,
) -> LiveEvidenceTaskCompletionRecord {
    let task_completed = status == LiveEvidenceTaskCompletionPersistenceStatus::Persisted;
    LiveEvidenceTaskCompletionRecord {
        completion_id,
        admission_id: input.admission.admission_id,
        review_decision_id: input.admission.review_decision_id,
        task_id: input.admission.task_id,
        work_item_id: input.admission.work_item_id,
        operator_ref: input.admission.operator_ref,
        evidence_refs: input.admission.evidence_refs,
        status,
        blockers,
        duplicate_completion_detected,
        task_completed,
        provider_write_permitted: false,
        callback_response_permitted: false,
        cancellation_permitted: false,
        resume_permitted: false,
        scm_mutation_permitted: false,
        raw_provider_material_retained: false,
        raw_stream_retained: false,
    }
}

fn blockers(
    input: &LiveEvidenceTaskCompletionPersistenceInput,
) -> Vec<LiveEvidenceTaskCompletionPersistenceBlocker> {
    let mut blockers = Vec::new();
    if input.admission.status != LiveEvidenceTaskCompletionAdmissionStatus::Admitted {
        blockers.push(LiveEvidenceTaskCompletionPersistenceBlocker::AdmissionNotAccepted);
    }
    if input.admission.evidence_refs.is_empty() {
        blockers.push(LiveEvidenceTaskCompletionPersistenceBlocker::MissingEvidenceRef);
    }
    if input.raw_provider_material_present {
        blockers.push(LiveEvidenceTaskCompletionPersistenceBlocker::RawProviderMaterialPresent);
    }
    if input.raw_stream_present {
        blockers.push(LiveEvidenceTaskCompletionPersistenceBlocker::RawStreamPresent);
    }
    if input.provider_write_requested {
        blockers.push(LiveEvidenceTaskCompletionPersistenceBlocker::ProviderWriteRequested);
    }
    if input.callback_response_requested {
        blockers.push(LiveEvidenceTaskCompletionPersistenceBlocker::CallbackResponseRequested);
    }
    if input.cancellation_requested {
        blockers.push(LiveEvidenceTaskCompletionPersistenceBlocker::CancellationRequested);
    }
    if input.resume_requested {
        blockers.push(LiveEvidenceTaskCompletionPersistenceBlocker::ResumeRequested);
    }
    if input.scm_mutation_requested {
        blockers.push(LiveEvidenceTaskCompletionPersistenceBlocker::ScmMutationRequested);
    }
    blockers
}

fn completion_id(admission: &LiveEvidenceTaskCompletionAdmissionRecord) -> String {
    format!(
        "{}{}:{}",
        LIVE_EVIDENCE_TASK_COMPLETION_PREFIX, admission.task_id, admission.work_item_id
    )
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::LiveEvidenceTaskCompletionAdmissionBlocker;
    use nucleus_local_store::SqliteBackend;

    #[test]
    fn live_evidence_task_completion_persistence_survives_reopen() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let db = temp_dir.path().join("nucleus.sqlite");
        let state = ServerStateService::new(SqliteBackend::new(db.clone()));

        let record =
            persist_live_evidence_task_completion(&state, input(admission())).expect("persist");

        let reopened = ServerStateService::new(SqliteBackend::new(db));
        let records = read_live_evidence_task_completions(&reopened).expect("read");

        assert_eq!(records, vec![record]);
        assert!(records[0].task_completed);
        assert!(!records[0].provider_write_permitted);
        assert!(!records[0].raw_provider_material_retained);
    }

    #[test]
    fn live_evidence_task_completion_persistence_duplicate_is_noop() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let admission = admission();
        let mut input = input(admission.clone());
        input
            .existing_completion_ids
            .push(completion_id(&admission));

        let record = persist_live_evidence_task_completion(&state, input).expect("duplicate");

        assert_eq!(
            record.status,
            LiveEvidenceTaskCompletionPersistenceStatus::DuplicateNoop
        );
        assert!(record.duplicate_completion_detected);
        assert!(!record.task_completed);
    }

    #[test]
    fn live_evidence_task_completion_authority_blocks_raw_provider_and_scm_requests() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let mut input = input(admission());
        input.raw_provider_material_present = true;
        input.raw_stream_present = true;
        input.provider_write_requested = true;
        input.callback_response_requested = true;
        input.cancellation_requested = true;
        input.resume_requested = true;
        input.scm_mutation_requested = true;

        let record = persist_live_evidence_task_completion(&state, input).expect("blocked");

        assert_eq!(
            record.status,
            LiveEvidenceTaskCompletionPersistenceStatus::Blocked
        );
        assert!(record
            .blockers
            .contains(&LiveEvidenceTaskCompletionPersistenceBlocker::RawProviderMaterialPresent));
        assert!(record
            .blockers
            .contains(&LiveEvidenceTaskCompletionPersistenceBlocker::ScmMutationRequested));
        assert!(!record.task_completed);
        assert!(!record.scm_mutation_permitted);
    }

    fn input(
        admission: LiveEvidenceTaskCompletionAdmissionRecord,
    ) -> LiveEvidenceTaskCompletionPersistenceInput {
        LiveEvidenceTaskCompletionPersistenceInput {
            admission,
            existing_completion_ids: Vec::new(),
            raw_provider_material_present: false,
            raw_stream_present: false,
            provider_write_requested: false,
            callback_response_requested: false,
            cancellation_requested: false,
            resume_requested: false,
            scm_mutation_requested: false,
        }
    }

    fn admission() -> LiveEvidenceTaskCompletionAdmissionRecord {
        LiveEvidenceTaskCompletionAdmissionRecord {
            admission_id: "completion-admission:1".to_owned(),
            review_decision_id: "review-decision:1".to_owned(),
            task_id: "task:1".to_owned(),
            work_item_id: "work:1".to_owned(),
            operator_ref: "operator:tom".to_owned(),
            evidence_refs: vec!["evidence:completion".to_owned()],
            status: LiveEvidenceTaskCompletionAdmissionStatus::Admitted,
            blockers: Vec::<LiveEvidenceTaskCompletionAdmissionBlocker>::new(),
            task_completion_admitted: true,
            provider_write_permitted: false,
            callback_response_permitted: false,
            cancellation_permitted: false,
            resume_permitted: false,
            scm_mutation_permitted: false,
            raw_provider_material_retained: false,
            raw_stream_retained: false,
        }
    }
}
