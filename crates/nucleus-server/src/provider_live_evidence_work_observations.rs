//! Persisted task-work observations from live provider evidence candidates.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use serde::{Deserialize, Serialize};

use crate::{
    LiveProviderEvidenceWorkCandidateRecord, LiveProviderEvidenceWorkCandidateStatus,
    ServerStateService,
};

const LIVE_PROVIDER_EVIDENCE_WORK_OBSERVATION_PREFIX: &str =
    "live-provider-evidence-work-observation:";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveProviderEvidenceWorkObservationInput {
    pub candidate: LiveProviderEvidenceWorkCandidateRecord,
    pub existing_observation_ids: Vec<String>,
    pub raw_provider_material_present: bool,
    pub raw_stream_present: bool,
    pub task_mutation_requested: bool,
    pub review_acceptance_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LiveProviderEvidenceWorkObservationRecord {
    pub observation_id: String,
    pub candidate_id: String,
    pub project_id: String,
    pub task_id: String,
    pub work_item_id: String,
    pub evidence_id: String,
    pub runtime_receipt_id: Option<String>,
    pub live_executor_outcome_id: Option<String>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub status: LiveProviderEvidenceWorkObservationStatus,
    pub blockers: Vec<LiveProviderEvidenceWorkObservationBlocker>,
    pub duplicate_observation_detected: bool,
    pub provider_write_executed: bool,
    pub runtime_completed: bool,
    pub review_ready_candidate: bool,
    pub task_completion_permitted: bool,
    pub review_acceptance_permitted: bool,
    pub raw_provider_material_retained: bool,
    pub raw_stream_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveProviderEvidenceWorkObservationStatus {
    Persisted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveProviderEvidenceWorkObservationBlocker {
    CandidateNotReady,
    MissingEvidenceId,
    MissingRuntimeReceipt,
    MissingLiveExecutorOutcome,
    RawProviderMaterialPresent,
    RawStreamPresent,
    TaskMutationRequested,
    ReviewAcceptanceRequested,
}

pub fn persist_live_provider_evidence_work_observation<B>(
    state: &ServerStateService<B>,
    input: LiveProviderEvidenceWorkObservationInput,
) -> LocalStoreResult<LiveProviderEvidenceWorkObservationRecord>
where
    B: LocalStoreBackend,
{
    let observation_id = observation_id(&input.candidate);
    if input.existing_observation_ids.contains(&observation_id) {
        return Ok(observation_record(
            input,
            observation_id,
            LiveProviderEvidenceWorkObservationStatus::DuplicateNoop,
            Vec::new(),
            true,
        ));
    }

    let blockers = blockers(&input);
    if !blockers.is_empty() {
        return Ok(observation_record(
            input,
            observation_id,
            LiveProviderEvidenceWorkObservationStatus::Blocked,
            blockers,
            false,
        ));
    }

    let record = observation_record(
        input,
        observation_id,
        LiveProviderEvidenceWorkObservationStatus::Persisted,
        Vec::new(),
        false,
    );
    state.artifact_metadata().put(
        LocalStoreRecord {
            id: PersistenceRecordId(record.observation_id.clone()),
            domain: PersistenceDomain::ArtifactMetadata,
            kind: PersistenceRecordKind::ArtifactMetadata,
            revision_id: RevisionId(format!("rev:{}", record.observation_id)),
            payload: json_payload(serde_json::to_vec(&record).map_err(json_error)?),
        },
        RevisionExpectation::MustNotExist,
    )?;

    Ok(record)
}

pub fn read_live_provider_evidence_work_observations<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<LiveProviderEvidenceWorkObservationRecord>>
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
                .starts_with(LIVE_PROVIDER_EVIDENCE_WORK_OBSERVATION_PREFIX)
        })
        .map(|record| {
            serde_json::from_slice::<LiveProviderEvidenceWorkObservationRecord>(
                &record.payload.bytes,
            )
            .map_err(json_error)
        })
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| left.observation_id.cmp(&right.observation_id));
    Ok(records)
}

fn observation_record(
    input: LiveProviderEvidenceWorkObservationInput,
    observation_id: String,
    status: LiveProviderEvidenceWorkObservationStatus,
    blockers: Vec<LiveProviderEvidenceWorkObservationBlocker>,
    duplicate_observation_detected: bool,
) -> LiveProviderEvidenceWorkObservationRecord {
    LiveProviderEvidenceWorkObservationRecord {
        observation_id,
        candidate_id: input.candidate.candidate_id,
        project_id: input.candidate.project_id,
        task_id: input.candidate.task_id,
        work_item_id: input.candidate.work_item_id,
        evidence_id: input.candidate.evidence_id,
        runtime_receipt_id: input.candidate.runtime_receipt_id,
        live_executor_outcome_id: input.candidate.live_executor_outcome_id,
        thread_id: input.candidate.thread_id,
        turn_id: input.candidate.turn_id,
        status,
        blockers,
        duplicate_observation_detected,
        provider_write_executed: input.candidate.provider_write_executed,
        runtime_completed: input.candidate.runtime_completed,
        review_ready_candidate: input.candidate.review_ready_candidate,
        task_completion_permitted: false,
        review_acceptance_permitted: false,
        raw_provider_material_retained: false,
        raw_stream_retained: false,
    }
}

fn blockers(
    input: &LiveProviderEvidenceWorkObservationInput,
) -> Vec<LiveProviderEvidenceWorkObservationBlocker> {
    let mut blockers = Vec::new();
    if input.candidate.status != LiveProviderEvidenceWorkCandidateStatus::Ready {
        blockers.push(LiveProviderEvidenceWorkObservationBlocker::CandidateNotReady);
    }
    if input.candidate.evidence_id.trim().is_empty() {
        blockers.push(LiveProviderEvidenceWorkObservationBlocker::MissingEvidenceId);
    }
    if input.candidate.runtime_receipt_id.is_none() {
        blockers.push(LiveProviderEvidenceWorkObservationBlocker::MissingRuntimeReceipt);
    }
    if input.candidate.live_executor_outcome_id.is_none() {
        blockers.push(LiveProviderEvidenceWorkObservationBlocker::MissingLiveExecutorOutcome);
    }
    if input.raw_provider_material_present {
        blockers.push(LiveProviderEvidenceWorkObservationBlocker::RawProviderMaterialPresent);
    }
    if input.raw_stream_present {
        blockers.push(LiveProviderEvidenceWorkObservationBlocker::RawStreamPresent);
    }
    if input.task_mutation_requested {
        blockers.push(LiveProviderEvidenceWorkObservationBlocker::TaskMutationRequested);
    }
    if input.review_acceptance_requested {
        blockers.push(LiveProviderEvidenceWorkObservationBlocker::ReviewAcceptanceRequested);
    }
    blockers
}

fn observation_id(candidate: &LiveProviderEvidenceWorkCandidateRecord) -> String {
    format!(
        "{}{}:{}",
        LIVE_PROVIDER_EVIDENCE_WORK_OBSERVATION_PREFIX,
        candidate.work_item_id,
        candidate.evidence_id
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
    use crate::LiveProviderEvidenceWorkCandidateGap;
    use nucleus_local_store::SqliteBackend;

    #[test]
    fn live_provider_evidence_work_observations_survive_reopen() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let db = temp_dir.path().join("nucleus.sqlite");
        let state = ServerStateService::new(SqliteBackend::new(db.clone()));

        let record = persist_live_provider_evidence_work_observation(&state, input(candidate()))
            .expect("persist observation");

        let reopened = ServerStateService::new(SqliteBackend::new(db));
        let records =
            read_live_provider_evidence_work_observations(&reopened).expect("read observations");

        assert_eq!(records, vec![record]);
        assert!(records[0].runtime_completed);
        assert!(records[0].review_ready_candidate);
        assert!(!records[0].task_completion_permitted);
        assert!(!records[0].review_acceptance_permitted);
    }

    #[test]
    fn live_provider_evidence_work_observations_duplicate_is_noop() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let candidate = candidate();
        let mut input = input(candidate.clone());
        input
            .existing_observation_ids
            .push(observation_id(&candidate));

        let record =
            persist_live_provider_evidence_work_observation(&state, input).expect("duplicate noop");

        assert_eq!(
            record.status,
            LiveProviderEvidenceWorkObservationStatus::DuplicateNoop
        );
        assert!(record.duplicate_observation_detected);
    }

    #[test]
    fn live_provider_evidence_work_observations_block_raw_or_widened_authority() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let mut input = input(candidate());
        input.raw_provider_material_present = true;
        input.raw_stream_present = true;
        input.task_mutation_requested = true;
        input.review_acceptance_requested = true;

        let record =
            persist_live_provider_evidence_work_observation(&state, input).expect("blocked");

        assert_eq!(
            record.status,
            LiveProviderEvidenceWorkObservationStatus::Blocked
        );
        assert!(record
            .blockers
            .contains(&LiveProviderEvidenceWorkObservationBlocker::RawProviderMaterialPresent));
        assert!(record
            .blockers
            .contains(&LiveProviderEvidenceWorkObservationBlocker::ReviewAcceptanceRequested));
        assert!(!record.raw_provider_material_retained);
        assert!(!record.review_acceptance_permitted);
    }

    fn input(
        candidate: LiveProviderEvidenceWorkCandidateRecord,
    ) -> LiveProviderEvidenceWorkObservationInput {
        LiveProviderEvidenceWorkObservationInput {
            candidate,
            existing_observation_ids: Vec::new(),
            raw_provider_material_present: false,
            raw_stream_present: false,
            task_mutation_requested: false,
            review_acceptance_requested: false,
        }
    }

    fn candidate() -> LiveProviderEvidenceWorkCandidateRecord {
        LiveProviderEvidenceWorkCandidateRecord {
            candidate_id: "candidate:1".to_owned(),
            project_id: "project:nucleus".to_owned(),
            task_id: "task:live-provider".to_owned(),
            work_item_id: "work:live-provider".to_owned(),
            evidence_id: "evidence:live-provider".to_owned(),
            replay_id: "replay:live-provider".to_owned(),
            runtime_receipt_id: Some("receipt:live-provider".to_owned()),
            live_executor_outcome_id: Some("outcome:live-provider".to_owned()),
            thread_id: Some("thread:live-provider".to_owned()),
            turn_id: Some("turn:live-provider".to_owned()),
            provider_instance_id: "codex:live-provider".to_owned(),
            status: LiveProviderEvidenceWorkCandidateStatus::Ready,
            gaps: Vec::<LiveProviderEvidenceWorkCandidateGap>::new(),
            provider_write_executed: true,
            runtime_completed: true,
            review_ready_candidate: true,
            task_completion_inferred: false,
            review_acceptance_inferred: false,
        }
    }
}
