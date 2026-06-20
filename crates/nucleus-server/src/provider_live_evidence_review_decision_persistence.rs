//! Persistence for explicit live evidence review decisions.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use serde::{Deserialize, Serialize};

use crate::{
    LiveEvidenceReviewAcceptanceAdmissionRecord, LiveEvidenceReviewAcceptanceAdmissionStatus,
    LiveEvidenceReviewDecision, ServerStateService,
};

const LIVE_EVIDENCE_REVIEW_DECISION_PREFIX: &str = "live-evidence-review-decision:";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveEvidenceReviewDecisionPersistenceInput {
    pub admission: LiveEvidenceReviewAcceptanceAdmissionRecord,
    pub existing_decision_ids: Vec<String>,
    pub raw_provider_material_present: bool,
    pub raw_stream_present: bool,
    pub task_completion_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LiveEvidenceReviewDecisionRecord {
    pub decision_id: String,
    pub admission_id: String,
    pub readiness_id: String,
    pub observation_id: String,
    pub task_id: String,
    pub work_item_id: String,
    pub reviewer_ref: String,
    pub decision: LiveEvidenceReviewDecision,
    pub evidence_refs: Vec<String>,
    pub status: LiveEvidenceReviewDecisionPersistenceStatus,
    pub blockers: Vec<LiveEvidenceReviewDecisionPersistenceBlocker>,
    pub duplicate_decision_detected: bool,
    pub task_completion_permitted: bool,
    pub raw_provider_material_retained: bool,
    pub raw_stream_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveEvidenceReviewDecisionPersistenceStatus {
    Persisted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveEvidenceReviewDecisionPersistenceBlocker {
    AdmissionNotAccepted,
    MissingEvidenceRef,
    RawProviderMaterialPresent,
    RawStreamPresent,
    TaskCompletionRequested,
}

pub fn persist_live_evidence_review_decision<B>(
    state: &ServerStateService<B>,
    input: LiveEvidenceReviewDecisionPersistenceInput,
) -> LocalStoreResult<LiveEvidenceReviewDecisionRecord>
where
    B: LocalStoreBackend,
{
    let decision_id = decision_id(&input.admission);
    if input.existing_decision_ids.contains(&decision_id) {
        return Ok(decision_record(
            input,
            decision_id,
            LiveEvidenceReviewDecisionPersistenceStatus::DuplicateNoop,
            Vec::new(),
            true,
        ));
    }

    let blockers = blockers(&input);
    if !blockers.is_empty() {
        return Ok(decision_record(
            input,
            decision_id,
            LiveEvidenceReviewDecisionPersistenceStatus::Blocked,
            blockers,
            false,
        ));
    }

    let record = decision_record(
        input,
        decision_id,
        LiveEvidenceReviewDecisionPersistenceStatus::Persisted,
        Vec::new(),
        false,
    );
    state.artifact_metadata().put(
        LocalStoreRecord {
            id: PersistenceRecordId(record.decision_id.clone()),
            domain: PersistenceDomain::ArtifactMetadata,
            kind: PersistenceRecordKind::ArtifactMetadata,
            revision_id: RevisionId(format!("rev:{}", record.decision_id)),
            payload: json_payload(serde_json::to_vec(&record).map_err(json_error)?),
        },
        RevisionExpectation::MustNotExist,
    )?;

    Ok(record)
}

pub fn read_live_evidence_review_decisions<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<LiveEvidenceReviewDecisionRecord>>
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
                .starts_with(LIVE_EVIDENCE_REVIEW_DECISION_PREFIX)
        })
        .map(|record| {
            serde_json::from_slice::<LiveEvidenceReviewDecisionRecord>(&record.payload.bytes)
                .map_err(json_error)
        })
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| left.decision_id.cmp(&right.decision_id));
    Ok(records)
}

fn decision_record(
    input: LiveEvidenceReviewDecisionPersistenceInput,
    decision_id: String,
    status: LiveEvidenceReviewDecisionPersistenceStatus,
    blockers: Vec<LiveEvidenceReviewDecisionPersistenceBlocker>,
    duplicate_decision_detected: bool,
) -> LiveEvidenceReviewDecisionRecord {
    LiveEvidenceReviewDecisionRecord {
        decision_id,
        admission_id: input.admission.admission_id,
        readiness_id: input.admission.readiness_id,
        observation_id: input.admission.observation_id,
        task_id: input.admission.task_id,
        work_item_id: input.admission.work_item_id,
        reviewer_ref: input.admission.operator_ref,
        decision: input.admission.decision,
        evidence_refs: input.admission.evidence_refs,
        status,
        blockers,
        duplicate_decision_detected,
        task_completion_permitted: false,
        raw_provider_material_retained: false,
        raw_stream_retained: false,
    }
}

fn blockers(
    input: &LiveEvidenceReviewDecisionPersistenceInput,
) -> Vec<LiveEvidenceReviewDecisionPersistenceBlocker> {
    let mut blockers = Vec::new();
    if input.admission.status != LiveEvidenceReviewAcceptanceAdmissionStatus::Admitted {
        blockers.push(LiveEvidenceReviewDecisionPersistenceBlocker::AdmissionNotAccepted);
    }
    if input.admission.evidence_refs.is_empty() {
        blockers.push(LiveEvidenceReviewDecisionPersistenceBlocker::MissingEvidenceRef);
    }
    if input.raw_provider_material_present {
        blockers.push(LiveEvidenceReviewDecisionPersistenceBlocker::RawProviderMaterialPresent);
    }
    if input.raw_stream_present {
        blockers.push(LiveEvidenceReviewDecisionPersistenceBlocker::RawStreamPresent);
    }
    if input.task_completion_requested {
        blockers.push(LiveEvidenceReviewDecisionPersistenceBlocker::TaskCompletionRequested);
    }
    blockers
}

fn decision_id(admission: &LiveEvidenceReviewAcceptanceAdmissionRecord) -> String {
    format!(
        "{}{}:{}",
        LIVE_EVIDENCE_REVIEW_DECISION_PREFIX, admission.work_item_id, admission.readiness_id
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
    use nucleus_local_store::SqliteBackend;

    #[test]
    fn live_evidence_review_decision_persistence_survives_reopen() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let db = temp_dir.path().join("nucleus.sqlite");
        let state = ServerStateService::new(SqliteBackend::new(db.clone()));

        let record = persist_live_evidence_review_decision(&state, input(admission()))
            .expect("persist decision");

        let reopened = ServerStateService::new(SqliteBackend::new(db));
        let records = read_live_evidence_review_decisions(&reopened).expect("read decisions");

        assert_eq!(records, vec![record]);
        assert_eq!(records[0].decision, LiveEvidenceReviewDecision::Accept);
        assert!(!records[0].task_completion_permitted);
        assert!(!records[0].raw_provider_material_retained);
    }

    #[test]
    fn live_evidence_review_decision_persistence_duplicate_is_noop() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let admission = admission();
        let mut input = input(admission.clone());
        input.existing_decision_ids.push(decision_id(&admission));

        let record = persist_live_evidence_review_decision(&state, input).expect("duplicate noop");

        assert_eq!(
            record.status,
            LiveEvidenceReviewDecisionPersistenceStatus::DuplicateNoop
        );
        assert!(record.duplicate_decision_detected);
    }

    #[test]
    fn live_evidence_review_decision_persistence_blocks_raw_or_task_completion() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let mut input = input(admission());
        input.raw_provider_material_present = true;
        input.raw_stream_present = true;
        input.task_completion_requested = true;

        let record = persist_live_evidence_review_decision(&state, input).expect("blocked");

        assert_eq!(
            record.status,
            LiveEvidenceReviewDecisionPersistenceStatus::Blocked
        );
        assert!(record
            .blockers
            .contains(&LiveEvidenceReviewDecisionPersistenceBlocker::RawProviderMaterialPresent));
        assert!(record
            .blockers
            .contains(&LiveEvidenceReviewDecisionPersistenceBlocker::TaskCompletionRequested));
        assert!(!record.task_completion_permitted);
    }

    fn input(
        admission: LiveEvidenceReviewAcceptanceAdmissionRecord,
    ) -> LiveEvidenceReviewDecisionPersistenceInput {
        LiveEvidenceReviewDecisionPersistenceInput {
            admission,
            existing_decision_ids: Vec::new(),
            raw_provider_material_present: false,
            raw_stream_present: false,
            task_completion_requested: false,
        }
    }

    fn admission() -> LiveEvidenceReviewAcceptanceAdmissionRecord {
        LiveEvidenceReviewAcceptanceAdmissionRecord {
            admission_id: "admission:1".to_owned(),
            readiness_id: "readiness:1".to_owned(),
            observation_id: "observation:1".to_owned(),
            task_id: "task:1".to_owned(),
            work_item_id: "work:1".to_owned(),
            status: LiveEvidenceReviewAcceptanceAdmissionStatus::Admitted,
            blockers: Vec::new(),
            operator_ref: "operator:tom".to_owned(),
            evidence_refs: vec!["evidence:review".to_owned()],
            decision: LiveEvidenceReviewDecision::Accept,
            task_completion_permitted: false,
            provider_write_permitted: false,
            callback_response_permitted: false,
            cancellation_permitted: false,
            resume_permitted: false,
            scm_mutation_permitted: false,
        }
    }
}
