use super::*;
use crate::{
    ScmCaptureDryRunPlanBlocker, ScmCaptureDryRunPlanItem, ScmCaptureDryRunPlanStatus,
    ServerStateService,
};
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
