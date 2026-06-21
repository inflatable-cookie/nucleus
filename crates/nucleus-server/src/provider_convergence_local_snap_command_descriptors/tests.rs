use super::*;

use crate::{ConvergenceLocalSnapAdmissionBlocker, ConvergenceLocalSnapAdmissionRecord};

#[test]
fn convergence_local_snap_command_descriptors_build_from_admitted_records() {
    let set = convergence_local_snap_command_descriptors(input(vec![admission(
        "ready",
        ConvergenceLocalSnapAdmissionStatus::Admitted,
    )]));

    assert_eq!(
        set.descriptors[0].status,
        ConvergenceLocalSnapCommandDescriptorStatus::Ready
    );
    assert_eq!(
        set.descriptors[0].local_snap_descriptor_ref,
        Some("convergence-local-snap:admission:ready".to_owned())
    );
    assert!(set.skipped_admission_ids.is_empty());
}

#[test]
fn convergence_local_snap_command_descriptors_skip_unready_records() {
    let set = convergence_local_snap_command_descriptors(input(vec![
        admission("blocked", ConvergenceLocalSnapAdmissionStatus::Blocked),
        admission(
            "duplicate",
            ConvergenceLocalSnapAdmissionStatus::DuplicateNoop,
        ),
        admission(
            "unsupported",
            ConvergenceLocalSnapAdmissionStatus::Unsupported,
        ),
    ]));

    assert_eq!(set.skipped_admission_ids.len(), 3);
    assert!(set
        .descriptors
        .iter()
        .any(|record| record.status == ConvergenceLocalSnapCommandDescriptorStatus::Blocked));
    assert!(set
        .descriptors
        .iter()
        .any(|record| record.status == ConvergenceLocalSnapCommandDescriptorStatus::Unsupported));
}

#[test]
fn convergence_local_snap_command_descriptors_preserve_refs_and_authority_refs() {
    let set = convergence_local_snap_command_descriptors(input(vec![admission(
        "refs",
        ConvergenceLocalSnapAdmissionStatus::Admitted,
    )]));
    let descriptor = &set.descriptors[0];

    assert_eq!(descriptor.admission_id, "admission:refs");
    assert_eq!(descriptor.replay_record_id, "replay:refs");
    assert_eq!(descriptor.adapter_record_id, "adapter:refs");
    assert_eq!(descriptor.task_ids, vec!["task:refs"]);
    assert_eq!(descriptor.repo_ids, vec!["repo:refs"]);
    assert_eq!(
        descriptor.source_authority_ref,
        "source-authority:admission:refs"
    );
    assert_eq!(
        descriptor.execution_authority_ref,
        "execution-authority:admission:refs"
    );
}

#[test]
fn convergence_local_snap_command_descriptors_execute_no_effects() {
    let set = convergence_local_snap_command_descriptors(input(vec![admission(
        "effects",
        ConvergenceLocalSnapAdmissionStatus::Admitted,
    )]));
    let descriptor = &set.descriptors[0];

    assert!(!set.executable_argv_built);
    assert!(!set.local_snap_creation_executed);
    assert!(!set.object_upload_permitted);
    assert!(!set.publication_permitted);
    assert!(!set.lane_sync_permitted);
    assert!(!set.provider_write_permitted);
    assert!(!set.task_mutation_permitted);
    assert!(!set.raw_output_retained);
    assert!(!descriptor.executable_argv_built);
    assert!(!descriptor.local_snap_creation_executed);
}

fn input(
    records: Vec<ConvergenceLocalSnapAdmissionRecord>,
) -> ConvergenceLocalSnapCommandDescriptorsInput {
    ConvergenceLocalSnapCommandDescriptorsInput {
        admissions: ConvergenceLocalSnapAdmissionSet {
            admission_set_id: "admission".to_owned(),
            records,
            duplicate_admission_ids: Vec::new(),
            blocked_admission_ids: Vec::new(),
            unsupported_admission_ids: Vec::new(),
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
        },
    }
}

fn admission(
    suffix: &str,
    status: ConvergenceLocalSnapAdmissionStatus,
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
        blockers: vec![ConvergenceLocalSnapAdmissionBlocker::MissingSourceAuthority],
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
