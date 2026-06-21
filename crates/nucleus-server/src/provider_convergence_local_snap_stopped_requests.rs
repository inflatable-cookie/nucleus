//! Stopped request records for Convergence local snap descriptors.

use serde::{Deserialize, Serialize};

use crate::{
    ConvergenceLocalSnapCommandDescriptorRecord, ConvergenceLocalSnapCommandDescriptorSet,
    ConvergenceLocalSnapCommandDescriptorStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConvergenceLocalSnapStoppedRequestsInput {
    pub descriptors: ConvergenceLocalSnapCommandDescriptorSet,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapStoppedRequestSet {
    pub request_set_id: String,
    pub requests: Vec<ConvergenceLocalSnapStoppedRequestRecord>,
    pub skipped_descriptor_ids: Vec<String>,
    pub executable_argv_built: bool,
    pub command_spawned: bool,
    pub local_snap_creation_executed: bool,
    pub object_upload_permitted: bool,
    pub publication_permitted: bool,
    pub lane_sync_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapStoppedRequestRecord {
    pub stopped_request_id: String,
    pub idempotency_key: String,
    pub descriptor_id: String,
    pub admission_id: String,
    pub replay_record_id: String,
    pub adapter_record_id: String,
    pub persisted_evidence_id: String,
    pub evidence_id: String,
    pub proof_id: String,
    pub persisted_request_id: String,
    pub source_request_id: String,
    pub task_ids: Vec<String>,
    pub repo_ids: Vec<String>,
    pub source_authority_ref: String,
    pub execution_authority_ref: String,
    pub local_snap_descriptor_ref: Option<String>,
    pub status: ConvergenceLocalSnapStoppedRequestStatus,
    pub blockers: Vec<ConvergenceLocalSnapStoppedRequestBlocker>,
    pub executable_argv_built: bool,
    pub command_spawned: bool,
    pub local_snap_creation_executed: bool,
    pub object_upload_permitted: bool,
    pub publication_permitted: bool,
    pub lane_sync_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceLocalSnapStoppedRequestStatus {
    Stopped,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceLocalSnapStoppedRequestBlocker {
    DescriptorNotReady,
}

pub fn convergence_local_snap_stopped_requests(
    input: ConvergenceLocalSnapStoppedRequestsInput,
) -> ConvergenceLocalSnapStoppedRequestSet {
    let mut requests = input
        .descriptors
        .descriptors
        .into_iter()
        .map(request_record)
        .collect::<Vec<_>>();
    requests.sort_by(|left, right| left.stopped_request_id.cmp(&right.stopped_request_id));

    ConvergenceLocalSnapStoppedRequestSet {
        request_set_id: "convergence-local-snap-stopped-requests".to_owned(),
        skipped_descriptor_ids: requests
            .iter()
            .filter(|request| request.status != ConvergenceLocalSnapStoppedRequestStatus::Stopped)
            .map(|request| request.descriptor_id.clone())
            .collect(),
        requests,
        executable_argv_built: false,
        command_spawned: false,
        local_snap_creation_executed: false,
        object_upload_permitted: false,
        publication_permitted: false,
        lane_sync_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_output_retained: false,
    }
}

fn request_record(
    descriptor: ConvergenceLocalSnapCommandDescriptorRecord,
) -> ConvergenceLocalSnapStoppedRequestRecord {
    let blockers = blockers(&descriptor);
    let status = if blockers.is_empty() {
        ConvergenceLocalSnapStoppedRequestStatus::Stopped
    } else {
        ConvergenceLocalSnapStoppedRequestStatus::Blocked
    };

    ConvergenceLocalSnapStoppedRequestRecord {
        stopped_request_id: format!(
            "convergence-local-snap-stopped-request:{}",
            descriptor.descriptor_id
        ),
        idempotency_key: format!(
            "convergence-local-snap:{}:{}",
            descriptor.admission_id, descriptor.idempotency_key
        ),
        descriptor_id: descriptor.descriptor_id,
        admission_id: descriptor.admission_id,
        replay_record_id: descriptor.replay_record_id,
        adapter_record_id: descriptor.adapter_record_id,
        persisted_evidence_id: descriptor.persisted_evidence_id,
        evidence_id: descriptor.evidence_id,
        proof_id: descriptor.proof_id,
        persisted_request_id: descriptor.persisted_request_id,
        source_request_id: descriptor.request_id,
        task_ids: descriptor.task_ids,
        repo_ids: descriptor.repo_ids,
        source_authority_ref: descriptor.source_authority_ref,
        execution_authority_ref: descriptor.execution_authority_ref,
        local_snap_descriptor_ref: descriptor.local_snap_descriptor_ref,
        status,
        blockers,
        executable_argv_built: false,
        command_spawned: false,
        local_snap_creation_executed: false,
        object_upload_permitted: false,
        publication_permitted: false,
        lane_sync_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_output_retained: false,
    }
}

fn blockers(
    descriptor: &ConvergenceLocalSnapCommandDescriptorRecord,
) -> Vec<ConvergenceLocalSnapStoppedRequestBlocker> {
    if descriptor.status == ConvergenceLocalSnapCommandDescriptorStatus::Ready {
        Vec::new()
    } else {
        vec![ConvergenceLocalSnapStoppedRequestBlocker::DescriptorNotReady]
    }
}

#[cfg(test)]
#[path = "provider_convergence_local_snap_stopped_requests/tests.rs"]
mod tests;
