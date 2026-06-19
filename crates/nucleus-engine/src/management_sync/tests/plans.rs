use super::*;

#[test]
fn management_projection_sync_plans_separate_export_import_and_capture_prep() {
    let export = ManagementProjectionSyncPlan::export(
        ManagementProjectionSyncPlanId("sync-plan:export".to_owned()),
        vec![ManagementProjectionFileRef::project()],
    );
    let import = ManagementProjectionSyncPlan::import(
        ManagementProjectionSyncPlanId("sync-plan:import".to_owned()),
        vec![ManagementProjectionFileRef::task("task:1")],
    );
    let capture = ManagementProjectionSyncPlan::capture_preparation(
        ManagementProjectionSyncPlanId("sync-plan:capture".to_owned()),
        vec![ManagementProjectionFileRef::task("task:1")],
        vec![EngineRuntimeReceiptRecordId(
            "receipt:projection:1".to_owned(),
        )],
    );

    assert_eq!(export.kind, ManagementProjectionSyncPlanKind::Export);
    assert_eq!(import.kind, ManagementProjectionSyncPlanKind::Import);
    assert_eq!(
        capture.kind,
        ManagementProjectionSyncPlanKind::CapturePreparation
    );
    assert!(export.cites_projection_files());
    assert!(!export.implies_provider_mutation());
    assert!(!import.implies_provider_mutation());
    assert!(!capture.implies_provider_mutation());
}

#[test]
fn management_projection_sync_records_do_not_encode_provider_mutation_terms() {
    let plan = ManagementProjectionSyncPlan::capture_preparation(
        ManagementProjectionSyncPlanId("sync-plan:capture".to_owned()),
        vec![ManagementProjectionFileRef::task("task:1")],
        vec![EngineRuntimeReceiptRecordId(
            "receipt:projection:1".to_owned(),
        )],
    );
    let prep = ManagementProjectionCapturePrepRecord::from_sync_plan(
        ManagementProjectionCapturePrepId("capture-prep:1".to_owned()),
        &plan,
        vec!["sync-assist:1".to_owned()],
    );
    let debug = format!("{plan:?}{prep:?}");

    for forbidden in [
        "commit",
        "push",
        "publication_requested",
        "published",
        "provider credential",
        "raw_stdout",
        "raw_stderr",
    ] {
        assert!(
            !debug.to_lowercase().contains(forbidden),
            "sync records leaked {forbidden}"
        );
    }
}
