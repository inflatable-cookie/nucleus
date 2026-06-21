use super::*;

use crate::{ConvergenceLocalSnapAdmissionBlocker, ConvergenceLocalSnapAdmissionRecord};

#[test]
fn convergence_local_snap_admission_diagnostics_count_record_states() {
    let diagnostics = convergence_local_snap_admission_diagnostics(input(vec![
        record(
            "admitted",
            ConvergenceLocalSnapAdmissionStatus::Admitted,
            Vec::new(),
        ),
        record(
            "duplicate",
            ConvergenceLocalSnapAdmissionStatus::DuplicateNoop,
            vec![ConvergenceLocalSnapAdmissionBlocker::DuplicateAdmission],
        ),
        record(
            "blocked",
            ConvergenceLocalSnapAdmissionStatus::Blocked,
            vec![ConvergenceLocalSnapAdmissionBlocker::MissingSourceAuthority],
        ),
        record(
            "unsupported",
            ConvergenceLocalSnapAdmissionStatus::Unsupported,
            Vec::new(),
        ),
    ]));

    assert_eq!(diagnostics.record_count, 4);
    assert_eq!(diagnostics.admitted_count, 1);
    assert_eq!(diagnostics.duplicate_count, 1);
    assert_eq!(diagnostics.blocked_count, 1);
    assert_eq!(diagnostics.unsupported_count, 1);
    assert_eq!(diagnostics.blocker_count, 2);
}

#[test]
fn convergence_local_snap_admission_diagnostics_distinguish_local_from_remote_effects() {
    let diagnostics = convergence_local_snap_admission_diagnostics(input(vec![record(
        "admitted",
        ConvergenceLocalSnapAdmissionStatus::Admitted,
        Vec::new(),
    )]));

    assert!(diagnostics.local_snap_creation_admitted);
    assert!(!diagnostics.local_snap_creation_executed);
    assert!(!diagnostics.remote_effect_permitted);
    assert!(!diagnostics.object_upload_permitted);
    assert!(!diagnostics.publication_permitted);
    assert!(!diagnostics.lane_sync_permitted);
    assert!(!diagnostics.bundle_permitted);
    assert!(!diagnostics.approval_permitted);
    assert!(!diagnostics.promotion_permitted);
    assert!(!diagnostics.release_permitted);
    assert!(!diagnostics.resolution_publication_permitted);
    assert!(!diagnostics.provider_write_permitted);
    assert!(!diagnostics.task_mutation_permitted);
    assert!(!diagnostics.raw_material_retained);
}

fn input(records: Vec<ConvergenceLocalSnapAdmissionRecord>) -> ConvergenceLocalSnapAdmissionSet {
    ConvergenceLocalSnapAdmissionSet {
        admission_set_id: "admission".to_owned(),
        local_snap_creation_admitted: records
            .iter()
            .any(|record| record.status == ConvergenceLocalSnapAdmissionStatus::Admitted),
        records,
        duplicate_admission_ids: Vec::new(),
        blocked_admission_ids: Vec::new(),
        unsupported_admission_ids: Vec::new(),
        local_snap_creation_executed: false,
        object_upload_permitted: false,
        publication_permitted: false,
        lane_sync_permitted: false,
        bundle_permitted: false,
        approval_permitted: false,
        promotion_permitted: false,
        release_permitted: false,
        resolution_publication_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_material_retained: false,
    }
}

fn record(
    suffix: &str,
    status: ConvergenceLocalSnapAdmissionStatus,
    blockers: Vec<ConvergenceLocalSnapAdmissionBlocker>,
) -> ConvergenceLocalSnapAdmissionRecord {
    ConvergenceLocalSnapAdmissionRecord {
        admission_id: format!("admission:{suffix}"),
        replay_record_id: format!("replay:{suffix}"),
        adapter_record_id: format!("adapter:{suffix}"),
        persisted_evidence_id: format!("persisted-evidence:{suffix}"),
        evidence_id: format!("evidence:{suffix}"),
        proof_id: format!("proof:{suffix}"),
        persisted_request_id: format!("request:persisted:{suffix}"),
        request_id: format!("request:{suffix}"),
        idempotency_key: format!("idempotency:{suffix}"),
        task_ids: vec![format!("task:{suffix}")],
        repo_ids: vec![format!("repo:{suffix}")],
        status,
        blockers,
        duplicate_admission_detected: false,
        local_snap_creation_admitted: true,
        local_snap_creation_executed: false,
        object_upload_permitted: false,
        publication_permitted: false,
        lane_sync_permitted: false,
        bundle_permitted: false,
        approval_permitted: false,
        promotion_permitted: false,
        release_permitted: false,
        resolution_publication_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_material_retained: false,
    }
}
