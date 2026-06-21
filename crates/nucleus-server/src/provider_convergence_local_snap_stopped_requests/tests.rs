use super::*;

use crate::{
    ConvergenceLocalSnapCommandDescriptorBlocker, ConvergenceLocalSnapCommandDescriptorRecord,
};

#[test]
fn convergence_local_snap_stopped_requests_build_from_ready_descriptors() {
    let set = convergence_local_snap_stopped_requests(input(vec![descriptor(
        "ready",
        ConvergenceLocalSnapCommandDescriptorStatus::Ready,
    )]));

    assert_eq!(
        set.requests[0].status,
        ConvergenceLocalSnapStoppedRequestStatus::Stopped
    );
    assert!(set.skipped_descriptor_ids.is_empty());
}

#[test]
fn convergence_local_snap_stopped_requests_block_unready_descriptors() {
    let set = convergence_local_snap_stopped_requests(input(vec![descriptor(
        "blocked",
        ConvergenceLocalSnapCommandDescriptorStatus::Blocked,
    )]));

    assert_eq!(set.skipped_descriptor_ids.len(), 1);
    assert_eq!(
        set.requests[0].status,
        ConvergenceLocalSnapStoppedRequestStatus::Blocked
    );
}

#[test]
fn convergence_local_snap_stopped_requests_preserve_stable_identity() {
    let set = convergence_local_snap_stopped_requests(input(vec![descriptor(
        "refs",
        ConvergenceLocalSnapCommandDescriptorStatus::Ready,
    )]));
    let request = &set.requests[0];

    assert_eq!(
        request.stopped_request_id,
        "convergence-local-snap-stopped-request:descriptor:refs"
    );
    assert_eq!(
        request.idempotency_key,
        "convergence-local-snap:admission:refs:idempotency:refs"
    );
    assert_eq!(request.admission_id, "admission:refs");
    assert_eq!(request.replay_record_id, "replay:refs");
    assert_eq!(request.task_ids, vec!["task:refs"]);
    assert_eq!(request.repo_ids, vec!["repo:refs"]);
}

#[test]
fn convergence_local_snap_stopped_requests_execute_no_effects() {
    let set = convergence_local_snap_stopped_requests(input(vec![descriptor(
        "effects",
        ConvergenceLocalSnapCommandDescriptorStatus::Ready,
    )]));
    let request = &set.requests[0];

    assert!(!set.executable_argv_built);
    assert!(!set.command_spawned);
    assert!(!set.local_snap_creation_executed);
    assert!(!set.object_upload_permitted);
    assert!(!set.publication_permitted);
    assert!(!set.lane_sync_permitted);
    assert!(!set.provider_write_permitted);
    assert!(!set.task_mutation_permitted);
    assert!(!set.raw_output_retained);
    assert!(!request.executable_argv_built);
    assert!(!request.command_spawned);
    assert!(!request.local_snap_creation_executed);
}

fn input(
    descriptors: Vec<ConvergenceLocalSnapCommandDescriptorRecord>,
) -> ConvergenceLocalSnapStoppedRequestsInput {
    ConvergenceLocalSnapStoppedRequestsInput {
        descriptors: ConvergenceLocalSnapCommandDescriptorSet {
            descriptor_set_id: "descriptors".to_owned(),
            descriptors,
            skipped_admission_ids: Vec::new(),
            executable_argv_built: false,
            local_snap_creation_executed: false,
            object_upload_permitted: false,
            publication_permitted: false,
            lane_sync_permitted: false,
            provider_write_permitted: false,
            task_mutation_permitted: false,
            raw_output_retained: false,
        },
    }
}

fn descriptor(
    suffix: &str,
    status: ConvergenceLocalSnapCommandDescriptorStatus,
) -> ConvergenceLocalSnapCommandDescriptorRecord {
    ConvergenceLocalSnapCommandDescriptorRecord {
        descriptor_id: format!("descriptor:{suffix}"),
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
        source_authority_ref: format!("source-authority:{suffix}"),
        execution_authority_ref: format!("execution-authority:{suffix}"),
        local_snap_descriptor_ref: Some(format!("local-snap:{suffix}")),
        status,
        blockers: vec![ConvergenceLocalSnapCommandDescriptorBlocker::AdmissionNotAdmitted],
        executable_argv_built: false,
        local_snap_creation_executed: false,
        object_upload_permitted: false,
        publication_permitted: false,
        lane_sync_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_output_retained: false,
    }
}
