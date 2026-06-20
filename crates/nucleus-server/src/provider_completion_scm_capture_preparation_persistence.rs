//! Persistence for completion SCM capture-preparation records.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use serde::{Deserialize, Serialize};

use crate::{
    CompletionScmCapturePlanBlocker, CompletionScmCapturePlanItem, CompletionScmCapturePlanStatus,
    ServerStateService,
};

const COMPLETION_SCM_CAPTURE_PREPARATION_PREFIX: &str = "completion-scm-capture-preparation:";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompletionScmCapturePreparationPersistenceInput {
    pub plan_item: CompletionScmCapturePlanItem,
    pub admission_id: String,
    pub readiness_id: String,
    pub capture_candidate_id: String,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub existing_preparation_ids: Vec<String>,
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
pub struct CompletionScmCapturePreparationPersistenceRecord {
    pub persisted_preparation_id: String,
    pub plan_item_id: String,
    pub preparation_candidate_id: String,
    pub admission_id: String,
    pub readiness_id: String,
    pub capture_candidate_id: String,
    pub task_id: String,
    pub work_item_id: Option<String>,
    pub completion_id: Option<String>,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub adapter_label: String,
    pub workflow_label: String,
    pub plan_status: CompletionScmCapturePlanStatus,
    pub plan_blockers: Vec<CompletionScmCapturePlanBlocker>,
    pub status: CompletionScmCapturePreparationPersistenceStatus,
    pub blockers: Vec<CompletionScmCapturePreparationPersistenceBlocker>,
    pub duplicate_preparation_detected: bool,
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
pub enum CompletionScmCapturePreparationPersistenceStatus {
    Persisted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletionScmCapturePreparationPersistenceBlocker {
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

pub fn persist_completion_scm_capture_preparation<B>(
    state: &ServerStateService<B>,
    input: CompletionScmCapturePreparationPersistenceInput,
) -> LocalStoreResult<CompletionScmCapturePreparationPersistenceRecord>
where
    B: LocalStoreBackend,
{
    let persisted_preparation_id = persisted_preparation_id(&input.plan_item.plan_item_id);
    if input
        .existing_preparation_ids
        .contains(&persisted_preparation_id)
    {
        return Ok(persistence_record(
            input,
            persisted_preparation_id,
            CompletionScmCapturePreparationPersistenceStatus::DuplicateNoop,
            Vec::new(),
            true,
        ));
    }

    let blockers = blockers(&input);
    let status = if blockers.is_empty() {
        CompletionScmCapturePreparationPersistenceStatus::Persisted
    } else {
        CompletionScmCapturePreparationPersistenceStatus::Blocked
    };
    let record = persistence_record(input, persisted_preparation_id, status, blockers, false);

    if record.status == CompletionScmCapturePreparationPersistenceStatus::Persisted {
        state.artifact_metadata().put(
            LocalStoreRecord {
                id: PersistenceRecordId(record.persisted_preparation_id.clone()),
                domain: PersistenceDomain::ArtifactMetadata,
                kind: PersistenceRecordKind::ArtifactMetadata,
                revision_id: RevisionId(format!("rev:{}", record.persisted_preparation_id)),
                payload: json_payload(serde_json::to_vec(&record).map_err(json_error)?),
            },
            RevisionExpectation::MustNotExist,
        )?;
    }

    Ok(record)
}

pub fn read_completion_scm_capture_preparations<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<CompletionScmCapturePreparationPersistenceRecord>>
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
                .starts_with(COMPLETION_SCM_CAPTURE_PREPARATION_PREFIX)
        })
        .map(|record| {
            serde_json::from_slice::<CompletionScmCapturePreparationPersistenceRecord>(
                &record.payload.bytes,
            )
            .map_err(json_error)
        })
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| {
        left.persisted_preparation_id
            .cmp(&right.persisted_preparation_id)
    });
    Ok(records)
}

pub fn completion_scm_capture_preparation_diagnostics_from_persisted_records(
    records: Vec<CompletionScmCapturePreparationPersistenceRecord>,
) -> crate::CompletionScmCapturePreparationDiagnosticsRecord {
    let plan_count = records.len();
    let ready_plan_count = records
        .iter()
        .filter(|record| record.plan_status == CompletionScmCapturePlanStatus::Ready)
        .count();
    let unsupported_plan_count = records
        .iter()
        .filter(|record| record.plan_status == CompletionScmCapturePlanStatus::Unsupported)
        .count();
    let repair_required_plan_count = records
        .iter()
        .filter(|record| record.plan_status == CompletionScmCapturePlanStatus::RepairRequired)
        .count();
    let blocker_count = records
        .iter()
        .map(|record| record.plan_blockers.len() + record.blockers.len())
        .sum();

    crate::CompletionScmCapturePreparationDiagnosticsRecord {
        diagnostics_id: "completion-scm-capture-preparation-diagnostics-from-persistence"
            .to_owned(),
        candidate_count: records.len(),
        skipped_admission_count: 0,
        plan_count,
        ready_plan_count,
        unsupported_plan_count,
        repair_required_plan_count,
        blocker_count,
        scm_capture_authority_granted: false,
        scm_publish_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        raw_material_exposed: false,
    }
}

fn persistence_record(
    input: CompletionScmCapturePreparationPersistenceInput,
    persisted_preparation_id: String,
    status: CompletionScmCapturePreparationPersistenceStatus,
    blockers: Vec<CompletionScmCapturePreparationPersistenceBlocker>,
    duplicate_preparation_detected: bool,
) -> CompletionScmCapturePreparationPersistenceRecord {
    CompletionScmCapturePreparationPersistenceRecord {
        persisted_preparation_id,
        plan_item_id: input.plan_item.plan_item_id,
        preparation_candidate_id: input.plan_item.preparation_candidate_id,
        admission_id: input.admission_id,
        readiness_id: input.readiness_id,
        capture_candidate_id: input.capture_candidate_id,
        task_id: input.plan_item.task_id,
        work_item_id: input.plan_item.work_item_id,
        completion_id: input.plan_item.completion_id,
        operator_ref: input.operator_ref,
        evidence_refs: unique_sorted(input.evidence_refs),
        adapter_label: input.plan_item.adapter_label,
        workflow_label: input.plan_item.workflow_label,
        plan_status: input.plan_item.status,
        plan_blockers: input.plan_item.blockers,
        status,
        blockers,
        duplicate_preparation_detected,
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
    input: &CompletionScmCapturePreparationPersistenceInput,
) -> Vec<CompletionScmCapturePreparationPersistenceBlocker> {
    let mut blockers = Vec::new();
    if input.evidence_refs.is_empty() {
        blockers.push(CompletionScmCapturePreparationPersistenceBlocker::MissingEvidenceRef);
    }
    if input.raw_material_present {
        blockers.push(CompletionScmCapturePreparationPersistenceBlocker::RawMaterialPresent);
    }
    if input.scm_capture_requested {
        blockers.push(CompletionScmCapturePreparationPersistenceBlocker::ScmCaptureRequested);
    }
    if input.scm_publish_requested {
        blockers.push(CompletionScmCapturePreparationPersistenceBlocker::ScmPublishRequested);
    }
    if input.forge_change_request_requested {
        blockers
            .push(CompletionScmCapturePreparationPersistenceBlocker::ForgeChangeRequestRequested);
    }
    if input.forge_merge_requested {
        blockers.push(CompletionScmCapturePreparationPersistenceBlocker::ForgeMergeRequested);
    }
    if input.provider_write_requested {
        blockers.push(CompletionScmCapturePreparationPersistenceBlocker::ProviderWriteRequested);
    }
    if input.callback_response_requested {
        blockers.push(CompletionScmCapturePreparationPersistenceBlocker::CallbackResponseRequested);
    }
    if input.interruption_requested {
        blockers.push(CompletionScmCapturePreparationPersistenceBlocker::InterruptionRequested);
    }
    if input.recovery_requested {
        blockers.push(CompletionScmCapturePreparationPersistenceBlocker::RecoveryRequested);
    }
    blockers
}

fn persisted_preparation_id(plan_item_id: &str) -> String {
    format!("{COMPLETION_SCM_CAPTURE_PREPARATION_PREFIX}{plan_item_id}")
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
    fn completion_scm_capture_preparation_persistence_round_trips_sanitized_record() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let db = temp_dir.path().join("nucleus.sqlite");
        let state = ServerStateService::new(SqliteBackend::new(db.clone()));

        let record = persist_completion_scm_capture_preparation(&state, input(plan("1", ready())))
            .expect("persist");

        let reopened = ServerStateService::new(SqliteBackend::new(db));
        let records = read_completion_scm_capture_preparations(&reopened).expect("read");

        assert_eq!(records, vec![record]);
        assert_eq!(records[0].adapter_label, "adapter");
        assert!(!records[0].scm_capture_permitted);
        assert!(!records[0].raw_material_retained);
    }

    #[test]
    fn completion_scm_capture_preparation_state_api_reads_records_in_stable_order() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));

        persist_completion_scm_capture_preparation(&state, input(plan("b", ready())))
            .expect("persist b");
        persist_completion_scm_capture_preparation(&state, input(plan("a", ready())))
            .expect("persist a");

        let records = read_completion_scm_capture_preparations(&state).expect("read");

        assert_eq!(records[0].plan_item_id, "plan:a");
        assert_eq!(records[1].plan_item_id, "plan:b");
    }

    #[test]
    fn completion_scm_capture_preparation_duplicate_repair_preserves_non_ready_states() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));

        let unsupported = persist_completion_scm_capture_preparation(
            &state,
            input(plan("unsupported", unsupported())),
        )
        .expect("persist unsupported");
        let repair =
            persist_completion_scm_capture_preparation(&state, input(plan("repair", repair())))
                .expect("persist repair");
        let duplicate = persist_completion_scm_capture_preparation(
            &state,
            CompletionScmCapturePreparationPersistenceInput {
                existing_preparation_ids: vec![unsupported.persisted_preparation_id.clone()],
                ..input(plan("unsupported", ready()))
            },
        )
        .expect("duplicate");

        assert_eq!(
            unsupported.plan_status,
            CompletionScmCapturePlanStatus::Unsupported
        );
        assert_eq!(
            repair.plan_status,
            CompletionScmCapturePlanStatus::RepairRequired
        );
        assert_eq!(
            duplicate.status,
            CompletionScmCapturePreparationPersistenceStatus::DuplicateNoop
        );
        assert!(duplicate.duplicate_preparation_detected);
    }

    #[test]
    fn completion_scm_capture_preparation_duplicate_repair_blocks_raw_or_external_requests() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
        let mut input = input(plan("blocked", ready()));
        input.raw_material_present = true;
        input.scm_capture_requested = true;
        input.forge_change_request_requested = true;

        let record = persist_completion_scm_capture_preparation(&state, input).expect("blocked");

        assert_eq!(
            record.status,
            CompletionScmCapturePreparationPersistenceStatus::Blocked
        );
        assert!(record
            .blockers
            .contains(&CompletionScmCapturePreparationPersistenceBlocker::RawMaterialPresent));
        assert!(record.blockers.contains(
            &CompletionScmCapturePreparationPersistenceBlocker::ForgeChangeRequestRequested
        ));
        assert!(!record.scm_capture_permitted);
        assert!(!record.raw_material_retained);
    }

    #[test]
    fn completion_scm_capture_preparation_diagnostics_source_summarizes_persisted_records() {
        let diagnostics =
            completion_scm_capture_preparation_diagnostics_from_persisted_records(vec![
                persisted("ready", CompletionScmCapturePlanStatus::Ready, Vec::new()),
                persisted(
                    "unsupported",
                    CompletionScmCapturePlanStatus::Unsupported,
                    vec![CompletionScmCapturePlanBlocker::CaptureUnsupported],
                ),
                persisted(
                    "repair",
                    CompletionScmCapturePlanStatus::RepairRequired,
                    vec![CompletionScmCapturePlanBlocker::AdapterUnavailable],
                ),
            ]);

        assert_eq!(diagnostics.candidate_count, 3);
        assert_eq!(diagnostics.plan_count, 3);
        assert_eq!(diagnostics.ready_plan_count, 1);
        assert_eq!(diagnostics.unsupported_plan_count, 1);
        assert_eq!(diagnostics.repair_required_plan_count, 1);
        assert_eq!(diagnostics.blocker_count, 2);
        assert!(!diagnostics.scm_capture_authority_granted);
    }

    fn input(
        plan_item: CompletionScmCapturePlanItem,
    ) -> CompletionScmCapturePreparationPersistenceInput {
        CompletionScmCapturePreparationPersistenceInput {
            plan_item,
            admission_id: "admission:1".to_owned(),
            readiness_id: "readiness:1".to_owned(),
            capture_candidate_id: "candidate:1".to_owned(),
            operator_ref: "operator:tom".to_owned(),
            evidence_refs: vec!["evidence:prep".to_owned()],
            existing_preparation_ids: Vec::new(),
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

    fn plan(id: &str, status: CompletionScmCapturePlanStatus) -> CompletionScmCapturePlanItem {
        CompletionScmCapturePlanItem {
            plan_item_id: format!("plan:{id}"),
            preparation_candidate_id: format!("prep:{id}"),
            task_id: "task:1".to_owned(),
            work_item_id: Some("work:1".to_owned()),
            completion_id: Some("completion:1".to_owned()),
            adapter_label: "adapter".to_owned(),
            workflow_label: "workflow".to_owned(),
            status: status.clone(),
            blockers: match status {
                CompletionScmCapturePlanStatus::Ready => Vec::new(),
                CompletionScmCapturePlanStatus::Unsupported => {
                    vec![CompletionScmCapturePlanBlocker::CaptureUnsupported]
                }
                CompletionScmCapturePlanStatus::RepairRequired => {
                    vec![CompletionScmCapturePlanBlocker::AdapterUnavailable]
                }
            },
        }
    }

    fn ready() -> CompletionScmCapturePlanStatus {
        CompletionScmCapturePlanStatus::Ready
    }

    fn unsupported() -> CompletionScmCapturePlanStatus {
        CompletionScmCapturePlanStatus::Unsupported
    }

    fn repair() -> CompletionScmCapturePlanStatus {
        CompletionScmCapturePlanStatus::RepairRequired
    }

    fn persisted(
        id: &str,
        plan_status: CompletionScmCapturePlanStatus,
        plan_blockers: Vec<CompletionScmCapturePlanBlocker>,
    ) -> CompletionScmCapturePreparationPersistenceRecord {
        CompletionScmCapturePreparationPersistenceRecord {
            persisted_preparation_id: format!("persisted:{id}"),
            plan_item_id: format!("plan:{id}"),
            preparation_candidate_id: format!("prep:{id}"),
            admission_id: "admission:1".to_owned(),
            readiness_id: "readiness:1".to_owned(),
            capture_candidate_id: "candidate:1".to_owned(),
            task_id: "task:1".to_owned(),
            work_item_id: Some("work:1".to_owned()),
            completion_id: Some("completion:1".to_owned()),
            operator_ref: "operator:tom".to_owned(),
            evidence_refs: vec!["evidence:prep".to_owned()],
            adapter_label: "adapter".to_owned(),
            workflow_label: "workflow".to_owned(),
            plan_status,
            plan_blockers,
            status: CompletionScmCapturePreparationPersistenceStatus::Persisted,
            blockers: Vec::new(),
            duplicate_preparation_detected: false,
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
