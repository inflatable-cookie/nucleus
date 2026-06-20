//! Persistence for explicit live-evidence task-state control records.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use serde::{Deserialize, Serialize};

use crate::{
    LiveEvidenceTaskStateControlRecord, LiveEvidenceTaskStateHistoryEntry,
    LiveEvidenceTaskStateHistoryProjectionRecord, LiveEvidenceTaskStateTransitionAdmissionStatus,
    ServerStateService,
};

const LIVE_EVIDENCE_TASK_STATE_CONTROL_PREFIX: &str = "live-evidence-task-state-control:";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveEvidenceTaskStateControlPersistenceInput {
    pub control: LiveEvidenceTaskStateControlRecord,
    pub existing_control_ids: Vec<String>,
    pub raw_material_present: bool,
    pub provider_write_requested: bool,
    pub callback_response_requested: bool,
    pub interruption_requested: bool,
    pub recovery_requested: bool,
    pub scm_mutation_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LiveEvidenceTaskStateControlPersistenceRecord {
    pub persisted_control_id: String,
    pub control_id: String,
    pub request_id: String,
    pub admission_id: String,
    pub task_id: String,
    pub work_item_id: String,
    pub completion_id: String,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub history_entries: Vec<LiveEvidenceTaskStateHistoryEntry>,
    pub status: LiveEvidenceTaskStateControlPersistenceStatus,
    pub blockers: Vec<LiveEvidenceTaskStateControlPersistenceBlocker>,
    pub repair_required: bool,
    pub duplicate_control_detected: bool,
    pub task_mutation_permitted: bool,
    pub provider_write_permitted: bool,
    pub callback_response_permitted: bool,
    pub interruption_permitted: bool,
    pub recovery_permitted: bool,
    pub scm_mutation_permitted: bool,
    pub forge_mutation_permitted: bool,
    pub raw_material_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveEvidenceTaskStateControlPersistenceStatus {
    Persisted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveEvidenceTaskStateControlPersistenceBlocker {
    AdmissionBlocked,
    MissingHistoryEntry,
    MissingEvidenceRef,
    RawMaterialPresent,
    ProviderWriteRequested,
    CallbackResponseRequested,
    InterruptionRequested,
    RecoveryRequested,
    ScmMutationRequested,
}

pub fn persist_live_evidence_task_state_control<B>(
    state: &ServerStateService<B>,
    input: LiveEvidenceTaskStateControlPersistenceInput,
) -> LocalStoreResult<LiveEvidenceTaskStateControlPersistenceRecord>
where
    B: LocalStoreBackend,
{
    let persisted_control_id = persisted_control_id(&input.control.control_id);
    if input.existing_control_ids.contains(&persisted_control_id) {
        return Ok(persistence_record(
            input,
            persisted_control_id,
            LiveEvidenceTaskStateControlPersistenceStatus::DuplicateNoop,
            Vec::new(),
            true,
        ));
    }

    let blockers = blockers(&input);
    let hard_blocked = blockers.iter().any(is_hard_blocker);
    let status = if hard_blocked {
        LiveEvidenceTaskStateControlPersistenceStatus::Blocked
    } else {
        LiveEvidenceTaskStateControlPersistenceStatus::Persisted
    };
    let record = persistence_record(input, persisted_control_id, status, blockers, false);

    if record.status == LiveEvidenceTaskStateControlPersistenceStatus::Persisted {
        state.artifact_metadata().put(
            LocalStoreRecord {
                id: PersistenceRecordId(record.persisted_control_id.clone()),
                domain: PersistenceDomain::ArtifactMetadata,
                kind: PersistenceRecordKind::ArtifactMetadata,
                revision_id: RevisionId(format!("rev:{}", record.persisted_control_id)),
                payload: json_payload(serde_json::to_vec(&record).map_err(json_error)?),
            },
            RevisionExpectation::MustNotExist,
        )?;
    }

    Ok(record)
}

pub fn read_live_evidence_task_state_control_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<LiveEvidenceTaskStateControlPersistenceRecord>>
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
                .starts_with(LIVE_EVIDENCE_TASK_STATE_CONTROL_PREFIX)
        })
        .map(|record| {
            serde_json::from_slice::<LiveEvidenceTaskStateControlPersistenceRecord>(
                &record.payload.bytes,
            )
            .map_err(json_error)
        })
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| left.persisted_control_id.cmp(&right.persisted_control_id));
    Ok(records)
}

pub fn live_evidence_task_state_history_from_persisted_controls(
    records: Vec<LiveEvidenceTaskStateControlPersistenceRecord>,
) -> LiveEvidenceTaskStateHistoryProjectionRecord {
    let mut entries = Vec::new();
    let mut skipped_admission_ids = Vec::new();

    for record in records {
        if record.status == LiveEvidenceTaskStateControlPersistenceStatus::Persisted
            && !record.repair_required
        {
            entries.extend(record.history_entries);
        } else {
            skipped_admission_ids.push(record.admission_id);
        }
    }

    entries.sort_by(|left, right| left.history_entry_id.cmp(&right.history_entry_id));
    skipped_admission_ids.sort();
    skipped_admission_ids.dedup();

    LiveEvidenceTaskStateHistoryProjectionRecord {
        projection_id: "live-evidence-task-state-history-from-persisted-controls".to_owned(),
        entries,
        skipped_admission_ids,
        provider_authority_granted: false,
        scm_authority_granted: false,
        raw_material_exposed: false,
    }
}

fn persistence_record(
    input: LiveEvidenceTaskStateControlPersistenceInput,
    persisted_control_id: String,
    status: LiveEvidenceTaskStateControlPersistenceStatus,
    blockers: Vec<LiveEvidenceTaskStateControlPersistenceBlocker>,
    duplicate_control_detected: bool,
) -> LiveEvidenceTaskStateControlPersistenceRecord {
    let repair_required = !blockers.is_empty()
        || input.control.admission.status
            != LiveEvidenceTaskStateTransitionAdmissionStatus::Admitted
        || input.control.history.entries.is_empty();

    LiveEvidenceTaskStateControlPersistenceRecord {
        persisted_control_id,
        control_id: input.control.control_id,
        request_id: input.control.request_id,
        admission_id: input.control.admission.admission_id,
        task_id: input.control.admission.task_id,
        work_item_id: input.control.admission.work_item_id,
        completion_id: input.control.admission.completion_id,
        operator_ref: input.control.admission.operator_ref,
        evidence_refs: unique_sorted(input.control.admission.evidence_refs),
        history_entries: input.control.history.entries,
        status,
        blockers,
        repair_required,
        duplicate_control_detected,
        task_mutation_permitted: false,
        provider_write_permitted: false,
        callback_response_permitted: false,
        interruption_permitted: false,
        recovery_permitted: false,
        scm_mutation_permitted: false,
        forge_mutation_permitted: false,
        raw_material_retained: false,
    }
}

fn blockers(
    input: &LiveEvidenceTaskStateControlPersistenceInput,
) -> Vec<LiveEvidenceTaskStateControlPersistenceBlocker> {
    let mut blockers = Vec::new();
    if input.control.admission.status != LiveEvidenceTaskStateTransitionAdmissionStatus::Admitted {
        blockers.push(LiveEvidenceTaskStateControlPersistenceBlocker::AdmissionBlocked);
    }
    if input.control.history.entries.is_empty() {
        blockers.push(LiveEvidenceTaskStateControlPersistenceBlocker::MissingHistoryEntry);
    }
    if input.control.admission.evidence_refs.is_empty() {
        blockers.push(LiveEvidenceTaskStateControlPersistenceBlocker::MissingEvidenceRef);
    }
    if input.raw_material_present {
        blockers.push(LiveEvidenceTaskStateControlPersistenceBlocker::RawMaterialPresent);
    }
    if input.provider_write_requested || input.control.provider_authority_granted {
        blockers.push(LiveEvidenceTaskStateControlPersistenceBlocker::ProviderWriteRequested);
    }
    if input.callback_response_requested || input.control.callback_authority_granted {
        blockers.push(LiveEvidenceTaskStateControlPersistenceBlocker::CallbackResponseRequested);
    }
    if input.interruption_requested || input.control.interruption_authority_granted {
        blockers.push(LiveEvidenceTaskStateControlPersistenceBlocker::InterruptionRequested);
    }
    if input.recovery_requested || input.control.recovery_authority_granted {
        blockers.push(LiveEvidenceTaskStateControlPersistenceBlocker::RecoveryRequested);
    }
    if input.scm_mutation_requested || input.control.scm_authority_granted {
        blockers.push(LiveEvidenceTaskStateControlPersistenceBlocker::ScmMutationRequested);
    }
    blockers
}

fn is_hard_blocker(blocker: &LiveEvidenceTaskStateControlPersistenceBlocker) -> bool {
    matches!(
        blocker,
        LiveEvidenceTaskStateControlPersistenceBlocker::RawMaterialPresent
            | LiveEvidenceTaskStateControlPersistenceBlocker::ProviderWriteRequested
            | LiveEvidenceTaskStateControlPersistenceBlocker::CallbackResponseRequested
            | LiveEvidenceTaskStateControlPersistenceBlocker::InterruptionRequested
            | LiveEvidenceTaskStateControlPersistenceBlocker::RecoveryRequested
            | LiveEvidenceTaskStateControlPersistenceBlocker::ScmMutationRequested
    )
}

fn persisted_control_id(control_id: &str) -> String {
    format!("{LIVE_EVIDENCE_TASK_STATE_CONTROL_PREFIX}{control_id}")
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
    fn live_evidence_task_state_control_persistence_round_trips_sanitized_record() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let db = temp_dir.path().join("nucleus.sqlite");
        let state = ServerStateService::new(SqliteBackend::new(db.clone()));

        let record =
            persist_live_evidence_task_state_control(&state, input(control())).expect("persist");

        let reopened = ServerStateService::new(SqliteBackend::new(db));
        let records =
            read_live_evidence_task_state_control_records(&reopened).expect("read controls");

        assert_eq!(records, vec![record]);
        assert_eq!(records[0].history_entries.len(), 1);
        assert!(!records[0].repair_required);
        assert!(!records[0].scm_mutation_permitted);
        assert!(!records[0].raw_material_retained);
    }

    #[test]
    fn live_evidence_task_state_control_state_api_rebuilds_history_projection() {
        let record = persistence_record(
            input(control()),
            "live-evidence-task-state-control:control:1".to_owned(),
            LiveEvidenceTaskStateControlPersistenceStatus::Persisted,
            Vec::new(),
            false,
        );

        let history = live_evidence_task_state_history_from_persisted_controls(vec![record]);

        assert_eq!(history.entries.len(), 1);
        assert_eq!(history.entries[0].task_id, "task:1");
        assert!(history.skipped_admission_ids.is_empty());
        assert!(!history.scm_authority_granted);
    }

    #[test]
    fn live_evidence_task_state_duplicate_repair_persists_blocked_as_repair_evidence() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
        let mut blocked = control();
        blocked.admission.status = LiveEvidenceTaskStateTransitionAdmissionStatus::Blocked;
        blocked.history.entries.clear();

        let record =
            persist_live_evidence_task_state_control(&state, input(blocked)).expect("persist");
        let history =
            live_evidence_task_state_history_from_persisted_controls(vec![record.clone()]);
        let duplicate = persist_live_evidence_task_state_control(
            &state,
            LiveEvidenceTaskStateControlPersistenceInput {
                existing_control_ids: vec![record.persisted_control_id.clone()],
                ..input(control())
            },
        )
        .expect("duplicate");

        assert_eq!(
            record.status,
            LiveEvidenceTaskStateControlPersistenceStatus::Persisted
        );
        assert!(record.repair_required);
        assert!(history.entries.is_empty());
        assert_eq!(
            history.skipped_admission_ids,
            vec!["admission:1".to_owned()]
        );
        assert_eq!(
            duplicate.status,
            LiveEvidenceTaskStateControlPersistenceStatus::DuplicateNoop
        );
        assert!(duplicate.duplicate_control_detected);
    }

    #[test]
    fn live_evidence_task_state_duplicate_repair_blocks_raw_or_external_effect_requests() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
        let mut input = input(control());
        input.raw_material_present = true;
        input.scm_mutation_requested = true;
        input.provider_write_requested = true;

        let record = persist_live_evidence_task_state_control(&state, input).expect("blocked");

        assert_eq!(
            record.status,
            LiveEvidenceTaskStateControlPersistenceStatus::Blocked
        );
        assert!(record
            .blockers
            .contains(&LiveEvidenceTaskStateControlPersistenceBlocker::RawMaterialPresent));
        assert!(record
            .blockers
            .contains(&LiveEvidenceTaskStateControlPersistenceBlocker::ScmMutationRequested));
        assert!(!record.provider_write_permitted);
        assert!(!record.raw_material_retained);
    }

    fn input(
        control: LiveEvidenceTaskStateControlRecord,
    ) -> LiveEvidenceTaskStateControlPersistenceInput {
        LiveEvidenceTaskStateControlPersistenceInput {
            control,
            existing_control_ids: Vec::new(),
            raw_material_present: false,
            provider_write_requested: false,
            callback_response_requested: false,
            interruption_requested: false,
            recovery_requested: false,
            scm_mutation_requested: false,
        }
    }

    fn control() -> LiveEvidenceTaskStateControlRecord {
        LiveEvidenceTaskStateControlRecord {
            control_id: "control:1".to_owned(),
            request_id: "request:1".to_owned(),
            admission: crate::LiveEvidenceTaskStateTransitionAdmissionRecord {
                admission_id: "admission:1".to_owned(),
                task_id: "task:1".to_owned(),
                work_item_id: "work:1".to_owned(),
                completion_id: "completion:1".to_owned(),
                operator_ref: "operator:tom".to_owned(),
                evidence_refs: vec!["evidence:task-state".to_owned()],
                status: LiveEvidenceTaskStateTransitionAdmissionStatus::Admitted,
                blockers: Vec::new(),
                task_state_transition_admitted: true,
                provider_authority_granted: false,
                callback_authority_granted: false,
                interruption_authority_granted: false,
                recovery_authority_granted: false,
                scm_authority_granted: false,
                raw_material_retained: false,
            },
            history: LiveEvidenceTaskStateHistoryProjectionRecord {
                projection_id: "history".to_owned(),
                entries: vec![LiveEvidenceTaskStateHistoryEntry {
                    history_entry_id: "history:1".to_owned(),
                    admission_id: "admission:1".to_owned(),
                    task_id: "task:1".to_owned(),
                    work_item_id: "work:1".to_owned(),
                    completion_id: "completion:1".to_owned(),
                    operator_ref: "operator:tom".to_owned(),
                    evidence_refs: vec!["evidence:task-state".to_owned()],
                    task_state: "completed".to_owned(),
                }],
                skipped_admission_ids: Vec::new(),
                provider_authority_granted: false,
                scm_authority_granted: false,
                raw_material_exposed: false,
            },
            task_state_mutation_requested: true,
            provider_authority_granted: false,
            callback_authority_granted: false,
            interruption_authority_granted: false,
            recovery_authority_granted: false,
            scm_authority_granted: false,
            raw_material_exposed: false,
        }
    }
}
