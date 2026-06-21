//! Stopped request records for Convergence-like publication descriptors.

use serde::{Deserialize, Serialize};

use crate::{
    ConvergencePublicationCommandDescriptorRecord, ConvergencePublicationCommandDescriptorSet,
    ConvergencePublicationCommandDescriptorStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConvergencePublicationStoppedRequestsInput {
    pub descriptors: ConvergencePublicationCommandDescriptorSet,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergencePublicationStoppedRequestSet {
    pub request_set_id: String,
    pub requests: Vec<ConvergencePublicationStoppedRequestRecord>,
    pub skipped_descriptor_ids: Vec<String>,
    pub provider_handoff_created: bool,
    pub snapshot_creation_executed: bool,
    pub publish_executed: bool,
    pub publication_review_executed: bool,
    pub provider_write_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergencePublicationStoppedRequestRecord {
    pub request_id: String,
    pub idempotency_key: String,
    pub descriptor_id: String,
    pub preflight_id: String,
    pub admission_id: String,
    pub persisted_projection_id: String,
    pub projection_id: String,
    pub task_ids: Vec<String>,
    pub repo_ids: Vec<String>,
    pub operator_refs: Vec<String>,
    pub snapshot_descriptor_ref: Option<String>,
    pub publish_descriptor_ref: Option<String>,
    pub publication_review_descriptor_ref: Option<String>,
    pub snapshot_stage_refs: Vec<String>,
    pub publish_stage_refs: Vec<String>,
    pub publication_review_stage_refs: Vec<String>,
    pub status: ConvergencePublicationStoppedRequestStatus,
    pub blockers: Vec<ConvergencePublicationStoppedRequestBlocker>,
    pub provider_handoff_created: bool,
    pub snapshot_creation_executed: bool,
    pub publish_executed: bool,
    pub publication_review_executed: bool,
    pub provider_write_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergencePublicationStoppedRequestStatus {
    Stopped,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergencePublicationStoppedRequestBlocker {
    DescriptorNotReady,
}

pub fn convergence_publication_stopped_requests(
    input: ConvergencePublicationStoppedRequestsInput,
) -> ConvergencePublicationStoppedRequestSet {
    let mut requests = input
        .descriptors
        .descriptors
        .into_iter()
        .map(request_record)
        .collect::<Vec<_>>();
    requests.sort_by(|left, right| left.request_id.cmp(&right.request_id));

    ConvergencePublicationStoppedRequestSet {
        request_set_id: "convergence-publication-stopped-requests".to_owned(),
        skipped_descriptor_ids: requests
            .iter()
            .filter(|request| request.status != ConvergencePublicationStoppedRequestStatus::Stopped)
            .map(|request| request.descriptor_id.clone())
            .collect(),
        requests,
        provider_handoff_created: false,
        snapshot_creation_executed: false,
        publish_executed: false,
        publication_review_executed: false,
        provider_write_executed: false,
        task_mutation_executed: false,
        raw_output_retained: false,
    }
}

fn request_record(
    descriptor: ConvergencePublicationCommandDescriptorRecord,
) -> ConvergencePublicationStoppedRequestRecord {
    let blockers = blockers(&descriptor);
    let status = if blockers.is_empty() {
        ConvergencePublicationStoppedRequestStatus::Stopped
    } else {
        ConvergencePublicationStoppedRequestStatus::Blocked
    };

    ConvergencePublicationStoppedRequestRecord {
        request_id: format!(
            "convergence-publication-stopped-request:{}",
            descriptor.descriptor_id
        ),
        idempotency_key: format!(
            "convergence-publication:{}:{}",
            descriptor.persisted_projection_id, descriptor.preflight_id
        ),
        descriptor_id: descriptor.descriptor_id,
        preflight_id: descriptor.preflight_id,
        admission_id: descriptor.admission_id,
        persisted_projection_id: descriptor.persisted_projection_id,
        projection_id: descriptor.projection_id,
        task_ids: descriptor.task_ids,
        repo_ids: descriptor.repo_ids,
        operator_refs: descriptor.operator_refs,
        snapshot_descriptor_ref: descriptor.snapshot_descriptor_ref,
        publish_descriptor_ref: descriptor.publish_descriptor_ref,
        publication_review_descriptor_ref: descriptor.publication_review_descriptor_ref,
        snapshot_stage_refs: descriptor.snapshot_stage_refs,
        publish_stage_refs: descriptor.publish_stage_refs,
        publication_review_stage_refs: descriptor.publication_review_stage_refs,
        status,
        blockers,
        provider_handoff_created: false,
        snapshot_creation_executed: false,
        publish_executed: false,
        publication_review_executed: false,
        provider_write_executed: false,
        task_mutation_executed: false,
        raw_output_retained: false,
    }
}

fn blockers(
    descriptor: &ConvergencePublicationCommandDescriptorRecord,
) -> Vec<ConvergencePublicationStoppedRequestBlocker> {
    if descriptor.status == ConvergencePublicationCommandDescriptorStatus::Ready {
        Vec::new()
    } else {
        vec![ConvergencePublicationStoppedRequestBlocker::DescriptorNotReady]
    }
}

#[cfg(test)]
#[path = "provider_convergence_publication_stopped_requests/tests.rs"]
mod tests;
