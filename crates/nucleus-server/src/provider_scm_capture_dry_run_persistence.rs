//! Persistence for SCM capture dry-run planning records.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use serde::{Deserialize, Serialize};

use crate::{
    ScmCaptureDryRunPlanBlocker, ScmCaptureDryRunPlanItem, ScmCaptureDryRunPlanStatus,
    ServerStateService,
};

const SCM_CAPTURE_DRY_RUN_PREFIX: &str = "scm-capture-dry-run:";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmCaptureDryRunPersistenceInput {
    pub plan_item: ScmCaptureDryRunPlanItem,
    pub existing_dry_run_plan_ids: Vec<String>,
    pub raw_material_present: bool,
    pub scm_dry_run_requested: bool,
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
pub struct ScmCaptureDryRunPersistenceRecord {
    pub persisted_dry_run_plan_id: String,
    pub dry_run_plan_item_id: String,
    pub dry_run_candidate_id: String,
    pub persisted_preparation_id: String,
    pub plan_item_id: String,
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
    pub plan_status: ScmCaptureDryRunPlanStatus,
    pub plan_blockers: Vec<ScmCaptureDryRunPlanBlocker>,
    pub status: ScmCaptureDryRunPersistenceStatus,
    pub blockers: Vec<ScmCaptureDryRunPersistenceBlocker>,
    pub duplicate_dry_run_plan_detected: bool,
    pub scm_dry_run_permitted: bool,
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
pub enum ScmCaptureDryRunPersistenceStatus {
    Persisted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmCaptureDryRunPersistenceBlocker {
    MissingEvidenceRef,
    RawMaterialPresent,
    ScmDryRunRequested,
    ScmCaptureRequested,
    ScmPublishRequested,
    ForgeChangeRequestRequested,
    ForgeMergeRequested,
    ProviderWriteRequested,
    CallbackResponseRequested,
    InterruptionRequested,
    RecoveryRequested,
}

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

pub fn scm_capture_dry_run_diagnostics_from_persisted_records(
    records: Vec<ScmCaptureDryRunPersistenceRecord>,
) -> crate::ScmCaptureDryRunDiagnosticsRecord {
    let plan_count = records.len();
    let ready_plan_count = records
        .iter()
        .filter(|record| record.plan_status == ScmCaptureDryRunPlanStatus::Ready)
        .count();
    let unsupported_plan_count = records
        .iter()
        .filter(|record| record.plan_status == ScmCaptureDryRunPlanStatus::Unsupported)
        .count();
    let repair_required_plan_count = records
        .iter()
        .filter(|record| record.plan_status == ScmCaptureDryRunPlanStatus::RepairRequired)
        .count();
    let blocker_count = records
        .iter()
        .map(|record| record.plan_blockers.len() + record.blockers.len())
        .sum();

    crate::ScmCaptureDryRunDiagnosticsRecord {
        diagnostics_id: "scm-capture-dry-run-diagnostics-from-persistence".to_owned(),
        candidate_count: records.len(),
        skipped_preparation_count: 0,
        plan_count,
        ready_plan_count,
        unsupported_plan_count,
        repair_required_plan_count,
        blocker_count,
        scm_dry_run_authority_granted: false,
        scm_capture_authority_granted: false,
        scm_publish_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        raw_material_exposed: false,
    }
}

fn persistence_record(
    input: ScmCaptureDryRunPersistenceInput,
    persisted_dry_run_plan_id: String,
    status: ScmCaptureDryRunPersistenceStatus,
    blockers: Vec<ScmCaptureDryRunPersistenceBlocker>,
    duplicate_dry_run_plan_detected: bool,
) -> ScmCaptureDryRunPersistenceRecord {
    ScmCaptureDryRunPersistenceRecord {
        persisted_dry_run_plan_id,
        dry_run_plan_item_id: input.plan_item.dry_run_plan_item_id,
        dry_run_candidate_id: input.plan_item.dry_run_candidate_id,
        persisted_preparation_id: input.plan_item.persisted_preparation_id,
        plan_item_id: input.plan_item.plan_item_id,
        admission_id: input.plan_item.admission_id,
        readiness_id: input.plan_item.readiness_id,
        capture_candidate_id: input.plan_item.capture_candidate_id,
        task_id: input.plan_item.task_id,
        work_item_id: input.plan_item.work_item_id,
        completion_id: input.plan_item.completion_id,
        operator_ref: input.plan_item.operator_ref,
        evidence_refs: unique_sorted(input.plan_item.evidence_refs),
        adapter_label: input.plan_item.adapter_label,
        workflow_label: input.plan_item.workflow_label,
        plan_status: input.plan_item.status,
        plan_blockers: input.plan_item.blockers,
        status,
        blockers,
        duplicate_dry_run_plan_detected,
        scm_dry_run_permitted: false,
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

fn blockers(input: &ScmCaptureDryRunPersistenceInput) -> Vec<ScmCaptureDryRunPersistenceBlocker> {
    let mut blockers = Vec::new();
    if input.plan_item.evidence_refs.is_empty() {
        blockers.push(ScmCaptureDryRunPersistenceBlocker::MissingEvidenceRef);
    }
    if input.raw_material_present {
        blockers.push(ScmCaptureDryRunPersistenceBlocker::RawMaterialPresent);
    }
    if input.scm_dry_run_requested {
        blockers.push(ScmCaptureDryRunPersistenceBlocker::ScmDryRunRequested);
    }
    if input.scm_capture_requested {
        blockers.push(ScmCaptureDryRunPersistenceBlocker::ScmCaptureRequested);
    }
    if input.scm_publish_requested {
        blockers.push(ScmCaptureDryRunPersistenceBlocker::ScmPublishRequested);
    }
    if input.forge_change_request_requested {
        blockers.push(ScmCaptureDryRunPersistenceBlocker::ForgeChangeRequestRequested);
    }
    if input.forge_merge_requested {
        blockers.push(ScmCaptureDryRunPersistenceBlocker::ForgeMergeRequested);
    }
    if input.provider_write_requested {
        blockers.push(ScmCaptureDryRunPersistenceBlocker::ProviderWriteRequested);
    }
    if input.callback_response_requested {
        blockers.push(ScmCaptureDryRunPersistenceBlocker::CallbackResponseRequested);
    }
    if input.interruption_requested {
        blockers.push(ScmCaptureDryRunPersistenceBlocker::InterruptionRequested);
    }
    if input.recovery_requested {
        blockers.push(ScmCaptureDryRunPersistenceBlocker::RecoveryRequested);
    }
    blockers
}

fn persisted_dry_run_plan_id(plan_item_id: &str) -> String {
    format!("{SCM_CAPTURE_DRY_RUN_PREFIX}{plan_item_id}")
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
    fn scm_capture_dry_run_persistence_records_round_trip_sanitized_record() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let db = temp_dir.path().join("nucleus.sqlite");
        let state = ServerStateService::new(SqliteBackend::new(db.clone()));

        let record =
            persist_scm_capture_dry_run_plan(&state, input(plan("1", ready()))).expect("persist");

        let reopened = ServerStateService::new(SqliteBackend::new(db));
        let records = read_scm_capture_dry_run_plans(&reopened).expect("read");

        assert_eq!(records, vec![record]);
        assert_eq!(records[0].adapter_label, "git");
        assert_eq!(records[0].workflow_label, "working-tree-preview");
        assert!(!records[0].scm_dry_run_permitted);
        assert!(!records[0].scm_capture_permitted);
        assert!(!records[0].raw_material_retained);
    }

    #[test]
    fn scm_capture_dry_run_state_api_reads_records_in_stable_order() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));

        persist_scm_capture_dry_run_plan(&state, input(plan("b", ready()))).expect("persist b");
        persist_scm_capture_dry_run_plan(&state, input(plan("a", ready()))).expect("persist a");

        let records = read_scm_capture_dry_run_plans(&state).expect("read");

        assert_eq!(records[0].dry_run_plan_item_id, "dry-run-plan:a");
        assert_eq!(records[1].dry_run_plan_item_id, "dry-run-plan:b");
    }

    #[test]
    fn scm_capture_dry_run_duplicate_repair_preserves_non_ready_states() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));

        let unsupported =
            persist_scm_capture_dry_run_plan(&state, input(plan("unsupported", unsupported())))
                .expect("persist unsupported");
        let repair = persist_scm_capture_dry_run_plan(&state, input(plan("repair", repair())))
            .expect("persist repair");
        let duplicate = persist_scm_capture_dry_run_plan(
            &state,
            ScmCaptureDryRunPersistenceInput {
                existing_dry_run_plan_ids: vec![unsupported.persisted_dry_run_plan_id.clone()],
                ..input(plan("unsupported", ready()))
            },
        )
        .expect("duplicate");

        assert_eq!(
            unsupported.plan_status,
            ScmCaptureDryRunPlanStatus::Unsupported
        );
        assert_eq!(
            repair.plan_status,
            ScmCaptureDryRunPlanStatus::RepairRequired
        );
        assert_eq!(
            duplicate.status,
            ScmCaptureDryRunPersistenceStatus::DuplicateNoop
        );
        assert!(duplicate.duplicate_dry_run_plan_detected);
    }

    #[test]
    fn scm_capture_dry_run_duplicate_repair_blocks_raw_or_external_requests() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
        let mut input = input(plan("blocked", ready()));
        input.raw_material_present = true;
        input.scm_dry_run_requested = true;
        input.forge_change_request_requested = true;

        let record = persist_scm_capture_dry_run_plan(&state, input).expect("blocked");

        assert_eq!(record.status, ScmCaptureDryRunPersistenceStatus::Blocked);
        assert!(record
            .blockers
            .contains(&ScmCaptureDryRunPersistenceBlocker::RawMaterialPresent));
        assert!(record
            .blockers
            .contains(&ScmCaptureDryRunPersistenceBlocker::ScmDryRunRequested));
        assert!(record
            .blockers
            .contains(&ScmCaptureDryRunPersistenceBlocker::ForgeChangeRequestRequested));
        assert!(!record.scm_dry_run_permitted);
        assert!(!record.raw_material_retained);
    }

    #[test]
    fn scm_capture_dry_run_diagnostics_source_summarizes_persisted_records() {
        let diagnostics = scm_capture_dry_run_diagnostics_from_persisted_records(vec![
            persisted("ready", ScmCaptureDryRunPlanStatus::Ready, Vec::new()),
            persisted(
                "unsupported",
                ScmCaptureDryRunPlanStatus::Unsupported,
                vec![ScmCaptureDryRunPlanBlocker::DryRunUnsupported],
            ),
            persisted(
                "repair",
                ScmCaptureDryRunPlanStatus::RepairRequired,
                vec![ScmCaptureDryRunPlanBlocker::AdapterUnavailable],
            ),
        ]);

        assert_eq!(diagnostics.candidate_count, 3);
        assert_eq!(diagnostics.plan_count, 3);
        assert_eq!(diagnostics.ready_plan_count, 1);
        assert_eq!(diagnostics.unsupported_plan_count, 1);
        assert_eq!(diagnostics.repair_required_plan_count, 1);
        assert_eq!(diagnostics.blocker_count, 2);
        assert!(!diagnostics.scm_dry_run_authority_granted);
        assert!(!diagnostics.raw_material_exposed);
    }

    fn input(plan_item: ScmCaptureDryRunPlanItem) -> ScmCaptureDryRunPersistenceInput {
        ScmCaptureDryRunPersistenceInput {
            plan_item,
            existing_dry_run_plan_ids: Vec::new(),
            raw_material_present: false,
            scm_dry_run_requested: false,
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

    fn plan(id: &str, status: ScmCaptureDryRunPlanStatus) -> ScmCaptureDryRunPlanItem {
        ScmCaptureDryRunPlanItem {
            dry_run_plan_item_id: format!("dry-run-plan:{id}"),
            dry_run_candidate_id: format!("dry-run-candidate:{id}"),
            persisted_preparation_id: format!("persisted-preparation:{id}"),
            plan_item_id: format!("plan:{id}"),
            admission_id: format!("admission:{id}"),
            readiness_id: format!("readiness:{id}"),
            capture_candidate_id: format!("capture:{id}"),
            task_id: "task:1".to_owned(),
            work_item_id: Some("work:1".to_owned()),
            completion_id: Some("completion:1".to_owned()),
            operator_ref: "operator:tom".to_owned(),
            evidence_refs: vec!["evidence:dry-run".to_owned(), "evidence:dry-run".to_owned()],
            adapter_label: "git".to_owned(),
            workflow_label: "working-tree-preview".to_owned(),
            status: status.clone(),
            blockers: match status {
                ScmCaptureDryRunPlanStatus::Ready => Vec::new(),
                ScmCaptureDryRunPlanStatus::Unsupported => {
                    vec![ScmCaptureDryRunPlanBlocker::DryRunUnsupported]
                }
                ScmCaptureDryRunPlanStatus::RepairRequired => {
                    vec![ScmCaptureDryRunPlanBlocker::AdapterUnavailable]
                }
            },
        }
    }

    fn ready() -> ScmCaptureDryRunPlanStatus {
        ScmCaptureDryRunPlanStatus::Ready
    }

    fn unsupported() -> ScmCaptureDryRunPlanStatus {
        ScmCaptureDryRunPlanStatus::Unsupported
    }

    fn repair() -> ScmCaptureDryRunPlanStatus {
        ScmCaptureDryRunPlanStatus::RepairRequired
    }

    fn persisted(
        id: &str,
        plan_status: ScmCaptureDryRunPlanStatus,
        plan_blockers: Vec<ScmCaptureDryRunPlanBlocker>,
    ) -> ScmCaptureDryRunPersistenceRecord {
        ScmCaptureDryRunPersistenceRecord {
            persisted_dry_run_plan_id: format!("persisted:{id}"),
            dry_run_plan_item_id: format!("dry-run-plan:{id}"),
            dry_run_candidate_id: format!("dry-run-candidate:{id}"),
            persisted_preparation_id: format!("persisted-preparation:{id}"),
            plan_item_id: format!("plan:{id}"),
            admission_id: "admission:1".to_owned(),
            readiness_id: "readiness:1".to_owned(),
            capture_candidate_id: "capture:1".to_owned(),
            task_id: "task:1".to_owned(),
            work_item_id: Some("work:1".to_owned()),
            completion_id: Some("completion:1".to_owned()),
            operator_ref: "operator:tom".to_owned(),
            evidence_refs: vec!["evidence:dry-run".to_owned()],
            adapter_label: "adapter".to_owned(),
            workflow_label: "workflow".to_owned(),
            plan_status,
            plan_blockers,
            status: ScmCaptureDryRunPersistenceStatus::Persisted,
            blockers: Vec::new(),
            duplicate_dry_run_plan_detected: false,
            scm_dry_run_permitted: false,
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
