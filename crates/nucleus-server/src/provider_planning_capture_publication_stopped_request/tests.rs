use super::*;
use crate::{
    PlanningCapturePublicationAdapterFamily, PlanningCapturePublicationAdmissionBlocker,
    PlanningCapturePublicationAdmissionRecord, PlanningCapturePublicationAdmissionStatus,
    PlanningCapturePublicationOperation,
};
use nucleus_local_store::SqliteBackend;

#[test]
fn planning_capture_publication_stopped_request_round_trips_sanitized_record() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let db = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(db.clone()));

    let record =
        persist_planning_capture_publication_stopped_request(&state, input(admission("1")))
            .expect("persist");

    let reopened = ServerStateService::new(SqliteBackend::new(db));
    let records = read_planning_capture_publication_stopped_requests(&reopened).expect("read");

    assert_eq!(records, vec![record]);
    assert_eq!(
        records[0].adapter_family,
        PlanningCapturePublicationAdapterFamily::SnapshotPublicationLike
    );
    assert_eq!(
        records[0].operation,
        PlanningCapturePublicationOperation::Publish
    );
    assert!(!records[0].command_execution_permitted);
    assert!(!records[0].runner_handoff_permitted);
    assert!(!records[0].publish_permitted);
    assert!(!records[0].raw_payload_retained);
}

#[test]
fn planning_capture_publication_stopped_request_reads_records_in_stable_order() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));

    persist_planning_capture_publication_stopped_request(&state, input(admission("b")))
        .expect("persist b");
    persist_planning_capture_publication_stopped_request(&state, input(admission("a")))
        .expect("persist a");

    let records = read_planning_capture_publication_stopped_requests(&state).expect("read");

    assert!(records[0].request_id.ends_with("admission:a"));
    assert!(records[1].request_id.ends_with("admission:b"));
}

#[test]
fn planning_capture_publication_stopped_request_duplicate_is_noop() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    let input = input(admission("dup"));
    let request_id = "planning-capture-publication-stopped-request:admission:dup".to_owned();

    let duplicate = persist_planning_capture_publication_stopped_request(
        &state,
        PlanningCapturePublicationStoppedRequestInput {
            existing_request_ids: vec![request_id],
            ..input
        },
    )
    .expect("duplicate");

    assert_eq!(
        duplicate.status,
        PlanningCapturePublicationStoppedRequestStatus::DuplicateNoop
    );
    assert!(duplicate.duplicate_request_detected);
}

#[test]
fn planning_capture_publication_stopped_request_blocks_non_admitted_or_effect_requests() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    let blocked_admission = PlanningCapturePublicationAdmissionRecord {
        status: PlanningCapturePublicationAdmissionStatus::Blocked,
        blockers: vec![PlanningCapturePublicationAdmissionBlocker::MissingApprovalRef],
        stopped_request_admitted: false,
        evidence_refs: Vec::new(),
        approval_ref: None,
        ..admission("blocked")
    };
    let mut input = input(blocked_admission);
    input.raw_payload_present = true;
    input.command_execution_requested = true;
    input.runner_handoff_requested = true;
    input.remote_share_requested = true;
    input.forge_mutation_requested = true;
    input.projection_import_requested = true;
    input.task_promotion_requested = true;

    let record =
        persist_planning_capture_publication_stopped_request(&state, input).expect("blocked");

    assert_eq!(
        record.status,
        PlanningCapturePublicationStoppedRequestStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&PlanningCapturePublicationStoppedRequestBlocker::AdmissionNotAdmitted));
    assert!(record
        .blockers
        .contains(&PlanningCapturePublicationStoppedRequestBlocker::StoppedRequestNotAdmitted));
    assert!(record
        .blockers
        .contains(&PlanningCapturePublicationStoppedRequestBlocker::MissingEvidenceRef));
    assert!(record
        .blockers
        .contains(&PlanningCapturePublicationStoppedRequestBlocker::MissingApprovalRef));
    assert!(record
        .blockers
        .contains(&PlanningCapturePublicationStoppedRequestBlocker::CommandExecutionRequested));
    assert!(record
        .blockers
        .contains(&PlanningCapturePublicationStoppedRequestBlocker::RunnerHandoffRequested));
    assert!(record
        .blockers
        .contains(&PlanningCapturePublicationStoppedRequestBlocker::RemoteShareRequested));
    assert!(record
        .blockers
        .contains(&PlanningCapturePublicationStoppedRequestBlocker::ForgeMutationRequested));
    assert!(record
        .blockers
        .contains(&PlanningCapturePublicationStoppedRequestBlocker::ProjectionImportRequested));
    assert!(record
        .blockers
        .contains(&PlanningCapturePublicationStoppedRequestBlocker::TaskPromotionRequested));
    assert!(!record.command_execution_permitted);
    assert!(!record.runner_handoff_permitted);
}

#[test]
fn planning_capture_publication_stopped_request_diagnostics_summarize_records() {
    let diagnostics = planning_capture_publication_stopped_request_diagnostics(vec![
        stopped_record(
            "persisted",
            PlanningCapturePublicationStoppedRequestStatus::Persisted,
        ),
        stopped_record(
            "duplicate",
            PlanningCapturePublicationStoppedRequestStatus::DuplicateNoop,
        ),
        PlanningCapturePublicationStoppedRequestRecord {
            blockers: vec![
                PlanningCapturePublicationStoppedRequestBlocker::MissingEvidenceRef,
                PlanningCapturePublicationStoppedRequestBlocker::RemoteShareRequested,
            ],
            ..stopped_record(
                "blocked",
                PlanningCapturePublicationStoppedRequestStatus::Blocked,
            )
        },
    ]);

    assert_eq!(diagnostics.request_count, 3);
    assert_eq!(diagnostics.persisted_request_count, 1);
    assert_eq!(diagnostics.duplicate_request_count, 1);
    assert_eq!(diagnostics.blocked_request_count, 1);
    assert_eq!(diagnostics.blocker_count, 2);
    assert_eq!(diagnostics.evidence_ref_count, 3);
    assert_eq!(diagnostics.management_file_ref_count, 6);
    assert_eq!(
        diagnostics.adapter_family_buckets,
        vec![PlanningCapturePublicationStoppedRequestDiagnosticBucket {
            label: "snapshot_publication_like".to_owned(),
            count: 3,
        }]
    );
    assert_eq!(
        diagnostics.operation_buckets,
        vec![PlanningCapturePublicationStoppedRequestDiagnosticBucket {
            label: "publish".to_owned(),
            count: 3,
        }]
    );
    assert!(!diagnostics.command_execution_permitted);
    assert!(!diagnostics.runner_handoff_permitted);
    assert!(!diagnostics.publish_permitted);
    assert!(!diagnostics.projection_import_permitted);
    assert!(!diagnostics.task_promotion_permitted);
}

fn input(
    admission: PlanningCapturePublicationAdmissionRecord,
) -> PlanningCapturePublicationStoppedRequestInput {
    PlanningCapturePublicationStoppedRequestInput {
        admission,
        existing_request_ids: Vec::new(),
        raw_payload_present: false,
        command_execution_requested: false,
        runner_handoff_requested: false,
        scm_or_snapshot_mutation_requested: false,
        remote_share_requested: false,
        forge_mutation_requested: false,
        provider_write_requested: false,
        projection_import_requested: false,
        task_promotion_requested: false,
        callback_response_requested: false,
        interruption_requested: false,
        recovery_requested: false,
    }
}

fn admission(id: &str) -> PlanningCapturePublicationAdmissionRecord {
    PlanningCapturePublicationAdmissionRecord {
        admission_id: format!("admission:{id}"),
        preparation_id: format!("prep:{id}"),
        plan_item_id: format!("plan:{id}"),
        task_id: "task:1".to_owned(),
        work_item_id: Some("work:1".to_owned()),
        completion_id: Some("completion:1".to_owned()),
        operator_ref: "operator:tom".to_owned(),
        approval_ref: Some("approval:1".to_owned()),
        evidence_refs: vec!["evidence:planning-write".to_owned()],
        adapter_family: PlanningCapturePublicationAdapterFamily::SnapshotPublicationLike,
        operation: PlanningCapturePublicationOperation::Publish,
        adapter_label: "convergence".to_owned(),
        workflow_label: "planning-management-publication".to_owned(),
        management_file_refs: vec![
            "nucleus/planning/artifact-1.toml".to_owned(),
            "nucleus/planning/task-seeds/seed-1.toml".to_owned(),
        ],
        status: PlanningCapturePublicationAdmissionStatus::Admitted,
        blockers: Vec::new(),
        duplicate_admission_detected: false,
        stopped_request_admitted: true,
        commit_permitted: false,
        snapshot_permitted: false,
        publish_permitted: false,
        push_permitted: false,
        forge_share_permitted: false,
        provider_write_permitted: false,
        projection_import_permitted: false,
        task_promotion_permitted: false,
        callback_response_permitted: false,
        interruption_permitted: false,
        recovery_permitted: false,
        raw_payload_retained: false,
    }
}

fn stopped_record(
    id: &str,
    status: PlanningCapturePublicationStoppedRequestStatus,
) -> PlanningCapturePublicationStoppedRequestRecord {
    PlanningCapturePublicationStoppedRequestRecord {
        request_id: format!("request:{id}"),
        admission_id: format!("admission:{id}"),
        preparation_id: format!("prep:{id}"),
        plan_item_id: format!("plan:{id}"),
        task_id: "task:1".to_owned(),
        work_item_id: Some("work:1".to_owned()),
        completion_id: Some("completion:1".to_owned()),
        operator_ref: "operator:tom".to_owned(),
        approval_ref: Some("approval:1".to_owned()),
        evidence_refs: vec!["evidence:planning-write".to_owned()],
        adapter_family: PlanningCapturePublicationAdapterFamily::SnapshotPublicationLike,
        operation: PlanningCapturePublicationOperation::Publish,
        adapter_label: "convergence".to_owned(),
        workflow_label: "planning-management-publication".to_owned(),
        management_file_refs: vec![
            "nucleus/planning/artifact-1.toml".to_owned(),
            "nucleus/planning/task-seeds/seed-1.toml".to_owned(),
        ],
        status,
        blockers: Vec::new(),
        duplicate_request_detected: false,
        command_execution_permitted: false,
        runner_handoff_permitted: false,
        commit_permitted: false,
        snapshot_permitted: false,
        publish_permitted: false,
        push_permitted: false,
        forge_share_permitted: false,
        provider_write_permitted: false,
        projection_import_permitted: false,
        task_promotion_permitted: false,
        callback_response_permitted: false,
        interruption_permitted: false,
        recovery_permitted: false,
        raw_payload_retained: false,
    }
}
